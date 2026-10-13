-- Top 20 public vote: schema and server-side rules.
--
-- Run once in the SQL editor of the project's Postgres (Supabase, or any
-- Postgres 14+ that has `anon`, `authenticated` and `service_role` roles).
-- Safe to re-run: it never drops data. (It drops and recreates one FUNCTION,
-- cast_vote, whose argument list changed in Revision 5. No table is dropped.)
--
-- Security model
--   * The browser never talks to this database. It talks to the vote API
--     (server/handler.ts), which turns the voter's email address into a keyed
--     hash and calls the functions below with the SECRET service key. The
--     public (anon) key can do nothing here at all.
--   * Every table has row level security ON and NO policies, and all table
--     privileges are revoked from the public API roles.
--   * The functions enforce the rules: the voting window and one vote per
--     voter. They answer {"ok": true, "data": ...} or
--     {"ok": false, "error": code} instead of raising, so the caller gets a
--     stable error code.
--   * Uniqueness uses `voter_key`, an HMAC-SHA256 of the email made by the
--     vote API with a secret that is not in this database.
--   * AUDIT DATA (Revision 5, Kelicia's decision of 2026-09-29): the readable
--     email (as typed and normalised) and the IP address reported by the
--     platform are kept in a SEPARATE table, `vote_audit`, readable only
--     through admin_audit() with the service key. The tally never reads it and
--     stays intact if it is emptied. The IP is recorded, never enforced:
--     nothing here limits votes by IP, and an empty IP never rejects a vote.
--     purge_voter_keys() deletes it.
--
-- These rules mirror src/domain/voting.ts and src/domain/engine.ts.
-- tests/schema.sql.test.ts runs this file against an embedded Postgres.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.event_settings (
  id                       smallint    primary key default 1 check (id = 1),
  admin_status             text        not null default 'pending'
                                       check (admin_status in ('pending', 'open', 'closed')),
  opens_at                 timestamptz,
  closes_at                timestamptz,
  auto_open                boolean     not null default true,
  allow_vote_change        boolean     not null default false,
  public_counts            boolean     not null default false,
  -- Wrong admin passcodes tolerated per minute, from everyone put together.
  -- Counted for the whole site, not per caller: nothing about a caller is kept.
  admin_failures_per_minute integer    not null default 20
                                       check (admin_failures_per_minute > 0),
  -- Set by purge_voter_keys(). Once set, voting can never be reopened.
  purged_at                timestamptz,
  updated_at               timestamptz not null default now()
);

insert into public.event_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.contestants (
  id         text primary key,
  number     integer not null,
  stage_name text    not null,
  sort_order integer not null default 0
);

create table if not exists public.votes (
  id            bigint      generated always as identity primary key,
  contestant_id text        not null references public.contestants (id),
  -- HMAC-SHA256 of the voter's email address, hex. Null after purge_voter_keys().
  voter_key     text        check (voter_key is null or voter_key ~ '^[0-9a-f]{64}$'),
  -- Random id the browser made up for this vote, so a retry is not counted twice.
  request_id    text        unique
                            check (request_id is null or request_id ~ '^[A-Za-z0-9-]{8,64}$'),
  cast_at       timestamptz not null default now(),
  -- Set when a later vote from the same voter replaced this one. Not counted.
  replaced_at   timestamptz
);

-- One counted vote per voter, guaranteed by the table itself and not only by
-- the function that writes to it.
create unique index if not exists votes_one_per_voter
  on public.votes (voter_key) where replaced_at is null;
create index if not exists votes_contestant_idx
  on public.votes (contestant_id) where replaced_at is null;

-- Counters for the admin passcode throttle. `bucket` is a fixed word
-- ('admin-fail'), never anything derived from a caller.
create table if not exists public.rate_buckets (
  bucket       text        not null,
  window_start timestamptz not null,
  hits         integer     not null default 0,
  primary key (bucket, window_start)
);

-- AUDIT: who typed what, from where. One row per counted vote attempt that was
-- inserted. Server-only. Deleting every row here changes no tally.
create table if not exists public.vote_audit (
  vote_id          bigint      primary key references public.votes (id) on delete cascade,
  -- As the voter typed it, trimmed.
  email_typed      text        not null check (char_length(email_typed) <= 320),
  -- The form the uniqueness check used (lower-cased; Gmail dots and +tags folded).
  email_normalised text        not null check (char_length(email_normalised) <= 320),
  -- As reported by the hosting platform. '' when it reported nothing usable.
  ip               text        not null default ''
                                check (ip = '' or ip ~ '^[0-9a-f.:]{2,45}$'),
  recorded_at      timestamptz not null default now()
);

alter table public.event_settings enable row level security;
alter table public.contestants    enable row level security;
alter table public.votes          enable row level security;
alter table public.rate_buckets   enable row level security;
alter table public.vote_audit     enable row level security;

revoke all on public.event_settings from anon, authenticated;
revoke all on public.contestants    from anon, authenticated;
revoke all on public.votes          from anon, authenticated;
revoke all on public.rate_buckets   from anon, authenticated;
revoke all on public.vote_audit     from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Internal helpers (not callable through the API)
-- ---------------------------------------------------------------------------

create or replace function public.voting_status_at(
  p_admin_status text,
  p_opens_at     timestamptz,
  p_closes_at    timestamptz,
  p_auto_open    boolean,
  p_now          timestamptz
) returns text
language sql immutable
as $$
  select case
    when p_admin_status = 'closed'                         then 'closed'
    when p_closes_at is not null and p_now >= p_closes_at  then 'closed'
    when p_opens_at  is not null and p_now <  p_opens_at   then 'not_open'
    when p_admin_status = 'open'                           then 'open'
    when p_auto_open and p_opens_at is not null            then 'open'
    else 'not_open'
  end
$$;

create or replace function public.current_voting_status() returns text
language sql stable security definer set search_path = public, pg_temp
as $$
  select case
    when purged_at is not null then 'closed'
    else public.voting_status_at(admin_status, opens_at, closes_at, auto_open, now())
  end
  from public.event_settings where id = 1
$$;

create or replace function public.valid_voter_key(p_voter_key text) returns boolean
language sql immutable
as $$
  select p_voter_key is not null and p_voter_key ~ '^[0-9a-f]{64}$'
$$;

create or replace function public.fail(p_code text) returns jsonb
language sql immutable
as $$
  select jsonb_build_object('ok', false, 'error', p_code)
$$;

-- Adds one to this minute's count for a bucket, and tidies away old minutes.
create or replace function public.rate_hit(p_bucket text) returns integer
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_hits integer;
begin
  delete from public.rate_buckets where window_start < now() - interval '10 minutes';

  insert into public.rate_buckets (bucket, window_start, hits)
  values (p_bucket, date_trunc('minute', now()), 1)
  on conflict (bucket, window_start)
  do update set hits = public.rate_buckets.hits + 1
  returning hits into v_hits;

  return v_hits;
end
$$;

create or replace function public.rate_count(p_bucket text) returns integer
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(
    (select hits from public.rate_buckets
      where bucket = p_bucket and window_start = date_trunc('minute', now())),
    0
  )
$$;

create or replace function public.event_state_json() returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'status',          public.current_voting_status(),
    'adminStatus',     admin_status,
    'opensAt',         opens_at,
    'closesAt',        closes_at,
    'allowVoteChange', allow_vote_change,
    'publicCounts',    public_counts,
    'serverTime',      now()
  )
  from public.event_settings where id = 1
