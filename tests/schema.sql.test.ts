/**
 * Runs supabase/schema.sql against an embedded Postgres (PGlite, in-process, no
 * network, no account) and exercises the functions as the `service_role` role,
 * which is the role the server function's key gets in production.
 *
 * What this proves: the server-side rules themselves.
 * What it does not prove: anything about a real hosted database (its REST
 * layer, its default grants, its network). That needs a rehearsal on the real thing.
 */
import { readFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_PATH, createLocalDatabase } from '../scripts/local-api-server';
import { parseAdminSnapshot, parseEventState, parseReceipt, parseSession } from '../src/storage/parse';
import {
  CONTESTANT_IDS,
  ALICE,
  BEN,
  CHLOE,
  ONE_VOTE,
  STATUS_CASES,
  VOTE_SCENARIOS,
  fullTally,
  requestId,
  scenarioRequestId,
  type Outcome,
} from './fixtures';

type Envelope = { ok: true; data: unknown } | { ok: false; error: string };

let db: PGlite;

async function asOwner(sql: string): Promise<void> {
  await db.exec(`reset role; ${sql}`);
}

/** Calls a function the way the server function's key would: as role `service_role`. */
async function rpc(call: string, params: unknown[] = [], role = 'service_role'): Promise<Envelope> {
  await db.exec(`set role ${role}`);
  try {
    const result = await db.query<{ result: Envelope }>(`select public.${call} as result`, params);
    const row = result.rows[0];
    if (!row) throw new Error(`no row from ${call}`);
    return row.result;
  } finally {
    await db.exec('reset role');
  }
}

/** cast_vote with the three audit arguments the vote API sends. */
const castAudited = (
  key: string,
  contestant: string,
  request: string,
  typed: string,
  normalised: string,
  ip: string,
): Promise<Envelope> =>
  rpc('cast_vote($1::text, $2::text, $3::text, $4::text, $5::text, $6::text)', [
    key,
    contestant,
    request,
    typed,
    normalised,
    ip,
  ]);

const castVote = (key: string, contestant: unknown, request: unknown): Promise<Envelope> =>
  rpc('cast_vote($1::text, $2::text, $3::text)', [key, contestant, request]);

const getSession = (): Promise<Envelope> => rpc('get_session()');

function dataOf(envelope: Envelope): unknown {
  if (!envelope.ok) throw new Error(`expected ok, got error ${envelope.error}`);
  return envelope.data;
}

const errorOf = (envelope: Envelope): string | null => (envelope.ok ? null : envelope.error);

async function configure(settings: string): Promise<void> {
  await asOwner(`update public.event_settings set ${settings} where id = 1`);
}

beforeAll(async () => {
  db = await createLocalDatabase({
    contestants: CONTESTANT_IDS.map((id, index) => ({
      id,
      number: index + 1,
      stageName: `Contestant ${index + 1}`,
    })),
    window: { opensAt: null, closesAt: null, autoOpen: false },
    rules: ONE_VOTE,
  });
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await asOwner(`
    delete from public.vote_audit;
    delete from public.votes;
    delete from public.rate_buckets;
    update public.event_settings
       set admin_status = 'open', opens_at = null, closes_at = null, auto_open = false,
           allow_vote_change = false, public_counts = false,
           admin_failures_per_minute = 100000, purged_at = null
     where id = 1;
  `);
});

describe('schema.sql applies cleanly', () => {
  it('can be run a second time without error or data loss', async () => {
    await castVote(ALICE.voterKey, 'c01', requestId());
    await asOwner(readFileSync(SCHEMA_PATH, 'utf8'));
    expect((await db.query('select 1 from public.votes')).rows).toHaveLength(1);
    expect(errorOf(await castVote(ALICE.voterKey, 'c02', requestId()))).toBe('duplicate_vote');
  });
});

