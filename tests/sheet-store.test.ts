import { describe, expect, it, vi } from 'vitest';
import { contestants, votingRules, votingWindow } from '../event.config';
import { VoteError } from '../src/domain/errors';
import { SheetVoteStore, deviceLabel, type SheetStoreOptions } from '../src/storage/sheetStore';
import { mergeContestants } from '../src/contestants';
import { loadAppsScript, type AppsScriptRun } from '../scripts/apps-script-harness';

const ENDPOINT = 'https://script.google.com/macros/s/AKfycbTEST_id-123/exec';
/** Made up for the tests. Not the real passcode. */
const ADMIN = 'unit-test-admin-passcode-0123';
const IG_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22F76 Instagram 385.0.0.29.74';

/** A fetch that hands each request to Code.gs, as the deployed web app would. */
function fetchInto(script: AppsScriptRun) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const params = new URL(String(_url)).searchParams;
    const answer =
      init?.method === 'POST'
        ? script.doPost(String(init.body))
        : script.doGet(params.get('key') ?? undefined, params.get('view') ?? undefined);
    return new Response(JSON.stringify(answer.json), { status: 200 });
  });
}

function store(overrides: Partial<SheetStoreOptions> = {}): SheetVoteStore {
  return new SheetVoteStore({
    endpoint: ENDPOINT,
    contestants,
    window: votingWindow,
    rules: votingRules,
    userAgent: IG_UA,
    ...overrides,
  });
}

