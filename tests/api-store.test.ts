/**
 * The browser adapter against a stubbed fetch: request shape, error mapping and
 * response validation. No network. The server-side rules are covered in
 * schema.sql.test.ts and api-handler.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { VoteError } from '../src/domain/errors';
import { ApiVoteStore } from '../src/storage/apiStore';
import { PostgrestStub } from './postgrest-stub';
import { createPostgrestDatabase } from '../server/database';
import { parseRoute } from '../src/router';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function storeWith(fetchImpl: typeof fetch, timeoutMs?: number): ApiVoteStore {
  return new ApiVoteStore({ baseUrl: '/api/', fetch: fetchImpl, timeoutMs });
}

const STATE = {
  status: 'open',
  adminStatus: 'pending',
  opensAt: '2026-11-03T04:00:00+00:00',
  closesAt: '2026-11-04T15:59:00+00:00',
  allowVoteChange: false,
  publicCounts: false,
  serverTime: '2026-11-03T05:00:00+00:00',
};

const SESSION = { state: STATE, tallies: null };

const RECEIPT = {
  contestantId: 'c07',
  castAt: '2026-11-03T05:00:00+00:00',
  replaced: false,
  session: SESSION,
};

describe('ApiVoteStore requests', () => {
  it('posts the contestant, the email and the request id in the body, never in the address', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true, data: RECEIPT }));
    const receipt = await storeWith(fetchMock).castVote('c07', 'alice@example.com', 'request-0001');

    expect(receipt).toEqual(RECEIPT);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/vote');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('omit');
    expect(String(url)).not.toContain('alice');
    expect(JSON.parse(String(init?.body))).toEqual({
      contestantId: 'c07',
      email: 'alice@example.com',
      requestId: 'request-0001',
    });
    expect(Object.keys(init?.headers ?? {}).map((name) => name.toLowerCase())).toEqual([
      'content-type',
      'accept',
    ]);
  });

  it('sends the passcode in the body on admin calls, never in the URL', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true, data: STATE }));
    await storeWith(fetchMock).adminSetStatus('s3cret-passcode', 'closed');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/admin/status');
    expect(String(url)).not.toContain('s3cret');
    expect(JSON.parse(String(init?.body))).toEqual({ passcode: 's3cret-passcode', status: 'closed' });
  });

  it('reads the session', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true, data: SESSION }));
    await expect(storeWith(fetchMock).getSession()).resolves.toEqual(SESSION);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/session');
  });

  it('reads public counts when the server sends them', async () => {
    const tallies = [{ contestantId: 'c01', votes: 4 }];
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ ok: true, data: { ...SESSION, tallies } }),
    );
    expect((await storeWith(fetchMock).getSession()).tallies).toEqual(tallies);
  });

  it('accepts a full https base URL', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true, data: SESSION }));
    await new ApiVoteStore({ baseUrl: 'https://vote.example.com/api', fetch: fetchMock }).getSession();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://vote.example.com/api/session');
  });

  it.each(['', 'api', 'http://vote.example.com/api', 'ftp://x/api', '//evil.example/api'])(
    'refuses the base URL "%s"',
    (baseUrl) => {
      expect(() => new ApiVoteStore({ baseUrl })).toThrow(VoteError);
    },
  );
});

describe('ApiVoteStore error mapping', () => {
  it.each([
    'voting_not_open',
    'voting_closed',
    'duplicate_vote',
    'invalid_email',
    'invalid_vote',
    'rate_limited',
    'bad_passcode',
    'misconfigured',
  ] as const)('passes on the server’s answer: %s', async (code) => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: false, error: code }));
    await expect(storeWith(fetchMock).castVote('c01', 'alice@example.com', 'request-0001')).rejects.toMatchObject({
      code,
      retryable: false,
    });
  });

  it('uses the plain-language message for a duplicate', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ ok: false, error: 'duplicate_vote' }),
    );
    await expect(storeWith(fetchMock).castVote('c01', 'alice@example.com', 'request-0001')).rejects.toThrow(
      'A vote has already been counted for this email.',
    );
  });

  it('treats an error code it does not know as a misconfiguration', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ ok: false, error: 'forbidden_origin' }, 403),
    );
    await expect(storeWith(fetchMock).getSession()).rejects.toMatchObject({ code: 'misconfigured' });
  });

  it.each([429, 500, 502, 503])('treats HTTP %s as unreachable, worth a retry', async (status) => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ message: 'busy' }, status));
    await expect(storeWith(fetchMock).getSession()).rejects.toMatchObject({
      code: 'unreachable',
      retryable: true,
    });
  });

  it('treats a 404 page as a misconfiguration: the function is not where the page expects', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response('<html>Not found</html>', { status: 404 }),
    );
    await expect(storeWith(fetchMock).getSession()).rejects.toMatchObject({ code: 'misconfigured' });
  });

  it('treats a network failure as unreachable', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(storeWith(fetchMock).getSession()).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('gives up on a request that hangs', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    await expect(storeWith(fetchMock, 20).getSession()).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('treats an unreadable 200 as unreachable', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('<html>', { status: 200 }));
    await expect(storeWith(fetchMock).getSession()).rejects.toMatchObject({ code: 'unreachable' });
  });
});

describe('ApiVoteStore response validation', () => {
  it.each([
    ['not an envelope', { status: 'open' }],
    ['an array', [SESSION]],
    ['a session with no state', { ok: true, data: { tallies: null } }],
    ['a negative tally', { ok: true, data: { ...SESSION, tallies: [{ contestantId: 'c01', votes: -1 }] } }],
    ['an unknown status', { ok: true, data: { ...SESSION, state: { ...STATE, status: 'paused' } } }],
    ['tallies that are not a list', { ok: true, data: { ...SESSION, tallies: { c01: 3 } } }],
  ])('refuses %s', async (_name, body) => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(body));
    await expect(storeWith(fetchMock).getSession()).rejects.toMatchObject({ code: 'misconfigured' });
  });

  it('is not a demo store and pushes nothing', () => {
    const store = storeWith(vi.fn<typeof fetch>());
    expect(store.isDemo).toBe(false);
    expect(store.kind).toBe('api');
    expect(store.subscribe()).toBeTypeOf('function');
  });
});

describe('ApiVoteStore audit export', () => {
  const ROW = {
    voteId: 1,
    contestantId: 'c01',
    castAt: '2026-11-03T05:00:00+00:00',
    replacedAt: null,
    emailTyped: 'Alice@Example.com',
    emailNormalised: 'alice@example.com',
    ip: '203.0.113.7',
    ipSource: 'platform',
    votesFromIp: 1,
  };

  it('asks the admin/audit route, with the passcode in the body', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true, data: [ROW] }));
    await expect(storeWith(fetchMock).adminGetAudit('a-long-passcode')).resolves.toEqual([ROW]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/admin/audit');
    expect(JSON.parse(String(init?.body))).toEqual({ passcode: 'a-long-passcode' });
  });

  it.each([
    ['an unknown ip source', { ...ROW, ipSource: 'guessed' }],
    ['a missing email', { ...ROW, emailTyped: undefined }],
    ['a negative count', { ...ROW, votesFromIp: -1 }],
  ])('refuses %s', async (_name, row) => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true, data: [row] }));
    await expect(storeWith(fetchMock).adminGetAudit('a-long-passcode')).rejects.toMatchObject({
      code: 'misconfigured',
    });
  });
});

describe('the server’s database client', () => {
  it('calls the function with the service key in the headers, never in the URL', async () => {
    const stub = new PostgrestStub({ ok: true, data: SESSION });
    const database = createPostgrestDatabase({
      url: 'https://project-ref.supabase.co/',
      serviceKey: 'service-key-value',
      fetch: stub.fetch,
    });
    const args = {
      p_voter_key: 'a'.repeat(64),
      p_contestant_id: 'c01',
      p_request_id: 'request-0001',
      p_email_typed: 'alice@example.com',
      p_email_normalised: 'alice@example.com',
      p_ip: '203.0.113.7',
    };
    await expect(database.rpc('cast_vote', args)).resolves.toEqual({
      ok: true,
      data: SESSION,
    });
    expect(stub.lastUrl).toBe('https://project-ref.supabase.co/rest/v1/rpc/cast_vote');
    expect(stub.lastUrl).not.toContain('service-key-value');
    expect(stub.lastHeaders).toMatchObject({
      apikey: 'service-key-value',
      Authorization: 'Bearer service-key-value',
    });
    expect(stub.lastBody).toEqual(args);
  });

  it.each([
    [401, 'misconfigured'],
    [404, 'misconfigured'],
    [429, 'unreachable'],
    [503, 'unreachable'],
  ])('maps HTTP %s to %s', async (status, code) => {
    const stub = new PostgrestStub({ message: 'no' }, status);
    const database = createPostgrestDatabase({
      url: 'https://project-ref.supabase.co',
      serviceKey: 'service-key-value',
      fetch: stub.fetch,
    });
    await expect(database.rpc('admin_snapshot', {})).rejects.toMatchObject({ code });
  });

  it.each([
    ['no URL', { url: '', serviceKey: 'k' }],
    ['a plain http URL', { url: 'http://project-ref.supabase.co', serviceKey: 'k' }],
    ['no key', { url: 'https://project-ref.supabase.co', serviceKey: '  ' }],
  ])('refuses to start with %s', (_name, options) => {
    expect(() => createPostgrestDatabase(options)).toThrow(VoteError);
  });
});

describe('routing', () => {
  it.each(['', '#', '#/', '#/vote', '#/anything-else', '#/?fbclid=abc123'])(
    'shows the voting page for "%s"',
    (hash) => {
      expect(parseRoute(hash)).toEqual({ view: 'vote' });
    },
  );

  it.each(['#/admin', '#admin', '#/admin/', '#/admin?x=1'])('shows the admin view for "%s"', (hash) => {
    expect(parseRoute(hash)).toEqual({ view: 'admin' });
  });
});
