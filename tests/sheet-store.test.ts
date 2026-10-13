import { describe, expect, it, vi } from 'vitest';
import { contestants, demo, votingRules, votingWindow } from '../event.config';
import { VoteError } from '../src/domain/errors';
import { SheetVoteStore, deviceLabel, type SheetStoreOptions } from '../src/storage/sheetStore';
import { loadAppsScript, type AppsScriptRun } from '../scripts/apps-script-harness';

const ENDPOINT = 'https://script.google.com/macros/s/AKfycbTEST_id-123/exec';
const IG_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22F76 Instagram 385.0.0.29.74';

/** A fetch that hands each request to Code.gs, as the deployed web app would. */
function fetchInto(script: AppsScriptRun) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const answer = init?.method === 'POST' ? script.doPost(String(init.body)) : script.doGet();
    return new Response(JSON.stringify(answer.json), { status: 200 });
  });
}

function store(overrides: Partial<SheetStoreOptions> = {}): SheetVoteStore {
  return new SheetVoteStore({
    endpoint: ENDPOINT,
    contestants,
    window: votingWindow,
    rules: votingRules,
    passcode: demo.passcode,
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

  it('is always open, shows the TEST SITE banner and never lets a vote change', async () => {
    const sheet = store({ fetch: vi.fn() });
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
    });
    expect(script.votes()?.rows[1]?.slice(1, 6)).toEqual([7, 'Contestant 7', 'Test+1@Example.com', 'test+1@example.com', 'iPhone · Instagram']);
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
    const script = loadAppsScript();
    const sheet = store({ fetch: fetchInto(script) });
    await sheet.castVote('c07', 'alice@example.com', 'req-0001-aaaa');
    await sheet.castVote('c12', 'bob@example.com', 'req-0002-bbbb');
    await sheet.castVote('c07', 'carol@example.com', 'req-0003-cccc');
    const snapshot = await sheet.adminGetSnapshot(demo.passcode);
    expect(snapshot.votes.map((v) => v.contestantId)).toEqual(['c07', 'c12', 'c07']);
    expect(snapshot.votes.every((v) => /^[0-9a-f]{8}$/.test(v.voterRef) && v.replacedAt === null)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(/@example\.com/);
  });

  it('keeps the admin view behind the passcode, and leaves the audit to the sheet', async () => {
    const fetch = vi.fn();
    const sheet = store({ fetch });
    expect((await rejection(sheet.adminGetSnapshot('wrong'))).code).toBe('bad_passcode');
    expect((await rejection(sheet.adminGetAudit(demo.passcode))).message).toMatch(/Google Sheet/);
    expect((await rejection(sheet.adminSetStatus(demo.passcode))).code).toBe('misconfigured');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fetches public counts from the sheet only when they are switched on', async () => {
    const script = loadAppsScript();
    const sheet = store({ fetch: fetchInto(script), rules: { ...votingRules, publicCounts: true } });
    await sheet.castVote('c07', 'alice@example.com', 'req-0001-aaaa');
    const session = await sheet.getSession();
    expect(session.tallies?.find((t) => t.contestantId === 'c07')?.votes).toBe(1);
    expect(session.tallies).toHaveLength(contestants.length);
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