$$;

create or replace function public.tallies_json() returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object('contestantId', c.id, 'votes', coalesce(s.votes, 0))
      order by c.sort_order, c.number, c.id
    ),
    '[]'::jsonb
  )
  from public.contestants c
  left join (
    select contestant_id, count(*)::integer as votes
    from public.votes where replaced_at is null group by contestant_id
  ) s on s.contestant_id = c.id
$$;

-- What anyone may know. Nothing in it is about any one voter: the page cannot
-- ask "has this email voted?" without casting a vote, so it cannot be used to
-- check whether somebody else has taken part.
create or replace function public.session_json() returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'state', public.event_state_json(),
    -- Hidden means absent: per-contestant counts never leave the database.
    'tallies', case when s.public_counts then public.tallies_json() else null end
  )
  from public.event_settings s where s.id = 1
$$;

create or replace function public.receipt_json(
  p_vote_id  bigint,
  p_replaced boolean
) returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'contestantId', v.contestant_id,
    'castAt',       v.cast_at,
    'replaced',     p_replaced,
    'session',      public.session_json()
  ))
  from public.votes v where v.id = p_vote_id
$$;

-- ---------------------------------------------------------------------------
-- API: voters. Called by the vote API only, with the service key.
-- ---------------------------------------------------------------------------

create or replace function public.get_session() returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object('ok', true, 'data', public.session_json())
$$;

-- The argument list grew in Revision 5. Replace the old three-argument version
-- rather than leaving two overloads side by side.
drop function if exists public.cast_vote(text, text, text);