describe('the six cases the brief asks for, enforced in the database', () => {
  it('vote accepted', async () => {
    const receipt = parseReceipt(dataOf(await castVote(ALICE.voterKey, 'c02', requestId())));
    expect(receipt).toMatchObject({ contestantId: 'c02', replaced: false });
  });

  it('duplicate from the same email rejected', async () => {
    await castVote(ALICE.voterKey, 'c02', requestId());
    expect(errorOf(await castVote(ALICE.voterKey, 'c03', requestId()))).toBe('duplicate_vote');
  });

  it('different email accepted', async () => {
    await castVote(ALICE.voterKey, 'c02', requestId());
    expect(errorOf(await castVote(BEN.voterKey, 'c02', requestId()))).toBeNull();
  });

  it('window not open', async () => {
    await configure(`admin_status = 'pending', auto_open = true, opens_at = now() + interval '1 hour'`);
    expect(errorOf(await castVote(ALICE.voterKey, 'c01', requestId()))).toBe('voting_not_open');
  });

  it('window closed', async () => {
    await configure(
      `admin_status = 'pending', auto_open = true, opens_at = now() - interval '2 days', closes_at = now() - interval '1 second'`,
    );
    expect(errorOf(await castVote(ALICE.voterKey, 'c01', requestId()))).toBe('voting_closed');
  });
});

describe('uniqueness scenarios match the TypeScript engine', () => {
  it.each(VOTE_SCENARIOS.map((scenario, index) => ({ ...scenario, index })))(
    '$name',
    async ({ rules, steps, tally, index }) => {
      await configure(
        `allow_vote_change = ${rules.allowVoteChange}, public_counts = true`,
      );

      for (const [stepIndex, step] of steps.entries()) {
        const answer = await castVote(
          step.from.voterKey,
          step.contestant,
          scenarioRequestId(index, step.request),
        );
        const outcome: Outcome = answer.ok
          ? parseReceipt(answer.data).replaced
            ? 'replaced'
            : 'counted'
          : (answer.error as Outcome);
        expect(outcome, `step ${stepIndex + 1}`).toBe(step.expect);
      }

      const session = parseSession(dataOf(await getSession()));
      expect(session.tallies).toEqual(fullTally(tally));
    },
  );
});

describe('voting_status_at matches the TypeScript rule', () => {
  it.each(STATUS_CASES)('$name -> $expected', async (c) => {
    const result = await db.query<{ status: string }>(
      `select public.voting_status_at($1, $2::timestamptz, $3::timestamptz, $4, $5::timestamptz) as status`,
      [c.adminStatus, c.opensAt, c.closesAt, c.autoOpen, c.now.toISOString()],
    );
    expect(result.rows[0]?.status).toBe(c.expected);
  });
});