async function rejection(promise: Promise<unknown>): Promise<VoteError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof VoteError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('the sheet store (test site)', () => {
  it('accepts only an Apps Script /exec address, or localhost for tests', () => {
    for (const endpoint of ['', 'https://example.com/exec', 'https://script.google.com/macros/s/x/dev', 'http://script.google.com/macros/s/x/exec']) {
      expect(() => store({ endpoint })).toThrow(/VITE_SHEET_ENDPOINT/);
    }
    expect(() => store({ endpoint: 'http://127.0.0.1:4190/exec' })).not.toThrow();
  });

  it('production: no banner, and the configured window decides whether voting is open', async () => {
    const at = (iso: string) => store({ fetch: vi.fn(), now: () => new Date(iso) });
    expect(at('2026-10-26T10:00:00+08:00').isDemo).toBe(false);
    // Open from 26 Oct 2026 00:00 SGT (Kelicia: live anytime), closes 5 Nov 23:59 SGT.
    expect((await at('2026-10-25T23:59:59+08:00').getSession()).state.status).toBe('not_open');
    expect((await at('2026-10-26T00:00:00+08:00').getSession()).state.status).toBe('open');
    expect((await at('2026-11-05T23:58:59+08:00').getSession()).state.status).toBe('open');
    expect((await at('2026-11-05T23:59:00+08:00').getSession()).state.status).toBe('closed');
  });

  it('test mode: always open, shows the TEST SITE banner and never lets a vote change', async () => {
    const sheet = store({ fetch: vi.fn(), testMode: true });
    const session = await sheet.getSession();
    expect(sheet.isDemo).toBe(true);
    expect(sheet.kind).toBe('sheet');
    expect(session.state.status).toBe('open');
    expect(session.state.allowVoteChange).toBe(false);
    expect(session.tallies).toBeNull();
  });

  it('does not call the sheet just to load the page when counts are hidden', async () => {
    const fetch = vi.fn();
    await store({ fetch }).getSession();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends one vote as a text/plain POST, with the number, name, email and a short device label', async () => {
    const script = loadAppsScript();
    const fetch = fetchInto(script);
    const receipt = await store({ fetch }).castVote('c07', '  Test+1@Example.com ', 'req-0001-aaaa');
    expect(receipt.contestantId).toBe('c07');
    expect(receipt.replaced).toBe(false);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(ENDPOINT);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'Content-Type': 'text/plain;charset=utf-8' });
    expect(init?.credentials).toBe('omit');
    expect(JSON.parse(String(init?.body))).toEqual({
      contestantNumber: 7,
      contestantName: 'Contestant 7',
      email: 'Test+1@Example.com',
      voteId: 'req-0001-aaaa',
      device: 'iPhone · Instagram',
      ip: 'unavailable',
    });
    expect(script.votes()?.rows[1]?.slice(1, 9)).toEqual([
      'Test+1@Example.com', 'test+1@example.com', 'unavailable', 7, 'Contestant 7', 'req-0001-aaaa', 'iPhone · Instagram', false,
    ]);
  });

  it('reports a second vote from the same email as duplicate_vote', async () => {
    const script = loadAppsScript();
    const sheet = store({ fetch: fetchInto(script) });
    await sheet.castVote('c07', 'jane.doe@gmail.com', 'req-0001-aaaa');
    const error = await rejection(sheet.castVote('c03', 'janedoe+2@gmail.com', 'req-0002-bbbb'));
    expect(error.code).toBe('duplicate_vote');
  });

  it('checks the email and contestant before sending anything', async () => {
    const fetch = vi.fn();
    expect((await rejection(store({ fetch }).castVote('c07', 'nope', 'req-0001-aaaa'))).code).toBe('invalid_email');
    expect((await rejection(store({ fetch }).castVote('c99', 'a@example.com', 'req-0001-aaaa'))).code).toBe('invalid_vote');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('treats a busy sheet, a failed connection and a 5xx as worth retrying', async () => {
    const busy = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'busy' })));
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const down = vi.fn(async () => new Response('oops', { status: 502 }));
    for (const fetch of [busy, offline, down]) {
      const error = await rejection(store({ fetch }).castVote('c07', 'a@example.com', 'req-0001-aaaa'));
      expect(error.code).toBe('unreachable');
      expect(error.retryable).toBe(true);
    }
  });

  it('says so when the web app answers HTML (not deployed for Anyone)', async () => {
    const fetch = vi.fn(async () => new Response('<html>Sign in</html>', { status: 200 }));
    const error = await rejection(store({ fetch }).castVote('c07', 'a@example.com', 'req-0001-aaaa'));
    expect(error.code).toBe('misconfigured');
    expect(error.message).toMatch(/Anyone/);
  });

  it('builds the admin snapshot from the sheet, with no email in it', async () => {
    const script = loadAppsScript({ adminKey: ADMIN });
    const sheet = store({ fetch: fetchInto(script) });
    await sheet.castVote('c07', 'alice@example.com', 'req-0001-aaaa');
    await sheet.castVote('c12', 'bob@example.com', 'req-0002-bbbb');
    await sheet.castVote('c07', 'carol@example.com', 'req-0003-cccc');
    const snapshot = await sheet.adminGetSnapshot(ADMIN);
    expect(snapshot.votes.map((v) => v.contestantId)).toEqual(['c07', 'c12', 'c07']);
    expect(snapshot.votes.every((v) => /^[0-9a-f]{8}$/.test(v.voterRef) && v.replacedAt === null)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(/@example\.com/);
  });

  it('the admin passcode is checked by the sheet, not the page; the demo passcode is refused', async () => {
    const script = loadAppsScript({ adminKey: ADMIN });
    const fetch = fetchInto(script);
    const sheet = store({ fetch });
    expect((await rejection(sheet.adminGetSnapshot('wrong'))).code).toBe('bad_passcode');
    expect((await rejection(sheet.adminGetSnapshot('demo-admin'))).code).toBe('bad_passcode');
    expect((await rejection(sheet.adminGetSnapshot(''))).code).toBe('bad_passcode');
    expect((await sheet.adminGetSnapshot(ADMIN)).votes).toEqual([]);
    expect((await rejection(sheet.adminGetAudit(ADMIN))).message).toMatch(/Google Sheet/);
    expect((await rejection(sheet.adminSetStatus(ADMIN))).message).toMatch(/event\.config\.ts/);
    expect((await rejection(sheet.adminSetStatus('wrong'))).code).toBe('bad_passcode');
  });

  it('never shows public counts: they would need the admin passcode', async () => {
    const fetch = vi.fn();
    const session = await store({ fetch, rules: { ...votingRules, publicCounts: true } }).getSession();
    expect(session.tallies).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports the sheet refusing a vote outside the window', async () => {
    const early = loadAppsScript({ window: { opensAt: '2099-01-01T00:00:00Z', closesAt: '2099-01-02T00:00:00Z' } });
    expect((await rejection(store({ fetch: fetchInto(early) }).castVote('c07', 'a@example.com', 'req-0001-aaaa'))).code).toBe('voting_not_open');
    const late = loadAppsScript({ window: { opensAt: '2000-01-01T00:00:00Z', closesAt: '2000-01-02T00:00:00Z' } });
    expect((await rejection(store({ fetch: fetchInto(late) }).castVote('c07', 'a@example.com', 'req-0001-aaaa'))).code).toBe('voting_closed');
  });
});