create or replace function public.cast_vote(
  p_voter_key        text,
  p_contestant_id    text,
  p_request_id       text,
  -- AUDIT ONLY. None of these three can make a vote fail.
  p_email_typed      text default '',
  p_email_normalised text default '',
  p_ip               text default ''
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_settings public.event_settings%rowtype;
  v_status   text;
  v_same     public.votes%rowtype;
  v_previous public.votes%rowtype;
  v_new_id   bigint;
  v_replaced boolean := false;
  v_constraint text;
begin
  if not public.valid_voter_key(p_voter_key) then
    return public.fail('misconfigured');
  end if;

  select * into v_settings from public.event_settings where id = 1;

  if p_request_id is null or p_request_id !~ '^[A-Za-z0-9-]{8,64}$' then
    return public.fail('invalid_vote');
  end if;

  -- One vote at a time per voter, so two taps cannot both slip under the limit.
  perform pg_advisory_xact_lock(hashtextextended(p_voter_key, 0));

  -- A retry of a vote that was already counted (the reply got lost on the way
  -- back) is answered with the original receipt, even if voting has closed since.
  select * into v_same from public.votes where request_id = p_request_id;
  if found and v_same.voter_key = p_voter_key then
    return public.receipt_json(v_same.id, false);
  end if;

  v_status := public.current_voting_status();
  if v_status = 'not_open' then
    return public.fail('voting_not_open');
  elsif v_status = 'closed' then
    return public.fail('voting_closed');
  end if;

  if p_contestant_id is null
     or not exists (select 1 from public.contestants where id = p_contestant_id) then
    return public.fail('invalid_vote');
  end if;

  if v_same.id is not null then
    -- Same request id from a different voter: not a retry, and not acceptable.
    return public.fail('invalid_vote');
  end if;

  select * into v_previous
    from public.votes
   where voter_key = p_voter_key and replaced_at is null
   order by cast_at desc, id desc
   limit 1;

  if found then
    if not v_settings.allow_vote_change then
      return public.fail('duplicate_vote');
    end if;

    -- Choosing the same contestant again changes nothing.
    if v_previous.contestant_id = p_contestant_id then
      return public.receipt_json(v_previous.id, false);
    end if;

    update public.votes set replaced_at = now() where id = v_previous.id;
    v_replaced := true;
  end if;

  begin
    insert into public.votes (contestant_id, voter_key, request_id)
    values (p_contestant_id, p_voter_key, p_request_id)
    returning id into v_new_id;
  exception when unique_violation then
    -- The lock above means this should not happen. If it does, the table's own
    -- rule has held, and the caller gets the same answer as any other repeat.
    get stacked diagnostics v_constraint = constraint_name;
    return public.fail(case when v_constraint = 'votes_one_per_voter'
                            then 'duplicate_vote' else 'invalid_vote' end);
  end;

  -- The audit record. Values are clipped and an address that does not look like
  -- one is stored as '', so nothing here can stop the vote above being counted.
  insert into public.vote_audit (vote_id, email_typed, email_normalised, ip)
  values (
    v_new_id,
    left(coalesce(p_email_typed, ''), 320),
    left(coalesce(p_email_normalised, ''), 320),
    case when coalesce(p_ip, '') ~ '^[0-9a-f.:]{2,45}$' then p_ip else '' end
  );

  return public.receipt_json(v_new_id, v_replaced);
end
$$;

-- ---------------------------------------------------------------------------
-- API: admin. The vote API checks the passcode before calling these.
-- ---------------------------------------------------------------------------

-- Passcode throttle. The vote API asks admin_gate() before it looks at a
-- passcode, and calls admin_failed() each time one is wrong. Once this minute's
-- wrong guesses pass the limit, every admin call is refused until the minute
-- ends, right passcode or not: answering the right one would tell a guesser
-- they had found it.
--
-- The count is for the whole site. It records that a wrong passcode was
-- tried, and nothing about who tried it.
create or replace function public.admin_gate() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if public.rate_count('admin-fail')
       >= (select admin_failures_per_minute from public.event_settings where id = 1) then
    return public.fail('rate_limited');
  end if;
  return jsonb_build_object('ok', true, 'data', true);
end
$$;

create or replace function public.admin_failed() returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform public.rate_hit('admin-fail');
  return jsonb_build_object('ok', true, 'data', true);
end
$$;

create or replace function public.admin_snapshot() returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'state',   public.event_state_json(),
    'takenAt', now(),
    'votes',   coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',           v.id,
          'contestantId', v.contestant_id,
          'castAt',       v.cast_at,
          'replacedAt',   v.replaced_at,
          'voterRef',     left(v.voter_key, 12)
        )
        order by v.cast_at, v.id
      )
      from public.votes v
    ), '[]'::jsonb),
    -- For the "many votes from one network" flag. Groups of votes that share an
    -- IP address, WITHOUT the address: a count and the contestants involved.
    'sharedAddresses', coalesce((
      select jsonb_agg(g.grp order by (g.grp ->> 'votes')::integer desc)
      from (
        select jsonb_build_object(
                 'votes', count(*)::integer,
                 'contestants', (
                   select jsonb_agg(jsonb_build_object('contestantId', c.contestant_id, 'votes', c.n)
                                    order by c.n desc, c.contestant_id)
                   from (
                     select v2.contestant_id, count(*)::integer as n
                     from public.votes v2 join public.vote_audit a2 on a2.vote_id = v2.id
                     where a2.ip = a.ip
                     group by v2.contestant_id
                   ) c
                 )
               ) as grp
        from public.vote_audit a
        where a.ip <> ''
        group by a.ip
        having count(*) >= 2
      ) g
    ), '[]'::jsonb)
  ))
