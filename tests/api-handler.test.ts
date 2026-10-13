/**
 * The vote API end to end: real handler, real email identity resolver, real
 * schema.sql in an embedded Postgres. Only the hosting platform is missing.
 *
 * Email addresses are at example.com and friends, reserved for documentation.
 */
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalDatabase, createPgliteDatabase } from '../scripts/local-api-server';
import type { Database } from '../server/database';
import {
  createApiHandler,
  parseAllowedOrigins,
  type ApiHandler,
  type ApiHandlerOptions,
} from '../server/handler';
import { createEmailIdentityResolver } from '../server/identity';
import { parseAdminSnapshot, parseAudit, parseReceipt, parseSession } from '../src/storage/parse';
import { CONTESTANT_IDS, ONE_VOTE, requestId } from './fixtures';

const SECRET = 'handler-test-secret-at-least-32-chars';
const PASSCODE = 'a-long-admin-passcode';
const ALICE = 'alice.tan@example.com';
const BEN = 'ben.lim@example.org';

type Envelope = { ok: boolean; data?: unknown; error?: string };

let db: PGlite;
let database: Database;
let handler: ApiHandler;

function makeHandler(overrides: Partial<ApiHandlerOptions> = {}): ApiHandler {
  return createApiHandler({
    database,
    identity: createEmailIdentityResolver({ secret: SECRET, eventId: 'handler-test' }),
    adminPasscode: PASSCODE,
    ...overrides,
  });
}

interface CallOptions {
  email?: unknown;
  /** What the platform adapter reports as the caller's IP address. */
  ip?: string | null;
  headers?: Record<string, string>;
  method?: string;
  rawBody?: string;
  using?: ApiHandler;
}