describe('the public keys cannot reach anything', () => {
  it.each(['event_settings', 'contestants', 'votes', 'rate_buckets', 'vote_audit'])(
    'anon cannot read %s',
    async (table) => {
      await db.exec('set role anon');
      try {
        await expect(db.query(`select * from public.${table}`)).rejects.toThrow(/permission denied/);
      } finally {
        await db.exec('reset role');
      }
    },
  );

  it.each(['anon', 'authenticated'])('%s cannot write a vote or change the settings', async (role) => {
    const attempts = [
      `insert into public.votes (contestant_id, voter_key, request_id) values ('c01', '${ALICE.voterKey}', 'stuffed-vote-0001')`,
      `update public.event_settings set allow_vote_change = true`,
      `delete from public.votes`,
    ];
    for (const sql of attempts) {
      await db.exec(`set role ${role}`);
      try {
        await expect(db.query(sql)).rejects.toThrow(/permission denied/);
      } finally {
        await db.exec('reset role');
      }
    }
  });

  it.each(['anon', 'authenticated'])(
    '%s cannot call the voting functions, so nobody can vote with a made-up voter key',
    async (role) => {
      await expect(
        rpc('cast_vote($1::text, $2::text, $3::text)', [BEN.voterKey, 'c01', requestId()], role),
      ).rejects.toThrow(/permission denied/);
      await expect(rpc('get_session()', [], role)).rejects.toThrow(/permission denied/);
      await expect(rpc('admin_gate()', [], role)).rejects.toThrow(/permission denied/);
      await expect(rpc('admin_failed()', [], role)).rejects.toThrow(/permission denied/);
      await expect(rpc('admin_snapshot()', [], role)).rejects.toThrow(/permission denied/);
      await expect(rpc('admin_audit()', [], role)).rejects.toThrow(/permission denied/);
      await expect(rpc(`admin_set_status('closed')`, [], role)).rejects.toThrow(/permission denied/);
      await expect(rpc('purge_voter_keys()', [], role)).rejects.toThrow(/permission denied/);
    },
  );

  it('the audit table grants nothing to anon, authenticated or PUBLIC, not even through RLS', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const privilege of ['select', 'insert', 'update', 'delete']) {
        const result = await db.query<{ ok: boolean }>(
          `select has_table_privilege($1, 'public.vote_audit', $2) as ok`,
          [role, privilege],
        );
        expect(result.rows[0]?.ok, `${role} ${privilege}`).toBe(false);
      }
    }
    const grants = await db.query(
      `select 1 from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'vote_audit'
          and grantee in ('PUBLIC', 'anon', 'authenticated')`,
    );
    expect(grants.rows).toHaveLength(0);
    const rls = await db.query<{ on: boolean }>(
      `select relrowsecurity as on from pg_class where oid = 'public.vote_audit'::regclass`,
    );
    expect(rls.rows[0]?.on).toBe(true);
  });

  it('even the service role cannot call the internal helpers or the purge', async () => {
    await expect(rpc(`rate_hit('x')`)).rejects.toThrow(/permission denied/);
    await expect(rpc(`rate_count('x')`)).rejects.toThrow(/permission denied/);
    await expect(rpc('tallies_json()')).rejects.toThrow(/permission denied/);
    await expect(rpc('purge_voter_keys()')).rejects.toThrow(/permission denied/);
  });
});

describe('only a keyed hash is ever accepted as a voter key', () => {
  it.each([
    ['a readable email address', 'alice@example.com'],
    ['an empty string', ''],
    ['a short hash', 'abc123'],
    ['upper-case hex', ALICE.voterKey.toUpperCase().replace(/0/g, 'A')],
  ])('refuses %s', async (_name, key) => {
    expect(errorOf(await castVote(key, 'c01', requestId()))).toBe('misconfigured');
  });

  it('refuses a null voter key', async () => {
    expect(errorOf(await rpc(`cast_vote(null::text, 'c01', 'request-0001')`))).toBe('misconfigured');
  });

  it('the table itself refuses a readable email address', async () => {
    await expect(
      db.exec(
        `insert into public.votes (contestant_id, voter_key, request_id) values ('c01', 'alice@example.com', 'request-raw-0001')`,
      ),
    ).rejects.toThrow(/check constraint/);
  });
});

describe('one counted vote per voter is a rule of the table, not only of the function', () => {
  it('refuses a second counted row for the same voter key, however it is written', async () => {
    await castVote(ALICE.voterKey, 'c01', requestId());
    await expect(
      db.exec(
        `insert into public.votes (contestant_id, voter_key, request_id) values ('c02', '${ALICE.voterKey}', 'sneaked-in-0001')`,
      ),
    ).rejects.toThrow(/votes_one_per_voter/);
  });

  it('still allows replaced rows alongside the counted one (for allow_vote_change)', async () => {
    await configure('allow_vote_change = true');
    await castVote(ALICE.voterKey, 'c01', requestId());
    await castVote(ALICE.voterKey, 'c02', requestId());
    await castVote(ALICE.voterKey, 'c03', requestId());
    const rows = await db.query<{ counted: boolean }>(
      'select replaced_at is null as counted from public.votes order by id',
    );
    expect(rows.rows.map((row) => row.counted)).toEqual([false, false, true]);
  });

  // PGlite has one connection, so these queue rather than truly overlap. Real
  // concurrency is covered by the advisory lock plus the unique index above.
  it('four taps sent at once still count once', async () => {
    const answers = await Promise.all(
      ['c01', 'c02', 'c03', 'c04'].map((contestant) => castVote(ALICE.voterKey, contestant, requestId())),
    );
    expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
    expect(answers.filter((answer) => !answer.ok).map(errorOf)).toEqual([
      'duplicate_vote',
      'duplicate_vote',
      'duplicate_vote',
    ]);
  });
});