$$;

-- CONFIDENTIAL. Every vote with its audit record: readable email and IP.
-- Service key only, and the vote API asks for the admin passcode first. A vote
-- whose audit row is gone (emptied, or purged) still appears, with blanks.
create or replace function public.admin_audit() returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object('ok', true, 'data', coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'voteId',          v.id,
        'contestantId',    v.contestant_id,
        'castAt',          v.cast_at,
        'replacedAt',      v.replaced_at,
        'emailTyped',      coalesce(a.email_typed, ''),
        'emailNormalised', coalesce(a.email_normalised, ''),
        'ip',              coalesce(a.ip, ''),
        'ipSource',        case when a.vote_id is null then 'not kept'
                                when a.ip = '' then 'not reported'
                                else 'platform' end,
        'votesFromIp',     case when coalesce(a.ip, '') = '' then 0
                                else (select count(*)::integer from public.vote_audit a3 where a3.ip = a.ip) end
      )
      order by v.cast_at, v.id
    )
    from public.votes v
    left join public.vote_audit a on a.vote_id = v.id
  ), '[]'::jsonb))
$$;

create or replace function public.admin_set_status(p_status text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if p_status is null or p_status not in ('pending', 'open', 'closed') then
    return public.fail('misconfigured');
  end if;
  if (select purged_at is not null from public.event_settings where id = 1) then
    return public.fail('voting_closed');
  end if;
  update public.event_settings set admin_status = p_status, updated_at = now() where id = 1;
  return jsonb_build_object('ok', true, 'data', public.event_state_json());
end
$$;

-- ---------------------------------------------------------------------------
-- Retention. Run by hand from the SQL editor once the Top 10 tally is signed off:
--
--     select public.purge_voter_keys();
--
-- Wipes every email hash, request id and throttle counter, and deletes every
-- AUDIT record (readable emails and IP addresses). The votes, their
-- timestamps and the tally stay. It cannot be undone, and voting cannot be
-- reopened afterwards, because duplicates could no longer be detected.
-- ---------------------------------------------------------------------------

create or replace function public.purge_voter_keys() returns integer
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_cleared integer;
begin
  if public.current_voting_status() <> 'closed' then
    raise exception 'Voting is not closed. Close voting before purging voter keys.';
  end if;

  update public.votes
     set voter_key = null, request_id = null
   where voter_key is not null or request_id is not null;
  get diagnostics v_cleared = row_count;

  delete from public.rate_buckets;
  delete from public.vote_audit;
  update public.event_settings
     set purged_at = coalesce(purged_at, now()), admin_status = 'closed', updated_at = now()
   where id = 1;

  return v_cleared;
end
$$;

-- ---------------------------------------------------------------------------
-- Privileges: nothing for the public roles, the API functions for the service role
-- ---------------------------------------------------------------------------

revoke execute on function
  public.voting_status_at(text, timestamptz, timestamptz, boolean, timestamptz),
  public.current_voting_status(),
  public.valid_voter_key(text),
  public.fail(text),
  public.rate_hit(text),
  public.rate_count(text),
  public.event_state_json(),
  public.tallies_json(),
  public.session_json(),
  public.receipt_json(bigint, boolean),
  public.get_session(),
  public.cast_vote(text, text, text, text, text, text),
  public.admin_gate(),
  public.admin_failed(),
  public.admin_snapshot(),
  public.admin_audit(),
  public.admin_set_status(text),
  public.purge_voter_keys()
from public, anon, authenticated;

grant execute on function
  public.get_session(),
  public.cast_vote(text, text, text, text, text, text),
  public.admin_gate(),
  public.admin_failed(),
  public.admin_snapshot(),
  public.admin_audit(),
  public.admin_set_status(text)
to service_role;