async function call(
  path: string,
  body: unknown = {},
  options: CallOptions = {},
): Promise<{ status: number; body: Envelope }> {
  const method = options.method ?? 'POST';
  const request = new Request(`https://vote.example.com/api/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: method === 'POST' ? (options.rawBody ?? JSON.stringify(body)) : undefined,
  });
  const response = await (options.using ?? handler)(request, { clientIp: options.ip });
  return { status: response.status, body: (await response.json()) as Envelope };
}

const vote = (contestantId: unknown, options: CallOptions = {}) =>
  call(
    'vote',
    { contestantId, email: options.email === undefined ? ALICE : options.email, requestId: requestId() },
    options,
  );

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
  database = createPgliteDatabase(db);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterAll(async () => {
  await db.close();
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await db.exec(`
    delete from public.vote_audit;
    delete from public.votes;
    delete from public.rate_buckets;
    update public.event_settings
       set admin_status = 'open', opens_at = null, closes_at = null, auto_open = false,
           allow_vote_change = false, public_counts = false,
           admin_failures_per_minute = 100000, purged_at = null
     where id = 1;
  `);
  handler = makeHandler();
});

describe('one vote per email address', () => {
  it('accepts a vote', async () => {
    const { status, body } = await vote('c02');
    expect(status).toBe(200);
    expect(parseReceipt(body.data)).toMatchObject({ contestantId: 'c02', replaced: false });
  });

  it('rejects a second vote from the same email', async () => {
    await vote('c02');
    expect((await vote('c03')).body).toEqual({ ok: false, error: 'duplicate_vote' });
  });

  it('accepts a vote from a different email', async () => {
    await vote('c02', { email: ALICE });
    expect((await vote('c02', { email: BEN })).body.ok).toBe(true);
  });

  it.each([
    ['upper case and spaces', '  ALICE.TAN@Example.com '],
    ['Gmail dots', 'a.l.i.c.e.t.a.n@gmail.com'],
    ['Gmail plus-addressing', 'alicetan+again@gmail.com'],
    ['googlemail.com', 'alice.tan@googlemail.com'],
  ])('sees through %s: still the same voter', async (_name, typed) => {
    const first = typed.includes('mail.com') ? 'alicetan@gmail.com' : ALICE;
    await vote('c01', { email: first });
    expect((await vote('c02', { email: typed })).body.error).toBe('duplicate_vote');
  });

  it('does not treat "+tag" as the same inbox outside Gmail', async () => {
    await vote('c01', { email: 'alice@example.com' });
    expect((await vote('c01', { email: 'alice+2@example.com' })).body.ok).toBe(true);
  });

  it.each([
    ['no email', undefined],
    ['an empty email', ''],
    ['no @', 'alice.example.com'],
    ['no domain ending', 'alice@example'],
    ['two addresses', 'alice@example.com, ben@example.com'],
    ['a number', 12345],
    ['a list', [ALICE]],
    ['a Gmail tag with no mailbox', '+tag@gmail.com'],
  ])('refuses %s with invalid_email, and stores nothing', async (_name, email) => {
    const body = { contestantId: 'c01', requestId: requestId(), ...(email === undefined ? {} : { email }) };
    expect((await call('vote', body)).body).toEqual({ ok: false, error: 'invalid_email' });
    expect((await db.query('select 1 from public.votes')).rows).toHaveLength(0);
  });

  it('rejects a vote before the window opens', async () => {
    await db.exec(`update public.event_settings set opens_at = now() + interval '1 hour' where id = 1`);
    expect((await vote('c01')).body.error).toBe('voting_not_open');
  });

  it('rejects a vote after the window closes', async () => {
    await db.exec(`update public.event_settings set closes_at = now() - interval '1 second' where id = 1`);
    expect((await vote('c01')).body.error).toBe('voting_closed');
  });

  it('a retry with the same request id gets the same receipt, not a rejection', async () => {
    const id = requestId();
    const first = await call('vote', { contestantId: 'c01', email: ALICE, requestId: id });
    const retry = await call('vote', { contestantId: 'c01', email: ALICE, requestId: id });
    expect(retry.body.ok).toBe(true);
    expect(parseReceipt(retry.body.data).castAt).toBe(parseReceipt(first.body.data).castAt);
    const rows = await db.query('select 1 from public.votes');
    expect(rows.rows).toHaveLength(1);
  });

  it('the public session says nothing about any voter', async () => {
    await vote('c04');
    const { body } = await call('session');
    expect(Object.keys(parseSession(body.data)).sort()).toEqual(['state', 'tallies']);
    expect(JSON.stringify(body)).not.toContain('c04');
  });
});

const audit = async (): Promise<{ email_typed: string; email_normalised: string; ip: string }[]> =>
  (
    await db.query<{ email_typed: string; email_normalised: string; ip: string }>(
      'select email_typed, email_normalised, ip from public.vote_audit order by vote_id',
    )
  ).rows;

const OFFICE = '203.0.113.7';

describe('the IP address is recorded, never enforced: people on one wifi each get their vote', () => {
  it('accepts different people on the same network', async () => {
    for (const email of [ALICE, BEN, 'chloe@example.net']) {
      expect((await vote('c01', { email, ip: OFFICE })).body.ok).toBe(true);
    }
  });

  it('a busy shared network is never throttled: 60 people from one address all get their vote', async () => {
    for (let person = 1; person <= 60; person += 1) {
      const { body } = await vote('c01', { email: `person${person}@example.com`, ip: OFFICE });
      expect(body.ok, `person ${person}`).toBe(true);
    }
    expect((await db.query('select 1 from public.votes')).rows).toHaveLength(60);
    expect(new Set((await audit()).map((row) => row.ip))).toEqual(new Set([OFFICE]));
  });

  it('changing network does not give an email a second vote', async () => {
    await vote('c01', { ip: OFFICE });
    const second = await vote('c02', { ip: '198.51.100.23' });
    expect(second.body.error).toBe('duplicate_vote');
  });

  it.each([null, undefined, '', 'unknown', '203.0.113.7, 192.0.2.1', '999.1.1.1', 'x'.repeat(100)])(
    'counts the vote when the platform reports %j, and records an empty IP',
    async (ip) => {
      expect((await vote('c01', { ip })).body.ok).toBe(true);
      expect((await audit()).map((row) => row.ip)).toEqual(['']);
    },
  );

  it('records an IPv4 address wrapped in IPv6 as the plain IPv4 address', async () => {
    await vote('c01', { ip: '::ffff:203.0.113.7' });
    await vote('c01', { email: BEN, ip: '2001:DB8::1' });
    expect((await audit()).map((row) => row.ip)).toEqual(['203.0.113.7', '2001:db8::1']);
  });

  it('ignores any voter key or IP smuggled into the body or headers', async () => {
    await vote('c01', { ip: OFFICE });
    const second = await call(
      'vote',
      {
        contestantId: 'c02',
        email: BEN,
        requestId: requestId(),
        voterKey: 'f'.repeat(64),
        p_voter_key: 'f'.repeat(64),
        ip: '192.0.2.99',
        p_ip: '192.0.2.99',
      },
      { ip: OFFICE, headers: { 'X-Forwarded-For': '192.0.2.99' } },
    );
    expect(second.body.ok).toBe(true);
    expect((await audit()).map((row) => row.ip)).toEqual([OFFICE, OFFICE]);
  });
});

describe('the audit record: readable email and IP, in one separate table only', () => {
  it('keeps the email as typed (trimmed) and as counted, and the IP, for each counted vote', async () => {
    await vote('c01', { email: '  Jane.Doe+vote@Gmail.com ', ip: OFFICE });
    await vote('c02', { email: 'janedoe@gmail.com', ip: '198.51.100.23' }); // a refused repeat
    expect(await audit()).toEqual([
      { email_typed: 'Jane.Doe+vote@Gmail.com', email_normalised: 'janedoe@gmail.com', ip: OFFICE },
    ]);
  });

  it('keeps no audit row for a refused vote or a retry', async () => {
    const id = requestId();
    await call('vote', { contestantId: 'c01', email: ALICE, requestId: id }, { ip: OFFICE });
    await call('vote', { contestantId: 'c01', email: ALICE, requestId: id }, { ip: OFFICE });
    await vote('c02', { ip: OFFICE });
    await vote('c02', { email: 'not-an-email', ip: OFFICE });
    expect(await audit()).toHaveLength(1);
  });

  it('holds no readable email or IP anywhere else in the database', async () => {
    const addresses = [ALICE, BEN, 'Chloe.Ng+contest@Gmail.com', 'dev@example.net'];
    for (const [index, email] of addresses.entries()) {
      await call('session', {}, { ip: `198.51.100.${index + 1}` });
      await vote('c01', { email, ip: `198.51.100.${index + 1}` });
      await vote('c02', { email, ip: `198.51.100.${index + 1}` }); // a refused repeat
      await call('admin/snapshot', { passcode: 'wrong-guess' }, { ip: `198.51.100.${index + 1}` });
    }

    const elsewhere = JSON.stringify([
      (await db.query('select * from public.votes')).rows,
      (await db.query('select * from public.rate_buckets')).rows,
      (await db.query('select * from public.event_settings')).rows,
    ]).toLowerCase();
    for (const fragment of ['alice', 'ben.lim', 'chloe', 'dev@', 'example', 'gmail', '@', '198.51.100']) {
      expect(elsewhere, `found "${fragment}" outside the audit table`).not.toContain(fragment);
    }
    const keys = await db.query<{ voter_key: string }>('select voter_key from public.votes');
    for (const row of keys.rows) expect(row.voter_key).toMatch(/^[0-9a-f]{64}$/);
    expect(await audit()).toHaveLength(4);
  });

  it('never sends an email, IP or hash back in a public answer (session, vote, refusals)', async () => {
    const answers = [
      await vote('c01', { ip: OFFICE }),
      await vote('c02', { ip: OFFICE }),
      await vote('c02', { email: 'Not An Email', ip: OFFICE }),
      await call('session', {}, { ip: OFFICE }),
    ];
    const stored = await db.query<{ voter_key: string }>('select voter_key from public.votes');
    const text = JSON.stringify(answers).toLowerCase();
    expect(text).not.toContain(stored.rows[0]?.voter_key ?? 'missing');
    for (const fragment of ['alice', 'example', '@', OFFICE, 'not an email']) expect(text).not.toContain(fragment);
  });

  it('the admin snapshot (behind the vote log and tally exports) holds no email or IP', async () => {
    await vote('c01', { ip: OFFICE });
    await vote('c02', { email: BEN, ip: OFFICE });
    const { body } = await call('admin/snapshot', { passcode: PASSCODE });
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/alice|ben\.lim|@|203\.0\.113/);
    // The shared-network flag gets a count and the contestants, not the address.
    expect(parseAdminSnapshot(body.data).sharedAddresses).toEqual([
      { votes: 2, contestants: [{ contestantId: 'c01', votes: 1 }, { contestantId: 'c02', votes: 1 }] },
    ]);
  });

  it('never writes an email or IP to the server log, even when something fails', async () => {
    const logged = vi.mocked(console.error);
    logged.mockClear();
    const broken = makeHandler({
      database: {
        rpc: async () => {
          throw new Error('connection reset');
        },
      },
    });
    await vote('c01', { using: broken, ip: OFFICE });
    await vote('c01', { email: 'not-an-email', ip: OFFICE });
    await call('admin/audit', { passcode: PASSCODE }, { using: broken, ip: OFFICE });
    expect(logged).toHaveBeenCalled();
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/alice|not-an-email|203\.0\.113/);
  });

  it('the tally survives the audit table being emptied', async () => {
    await vote('c01', { ip: OFFICE });
    await vote('c01', { email: BEN, ip: OFFICE });
    await db.exec('delete from public.vote_audit');
    const snapshot = parseAdminSnapshot((await call('admin/snapshot', { passcode: PASSCODE })).body.data);
    expect(snapshot.votes).toHaveLength(2);
    const rows = parseAudit((await call('admin/audit', { passcode: PASSCODE })).body.data);
    expect(rows.map((row) => [row.emailTyped, row.ip, row.ipSource])).toEqual([
      ['', '', 'not kept'],
      ['', '', 'not kept'],
    ]);
  });

  it('a different secret gives different hashes for the same address', async () => {
    await vote('c01');
    const other = makeHandler({
      identity: createEmailIdentityResolver({
        secret: 'a-second-event-secret-32-chars-long!',
        eventId: 'handler-test',
      }),
    });
    // Same address, but to this handler it is a voter that has not voted.
    expect((await vote('c01', { using: other })).body.ok).toBe(true);
  });
});

describe('admin/audit: the confidential export', () => {
  it('returns every vote with the emails and IP, and how many votes share that IP', async () => {
    await vote('c01', { email: ' Alice.Tan@Example.com ', ip: OFFICE });
    await vote('c02', { email: BEN, ip: OFFICE });
    await vote('c02', { email: 'chloe@example.net' });
    const { body } = await call('admin/audit', { passcode: PASSCODE });
    const rows = parseAudit(body.data);
    expect(rows.map((row) => [row.contestantId, row.emailTyped, row.emailNormalised, row.ip, row.ipSource, row.votesFromIp])).toEqual([
      ['c01', 'Alice.Tan@Example.com', 'alice.tan@example.com', OFFICE, 'platform', 2],
      ['c02', BEN, BEN, OFFICE, 'platform', 2],
      ['c02', 'chloe@example.net', 'chloe@example.net', '', 'not reported', 0],
    ]);
  });

  it.each(['', 'wrong-passcode', PASSCODE.slice(0, -1)])('needs the passcode (refuses "%s")', async (passcode) => {
    await vote('c01', { ip: OFFICE });
    const { body } = await call('admin/audit', { passcode });
    expect(body).toEqual({ ok: false, error: 'bad_passcode' });
    expect(JSON.stringify(body)).not.toMatch(/alice|203\.0\.113/);
  });
});

describe('admin', () => {
  it('returns the snapshot for the right passcode', async () => {
    await vote('c03');
    const { body } = await call('admin/snapshot', { passcode: PASSCODE });
    const snapshot = parseAdminSnapshot(body.data);
    expect(snapshot.votes.map((row) => row.contestantId)).toEqual(['c03']);
    expect(snapshot.votes[0]?.voterRef).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(body)).not.toContain('alice');
  });

  it.each([
    ['a wrong passcode', 'not-the-passcode'],
    ['an empty passcode', ''],
    ['a prefix of the passcode', PASSCODE.slice(0, -1)],
    ['the passcode with extra text', `${PASSCODE}x`],
    ['different case', PASSCODE.toUpperCase()],
  ])('refuses %s', async (_name, passcode) => {
    expect((await call('admin/snapshot', { passcode })).body).toEqual({
      ok: false,
      error: 'bad_passcode',
    });
    expect((await call('admin/status', { passcode, status: 'closed' })).body.error).toBe(
      'bad_passcode',
    );
    const settings = await db.query<{ admin_status: string }>(
      'select admin_status from public.event_settings',
    );
    expect(settings.rows[0]?.admin_status).toBe('open');
  });

  it('refuses a passcode that is missing or is not text', async () => {
    expect((await call('admin/snapshot', {})).body.error).toBe('bad_passcode');
    expect((await call('admin/snapshot', { passcode: 12345 })).body.error).toBe('bad_passcode');
    expect((await call('admin/snapshot', { passcode: [PASSCODE] })).body.error).toBe('bad_passcode');
  });

  it('closes and reopens voting', async () => {
    expect((await call('admin/status', { passcode: PASSCODE, status: 'closed' })).body.ok).toBe(true);
    expect((await vote('c01')).body.error).toBe('voting_closed');
    expect((await call('admin/status', { passcode: PASSCODE, status: 'open' })).body.ok).toBe(true);
    expect((await vote('c01')).body.ok).toBe(true);
  });

  it.each(['', 'short', 'elevenchars'])(
    'is switched off entirely when the configured passcode is weak ("%s")',
    async (adminPasscode) => {
      const weak = makeHandler({ adminPasscode });
      const { body } = await call('admin/snapshot', { passcode: adminPasscode }, { using: weak });
      expect(body).toEqual({ ok: false, error: 'misconfigured' });
    },
  );

  it('throttles passcode guesses', async () => {
    await db.exec('update public.event_settings set admin_failures_per_minute = 3 where id = 1');
    const answers: (string | undefined)[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      answers.push((await call('admin/snapshot', { passcode: `guess-number-${attempt}` })).body.error);
    }
    expect(answers[0]).toBe('bad_passcode');
    expect(answers).toContain('rate_limited');
  });

  it('once throttled, even the right passcode has to wait', async () => {
    await db.exec('update public.event_settings set admin_failures_per_minute = 2 where id = 1');
    await call('admin/snapshot', { passcode: 'guess-1' });
    await call('admin/snapshot', { passcode: 'guess-2' });
    expect((await call('admin/snapshot', { passcode: PASSCODE })).body.error).toBe('rate_limited');
  });

  it('right passcodes are not counted: the organiser is never locked out by their own use', async () => {
    await db.exec('update public.event_settings set admin_failures_per_minute = 2 where id = 1');
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await call('admin/snapshot', { passcode: PASSCODE })).body.ok).toBe(true);
    }
  });

  it('the passcode throttle never touches voting', async () => {
    await db.exec('update public.event_settings set admin_failures_per_minute = 1 where id = 1');
    await call('admin/snapshot', { passcode: 'guess-1' });
    await call('admin/snapshot', { passcode: 'guess-2' });
    expect((await vote('c01')).body.ok).toBe(true);
  });
});

describe('requests that are not valid votes', () => {
  it.each([
    ['an unknown contestant', { contestantId: 'c99', email: ALICE, requestId: 'request-0001' }],
    ['a contestant that is not text', { contestantId: 3, email: ALICE, requestId: 'request-0001' }],
    ['no contestant', { email: ALICE, requestId: 'request-0001' }],
    ['no request id', { contestantId: 'c01', email: ALICE }],
    ['a malformed request id', { contestantId: 'c01', email: ALICE, requestId: 'no' }],
    [
      'an attempt at SQL',
      { contestantId: "c01'; delete from votes; --", email: ALICE, requestId: 'request-0001' },
    ],
  ])('refuses %s', async (_name, body) => {
    expect((await call('vote', body)).body).toEqual({ ok: false, error: 'invalid_vote' });
    const rows = await db.query('select 1 from public.votes');
    expect(rows.rows).toHaveLength(0);
  });

  it.each(['not json', '[1, 2, 3]', '"text"', 'null'])('refuses a body of %s', async (rawBody) => {
    expect((await call('vote', null, { rawBody })).body).toEqual({ ok: false, error: 'invalid_vote' });
  });

  it('refuses an oversized body', async () => {
    const { status } = await call('vote', null, {
      rawBody: JSON.stringify({
        contestantId: 'c01',
        email: ALICE,
        requestId: 'request-0001',
        padding: 'x'.repeat(5000),
      }),
    });
    expect(status).toBe(413);
  });

  it('answers 405 to anything but POST', async () => {
    expect((await call('session', {}, { method: 'GET' })).status).toBe(405);
  });

  it('answers 404 outside the API', async () => {
    expect((await call('unknown-route')).status).toBe(404);
    expect((await call('admin')).status).toBe(404);
    // The IP-era diagnose route is gone along with everything else about addresses.
    expect((await call('admin/diagnose', { passcode: PASSCODE })).status).toBe(404);
  });
});

describe('cross-origin access (the page on GitHub Pages, the API elsewhere)', () => {
  const SITE = 'https://youtrip-marketing.github.io';
  const guarded = (): ApiHandler => makeHandler({ allowedOrigins: [SITE] });

  async function preflight(origin: string, using: ApiHandler): Promise<Response> {
    const request = new Request('https://project.supabase.co/functions/v1/vote-api/vote', {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    return using(request);
  }

  async function post(origin: string | null, using: ApiHandler): Promise<Response> {
    const request = new Request('https://project.supabase.co/functions/v1/vote-api/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(origin === null ? {} : { Origin: origin }) },
      body: JSON.stringify({ contestantId: 'c01', email: ALICE, requestId: requestId() }),
    });
    return using(request);
  }

  it('answers the preflight for the configured site, naming that site and nothing wider', async () => {
    const response = await preflight(SITE, guarded());
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(SITE);
    expect(response.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
    expect(response.headers.get('access-control-allow-headers')).toBe('content-type, accept');
    expect(response.headers.get('vary')).toBe('Origin');
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('lets the configured site vote, and tells the browser it may read the answer', async () => {
    const response = await post(SITE, guarded());
    expect(response.headers.get('access-control-allow-origin')).toBe(SITE);
    expect(((await response.json()) as Envelope).ok).toBe(true);
  });

  it.each([
    'https://evil.example',
    'https://youtrip-marketing.github.io.evil.example',
    'https://evil-youtrip-marketing.github.io',
    'http://youtrip-marketing.github.io',
    'https://youtrip-marketing.github.io:8443',
    'https://YOUTRIP-MARKETING.github.io.',
    'null',
  ])('refuses %s: no permission header, no vote', async (origin) => {
    const asked = await preflight(origin, guarded());
    expect(asked.status).toBe(403);
    expect(asked.headers.get('access-control-allow-origin')).toBeNull();

    const sent = await post(origin, guarded());
    expect(sent.status).toBe(403);
    expect(sent.headers.get('access-control-allow-origin')).toBeNull();
    expect((await db.query('select 1 from public.votes')).rows).toHaveLength(0);
  });

  it('never answers with a wildcard, whatever is asked', async () => {
    for (const origin of [SITE, 'https://evil.example', '*']) {
      const asked = await preflight(origin, guarded());
      expect(asked.headers.get('access-control-allow-origin')).not.toBe('*');
    }
  });

  it('refuses to be configured with a wildcard', () => {
    expect(() => makeHandler({ allowedOrigins: ['*'] })).toThrow(/wildcard/);
  });

  it('allows several sites, and answers each with its own origin only', async () => {
    const custom = 'https://vote.example.com';
    const both = makeHandler({ allowedOrigins: [SITE, custom] });
    expect((await preflight(SITE, both)).headers.get('access-control-allow-origin')).toBe(SITE);
    expect((await preflight(custom, both)).headers.get('access-control-allow-origin')).toBe(custom);
  });

  it('with no sites configured, grants no cross-origin permission at all', async () => {
    const closed = makeHandler({ allowedOrigins: [] });
    expect((await preflight(SITE, closed)).status).toBe(403);
    expect((await post(SITE, closed)).status).toBe(403);
  });

  it('still serves a page on the API’s own site', async () => {
    // A same-site deployment (the Netlify alternative): the browser sends the site's own origin.
    const { body } = await vote('c01', {
      using: makeHandler({ allowedOrigins: [] }),
      headers: { Origin: 'https://vote.example.com' },
    });
    expect(body.ok).toBe(true);
  });

  it('being on the list is not a way round the voting rules', async () => {
    await post(SITE, guarded());
    const second = await post(SITE, guarded());
    expect(((await second.json()) as Envelope).error).toBe('duplicate_vote');
  });

  it('permits only the two plain headers, and nothing to do with addresses', async () => {
    expect((await preflight(SITE, guarded())).headers.get('access-control-allow-headers')).toBe(
      'content-type, accept',
    );
  });
});

describe('ALLOWED_ORIGINS', () => {
  it('reads a comma-separated list', () => {
    expect(
      parseAllowedOrigins(' https://youtrip-marketing.github.io , https://vote.example.com,'),
    ).toEqual(['https://youtrip-marketing.github.io', 'https://vote.example.com']);
  });

  it('is empty when unset', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins('  ')).toEqual([]);
  });

  it('accepts localhost over http, for rehearsals', () => {
    expect(parseAllowedOrigins('http://localhost:5173')).toEqual(['http://localhost:5173']);
  });

  it.each([
    ['a wildcard', '*'],
    ['a wildcard subdomain', 'https://*.github.io'],
    ['an origin with a path', 'https://youtrip-marketing.github.io/imc4-vote'],
    ['an origin with a trailing slash', 'https://youtrip-marketing.github.io/'],
    ['plain http', 'http://vote.example.com'],
    ['a bare host name', 'youtrip-marketing.github.io'],
    ['one bad entry among good ones', 'https://vote.example.com, *'],
  ])('refuses %s', (_name, value) => {
    expect(() => parseAllowedOrigins(value)).toThrow(/ALLOWED_ORIGINS/);
  });
});

describe('wherever a platform mounts it', () => {
  it.each([
    'https://site.example/api/vote',
    'https://project.supabase.co/functions/v1/vote-api/vote',
    'https://edge.internal/vote-api/vote',
    'https://site.example/vote',
    'https://site.example/api/vote/',
  ])('finds the vote route in %s', async (url) => {
    const request = new Request(url, {
      method: 'POST',
      body: JSON.stringify({ contestantId: 'c01', email: ALICE, requestId: requestId() }),
    });
    const response = await handler(request);
    expect(((await response.json()) as Envelope).ok).toBe(true);
    await db.exec('delete from public.votes');
  });

  it.each([
    'https://site.example/api/votes',
    'https://site.example/api/vote/extra',
    'https://site.example/api/admin',
    'https://site.example/api/',
    'https://site.example/api/revote',
  ])('answers 404 to %s', async (url) => {
    const response = await handler(new Request(url, { method: 'POST', body: '{}' }));
    expect(response.status).toBe(404);
  });
});

describe('bot-check seam', () => {
  it('refuses a vote the check rejects, and never reaches the database', async () => {
    const humanCheck = vi.fn(async () => false);
    const { body } = await vote('c01', { using: makeHandler({ humanCheck }) });
    expect(body.error).toBe('invalid_vote');
    expect(humanCheck).toHaveBeenCalledOnce();
    expect((await db.query('select 1 from public.votes')).rows).toHaveLength(0);
  });

  it('lets a vote through when the check passes', async () => {
    const { body } = await vote('c01', { using: makeHandler({ humanCheck: async () => true }) });
    expect(body.ok).toBe(true);
  });
});

describe('when the database cannot be reached', () => {
  it('says unreachable, so the page retries instead of telling the voter they were refused', async () => {
    const broken = makeHandler({
      database: {
        rpc: async () => {
          throw new Error('connection reset');
        },
      },
    });
    expect((await vote('c01', { using: broken })).body).toEqual({ ok: false, error: 'unreachable' });
  });

  it('treats an answer that is not an envelope as a misconfiguration', async () => {
    const odd = makeHandler({ database: { rpc: async () => ({ message: 'function not found' }) } });
    expect((await vote('c01', { using: odd })).body.error).toBe('misconfigured');
  });
});

describe('responses', () => {
  it('are never cached', async () => {
    const request = new Request('https://vote.example.com/api/session', { method: 'POST', body: '{}' });
    const response = await handler(request);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toContain('application/json');
  });
});