describe('request ids', () => {
  it.each([null, '', 'short', 'has spaces in it', 'x'.repeat(65)])('refuses %s', async (request) => {
    expect(errorOf(await castVote(ALICE.voterKey, 'c01', request))).toBe('invalid_vote');
  });

  it('answers a retry with the original receipt even after voting has closed', async () => {
    const id = requestId();
    const first = parseReceipt(dataOf(await castVote(ALICE.voterKey, 'c01', id)));
    await configure(`admin_status = 'closed'`);
    const retry = parseReceipt(dataOf(await castVote(ALICE.voterKey, 'c01', id)));
    expect(retry.castAt).toBe(first.castAt);
    expect(retry.session.state.status).toBe('closed');
  });
});

describe('the voting window, enforced in the database', () => {
  it('opens and closes by itself on the schedule', async () => {
    await configure(
      `admin_status = 'pending', auto_open = true, opens_at = now() - interval '1 minute', closes_at = now() + interval '1 hour'`,
    );
    expect(errorOf(await castVote(ALICE.voterKey, 'c01', requestId()))).toBeNull();
  });

  it('an admin can pause and resume inside the window', async () => {
    dataOf(await rpc(`admin_set_status('closed')`));
    expect(errorOf(await castVote(ALICE.voterKey, 'c01', requestId()))).toBe('voting_closed');
    const state = parseEventState(dataOf(await rpc(`admin_set_status('open')`)));
    expect(state.status).toBe('open');
    expect(errorOf(await castVote(ALICE.voterKey, 'c01', requestId()))).toBeNull();
  });

  it('an admin cannot open voting before the window starts', async () => {
    await configure(`opens_at = now() + interval '1 hour'`);
    const state = parseEventState(dataOf(await rpc(`admin_set_status('open')`)));
    expect(state).toMatchObject({ status: 'not_open', adminStatus: 'open' });
    expect(errorOf(await castVote(ALICE.voterKey, 'c01', requestId()))).toBe('voting_not_open');
  });

  it('an admin cannot hold voting open past the closing time', async () => {
    await configure(`closes_at = now() - interval '1 second'`);
    const state = parseEventState(dataOf(await rpc(`admin_set_status('open')`)));
    expect(state).toMatchObject({ status: 'closed', adminStatus: 'open' });
    expect(errorOf(await castVote(ALICE.voterKey, 'c01', requestId()))).toBe('voting_closed');
  });

  it('keeps the votes that were in when voting closes', async () => {
    await castVote(ALICE.voterKey, 'c01', requestId());
    dataOf(await rpc(`admin_set_status('closed')`));
    const snapshot = parseAdminSnapshot(dataOf(await rpc('admin_snapshot()')));
    expect(snapshot.votes).toHaveLength(1);
    expect(snapshot.state.status).toBe('closed');
  });

  it('rejects a status the app does not know', async () => {
    expect(errorOf(await rpc(`admin_set_status('paused')`))).toBe('misconfigured');
    expect(errorOf(await rpc(`admin_set_status(null)`))).toBe('misconfigured');
  });
});

describe('what the public page is told', () => {
  beforeEach(async () => {
    await castVote(ALICE.voterKey, 'c04', requestId());
  });

  it('carries no counts while public counts are off', async () => {
    const raw = dataOf(await getSession());
    expect(parseSession(raw).tallies).toBeNull();
    expect(JSON.stringify(raw)).not.toContain('c04');
  });

  it('carries counts when public counts are on', async () => {
    await configure('public_counts = true');
    expect(parseSession(dataOf(await getSession())).tallies).toEqual(
      fullTally({ c04: 1 }),
    );
  });

  it('says nothing about any voter, and never echoes a key', async () => {
    const raw = dataOf(await getSession());
    expect(Object.keys(parseSession(raw)).sort()).toEqual(['state', 'tallies']);
    expect(JSON.stringify(raw)).not.toContain('c04');
    expect(JSON.stringify(raw)).not.toContain(ALICE.voterKey);
  });
});