describe('the self-reported IP (indicative only)', () => {
  const LOOKUP = 'https://api.ipify.org?format=json';

  it('looks the IP up once, sends it with the vote, and the sheet records it', async () => {
    const script = loadAppsScript();
    const sheetFetch = fetchInto(script);
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
      String(url) === LOOKUP ? new Response(JSON.stringify({ ip: '203.0.113.5' })) : sheetFetch(url, init),
    );
    const sheet = store({ fetch, ipLookupUrl: LOOKUP });
    await sheet.castVote('c07', 'a@example.com', 'req-0001-aaaa');
    await sheet.castVote('c08', 'b@example.com', 'req-0002-bbbb');
    expect(fetch.mock.calls.filter(([url]) => String(url) === LOOKUP)).toHaveLength(1);
    expect(script.votes()?.rows.slice(1).map((row) => row[3])).toEqual(['203.0.113.5', '203.0.113.5']);
  });

  it.each([
    ['the lookup fails', async () => { throw new TypeError('blocked'); }],
    ['the lookup answers nonsense', async () => new Response(JSON.stringify({ ip: '<script>' }))],
    ['the lookup answers HTML', async () => new Response('<html></html>')],
  ])('sends "unavailable" and still counts the vote when %s', async (_label, lookup) => {
    const script = loadAppsScript();
    const sheetFetch = fetchInto(script);
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
      String(url) === LOOKUP ? lookup() : sheetFetch(url, init),
    );
    const receipt = await store({ fetch, ipLookupUrl: LOOKUP }).castVote('c07', 'a@example.com', 'req-0001-aaaa');
    expect(receipt.contestantId).toBe('c07');
    expect(script.votes()?.rows[1]?.[3]).toBe('unavailable');
  });

  it('gives up on a slow lookup after the timeout', async () => {
    const script = loadAppsScript();
    const sheetFetch = fetchInto(script);
    const fetch = vi.fn((url: string | URL | Request, init?: RequestInit) =>
      String(url) === LOOKUP
        ? new Promise<Response>((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
          )
        : sheetFetch(url, init),
    );
    const started = Date.now();
    await store({ fetch, ipLookupUrl: LOOKUP, ipTimeoutMs: 50 }).castVote('c07', 'a@example.com', 'req-0001-aaaa');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(script.votes()?.rows[1]?.[3]).toBe('unavailable');
  });
});

describe('the runtime Top 20', () => {
  const rows: (string | number)[][] = [
    [7, 'Kim Lookalike', 'kim.lookalike', 'Jurong West', 'https://example.com/07.jpg'],
    [3, 'Ahmad', '', '', ''],
  ];

  it('is empty before the reveal, and the page keeps its placeholders', async () => {
    const script = loadAppsScript({ contestants: rows, window: { opensAt: '2099-01-01T00:00:00Z', closesAt: '2099-01-02T00:00:00Z' } });
    expect(await store({ fetch: fetchInto(script) }).getContestants()).toEqual({ revealed: false, preview: false, contestants: [] });
  });

  it('after the reveal: lists the tab, and votes record the real name in the sheet', async () => {
    const script = loadAppsScript({ contestants: rows });
    const sheet = store({ fetch: fetchInto(script) });
    const list = await sheet.getContestants();
    expect(list.revealed).toBe(true);
    expect(list.contestants).toEqual([
      { number: 7, stageName: 'Kim Lookalike', handle: '@kim.lookalike', tagline: 'Jurong West', photo: 'https://example.com/07.jpg' },
      { number: 3, stageName: 'Ahmad', handle: '', tagline: '', photo: '' },
    ]);
    await sheet.castVote('c07', 'a@example.com', 'req-0001-aaaa');
    expect(script.votes()?.rows[1]?.[5]).toBe('Kim Lookalike');
  });

  it('drops anything malformed the sheet might send', async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, data: { revealed: true, contestants: [
        { no: 99, name: 'x', handle: '', tagline: '', photo: '' },
        { no: 5, name: 'Five', handle: 'bad handle', tagline: '', photo: 'javascript:alert(1)' },
        'junk',
      ] } })),
    );
    expect((await store({ fetch }).getContestants()).contestants).toEqual([
      { number: 5, stageName: 'Five', handle: '', tagline: '', photo: '' },
    ]);
  });

  it('merges field by field over the config, keeping ids and numbers', () => {
    const merged = mergeContestants(contestants, [
      { number: 7, stageName: 'Kim Lookalike', handle: '@kim', tagline: '', photo: 'https://example.com/07.jpg' },
      { number: 3, stageName: '', handle: '', tagline: '', photo: '' },
    ]);
    expect(merged).toHaveLength(20);
    expect(merged[6]).toMatchObject({ id: 'c07', number: 7, stageName: 'Kim Lookalike', handle: '@kim', photo: 'https://example.com/07.jpg' });
    expect(merged[2]).toEqual(contestants[2]);
  });
});