describe('the admin snapshot', () => {
  it('lists every vote oldest first, replaced ones included, with a short voter reference', async () => {
    await configure('allow_vote_change = true');
    await castVote(ALICE.voterKey, 'c01', requestId());
    await castVote(BEN.voterKey, 'c02', requestId());
    await castVote(ALICE.voterKey, 'c03', requestId());

    const raw = dataOf(await rpc('admin_snapshot()'));
    const snapshot = parseAdminSnapshot(raw);
    expect(snapshot.votes.map((vote) => [vote.contestantId, vote.replacedAt !== null])).toEqual([
      ['c01', true],
      ['c02', false],
      ['c03', false],
    ]);
    expect(snapshot.votes[0]?.voterRef).toBe(ALICE.voterKey.slice(0, 12));
    expect(JSON.stringify(raw)).not.toContain(ALICE.voterKey);
  });
});

describe('the admin passcode throttle', () => {
  // A minute boundary can fall in the middle of a test and start a fresh bucket.
  // Sending more than twice the limit guarantees one bucket overflows regardless.

  it('opens the gate until wrong passcodes pass the limit, then shuts it', async () => {
    await configure('admin_failures_per_minute = 2');
    const answers: (string | null)[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      answers.push(errorOf(await rpc('admin_gate()')));
      await rpc('admin_failed()');
    }
    expect(answers[0]).toBeNull();
    expect(answers).toContain('rate_limited');
  });

  it('asking the gate does not count against it', async () => {
    await configure('admin_failures_per_minute = 1');
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(errorOf(await rpc('admin_gate()'))).toBeNull();
    }
  });

  it('records nothing about who guessed: one fixed bucket name, no caller data', async () => {
    await rpc('admin_failed()');
    await rpc('admin_failed()');
    const buckets = await db.query<{ bucket: string }>('select distinct bucket from public.rate_buckets');
    expect(buckets.rows.map((row) => row.bucket)).toEqual(['admin-fail']);
  });

  it('voting has no throttle at all, so one busy network is never turned away', async () => {
    for (let person = 0; person < 40; person += 1) {
      const key = `${person.toString(16).padStart(2, '0')}${'b'.repeat(62)}`;
      expect(errorOf(await castVote(key, 'c01', requestId())), `voter ${person}`).toBeNull();
    }
  });
});