describe('organiser test mode (26 Oct 2026)', () => {
  const before = { opensAt: '2099-01-01T00:00:00Z', closesAt: '2099-01-02T00:00:00Z' };
  const config = { opensAt: '2099-01-01T00:00:00+08:00', closesAt: '2099-01-02T00:00:00+08:00', autoOpen: true };

  it('is off by default: closed before the window, and the sheet refuses', async () => {
    const script = loadAppsScript({ window: before, adminKey: ADMIN });
    const sheet = store({ fetch: fetchInto(script), window: config });
    expect(sheet.organiserMode).toBe(false);
    expect((await sheet.getSession()).state.status).toBe('not_open');
    expect((await rejection(sheet.castVote('c07', 'a@example.com', 'req-0001-aaaa'))).code).toBe('voting_not_open');
  });

  it('with the passcode: open now, the vote carries it, and the row is marked as a test', async () => {
    const script = loadAppsScript({ window: before, adminKey: ADMIN });
    const fetch = fetchInto(script);
    const sheet = store({ fetch, window: config });
    sheet.setOrganiserKey(ADMIN);
    expect(sheet.organiserMode).toBe(true);
    expect((await sheet.getSession()).state.status).toBe('open');
    await sheet.castVote('c07', 'kel@example.com', 'req-0001-aaaa');
    expect(JSON.parse(String(fetch.mock.calls.at(-1)?.[1]?.body)).adminKey).toBe(ADMIN);
    expect(script.votes()?.rows[1]?.[9]).toBe(true);
    sheet.setOrganiserKey(null);
    expect(sheet.organiserMode).toBe(false);
  });

  it('previews the Top 20 before the reveal, flagged as a preview', async () => {
    const script = loadAppsScript({ window: before, adminKey: ADMIN, contestants: [[7, 'Kim Lookalike', '', '', '']] });
    const sheet = store({ fetch: fetchInto(script), window: config });
    expect((await sheet.getContestants()).contestants).toEqual([]);
    sheet.setOrganiserKey(ADMIN);
    const list = await sheet.getContestants();
    expect(list).toMatchObject({ revealed: false, preview: true });
    expect(list.contestants[0]?.stageName).toBe('Kim Lookalike');
  });

  it('a wrong passcode gains nothing: the sheet still refuses outside the window', async () => {
    const script = loadAppsScript({ window: before, adminKey: ADMIN });
    const sheet = store({ fetch: fetchInto(script), window: config });
    sheet.setOrganiserKey('guessed');
    expect((await rejection(sheet.castVote('c07', 'a@example.com', 'req-0001-aaaa'))).code).toBe('voting_not_open');
    expect(script.votes()).toBeUndefined();
  });
});

describe('deviceLabel', () => {
  it.each([
    [IG_UA, 'iPhone · Instagram'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36', 'Android · Chrome'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', 'Mac · Safari'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/129.0 Safari/537.36 Edg/129.0', 'Windows · Edge'],
    ['', 'Other · Other'],
  ])('%s', (ua, label) => {
    expect(deviceLabel(ua)).toBe(label);
  });
});