describe('the audit table', () => {
  const rows = async () =>
    (await db.query<{ email_typed: string; email_normalised: string; ip: string }>(
      'select email_typed, email_normalised, ip from public.vote_audit order by vote_id',
    )).rows;

  it('records typed email, normalised email and IP for a counted vote', async () => {
    await castAudited(ALICE.voterKey, 'c01', requestId(), 'Alice@Example.com', 'alice@example.com', '203.0.113.7');
    expect(await rows()).toEqual([
      { email_typed: 'Alice@Example.com', email_normalised: 'alice@example.com', ip: '203.0.113.7' },
    ]);
  });

  it.each(['not-an-ip', "203.0.113.7'; drop table votes; --", '203.0.113.7 ', 'x'.repeat(60), ''])(
    'still counts the vote when the IP is %j, and records it as empty',
    async (ip) => {
      expect(errorOf(await castAudited(ALICE.voterKey, 'c01', requestId(), 'a@example.com', 'a@example.com', ip))).toBeNull();
      expect((await rows()).map((row) => row.ip)).toEqual(['']);
    },
  );

  it('clips an absurdly long typed value instead of refusing the vote', async () => {
    const long = `${'a'.repeat(400)}@example.com`;
    expect(errorOf(await castAudited(ALICE.voterKey, 'c01', requestId(), long, long, '203.0.113.7'))).toBeNull();
    expect((await rows())[0]?.email_typed).toHaveLength(320);
  });

  it('a call without the audit arguments still counts the vote (defaults), with an empty record', async () => {
    expect(errorOf(await castVote(ALICE.voterKey, 'c01', requestId()))).toBeNull();
    expect(await rows()).toEqual([{ email_typed: '', email_normalised: '', ip: '' }]);
  });

  it('records nothing for a refused duplicate or a retry', async () => {
    const id = requestId();
    await castAudited(ALICE.voterKey, 'c01', id, 'a@example.com', 'a@example.com', '203.0.113.7');
    await castAudited(ALICE.voterKey, 'c01', id, 'a@example.com', 'a@example.com', '203.0.113.7');
    await castAudited(ALICE.voterKey, 'c02', requestId(), 'A@example.com', 'a@example.com', '198.51.100.1');
    expect(await rows()).toHaveLength(1);
  });

  it('emptying it leaves every vote and the tally untouched', async () => {
    await configure('public_counts = true');
    await castAudited(ALICE.voterKey, 'c01', requestId(), 'a@example.com', 'a@example.com', '203.0.113.7');
    await castAudited(BEN.voterKey, 'c01', requestId(), 'b@example.com', 'b@example.com', '203.0.113.7');
    await db.exec('delete from public.vote_audit');
    expect(parseSession(dataOf(await getSession())).tallies).toEqual(fullTally({ c01: 2 }));
    expect(errorOf(await castAudited(ALICE.voterKey, 'c02', requestId(), 'a@example.com', 'a@example.com', ''))).toBe(
      'duplicate_vote',
    );
  });
});

describe('retention: purge_voter_keys', () => {
  it('refuses to run while voting is open', async () => {
    await castVote(ALICE.voterKey, 'c01', requestId());
    await expect(db.query('select public.purge_voter_keys()')).rejects.toThrow(/not closed/);
    const kept = await db.query('select 1 from public.votes where voter_key is not null');
    expect(kept.rows).toHaveLength(1);
  });

  it('wipes every hash, request id, email and IP, and keeps the votes, timestamps and tally', async () => {
    await configure('public_counts = true');
    await castAudited(ALICE.voterKey, 'c01', requestId(), 'a@example.com', 'a@example.com', '203.0.113.7');
    await castAudited(BEN.voterKey, 'c01', requestId(), 'b@example.com', 'b@example.com', '203.0.113.7');
    await castAudited(CHLOE.voterKey, 'c03', requestId(), 'c@example.com', 'c@example.com', '');
    expect((await db.query('select 1 from public.vote_audit')).rows).toHaveLength(3);
    dataOf(await rpc(`admin_set_status('closed')`));

    const purge = await db.query<{ cleared: number }>('select public.purge_voter_keys() as cleared');
    expect(purge.rows[0]?.cleared).toBe(3);

    const left = await db.query(
      `select 1 from public.votes where voter_key is not null or request_id is not null
       union all select 1 from public.rate_buckets
       union all select 1 from public.vote_audit`,
    );
    expect(left.rows).toHaveLength(0);

    const snapshot = parseAdminSnapshot(dataOf(await rpc('admin_snapshot()')));
    expect(snapshot.votes.map((vote) => [vote.contestantId, vote.voterRef])).toEqual([
      ['c01', ''],
      ['c01', ''],
      ['c03', ''],
    ]);
    expect(parseSession(dataOf(await getSession())).tallies).toEqual(
      fullTally({ c01: 2, c03: 1 }),
    );
  });

  it('voting cannot be reopened after a purge, because duplicates could no longer be caught', async () => {
    await castVote(ALICE.voterKey, 'c01', requestId());
    dataOf(await rpc(`admin_set_status('closed')`));
    await db.query('select public.purge_voter_keys()');

    expect(errorOf(await rpc(`admin_set_status('open')`))).toBe('voting_closed');
    expect(errorOf(await castVote(ALICE.voterKey, 'c02', requestId()))).toBe('voting_closed');
  });
});
