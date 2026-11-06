import { describe, expect, it, vi } from 'vitest';
import { contestants, votingRules } from '../event.config';
import { STATUS_EDGE_SECONDS, relay, type EdgeCache, type Env } from '../functions/api/vote';
import { SheetVoteStore } from '../src/storage/sheetStore';
import { loadAppsScript, type AppsScriptRun } from '../scripts/apps-script-harness';

/**
 * Revision 15 "close now": the organiser ticks Settings!B1 during the livestream.
 * Code.gs refuses votes at once; pages learn it through ?view=status, which the
 * relay keeps at the edge for STATUS_EDGE_SECONDS.
 */

const OPEN = { opensAt: '2026-10-26T00:00:00+08:00', closesAt: '2026-11-12T23:59:00+08:00' };
const NOW = new Date('2026-11-12T20:30:00+08:00');
const ADMIN = 'unit-test-passcode';
const SHEET = 'https://script.google.com/macros/s/AKfycbCLOSE_now-123/exec';
const ENV: Env = { SHEET_ENDPOINT: SHEET, TURNSTILE_SECRET_KEY: 'unit-test-secret' };

const script = (closedNow?: boolean | string): AppsScriptRun =>
  loadAppsScript({ window: OPEN, now: () => NOW, adminKey: ADMIN, ...(closedNow === undefined ? {} : { closedNow }) });

const ballot = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ contestantNumber: 3, contestantName: 'Three', email: 'fan@example.com', voteId: 'vote-close-0001', device: 'x', ip: 'unavailable', ...extra });

const flip = (run: AppsScriptRun, value: boolean | string): void => {
  const row = run.tab('Settings')?.rows[0];
  if (row === undefined) throw new Error('no Settings tab');
  row[1] = value;
};

describe('Code.gs: close now (Settings!B1)', () => {
  it('without a Settings tab, or with B1 unticked, voting follows the window', () => {
    expect(script().doPost(ballot()).json).toMatchObject({ ok: true, data: { duplicate: false } });
    expect(script(false).doPost(ballot()).json).toMatchObject({ ok: true, data: { duplicate: false } });
  });

  it('ticked, a vote is refused as voting_closed and no row is written', () => {
    const run = script(true);
    expect(run.doPost(ballot()).json).toEqual({ ok: false, error: 'voting_closed' });
    expect(run.votes()?.rows.length ?? 0).toBe(0);
    expect(script('TRUE').doPost(ballot()).json).toEqual({ ok: false, error: 'voting_closed' });
  });

  it('is read on every vote, not cached: ticking it mid-way stops the next vote at once', () => {
    const run = script(false);
    expect(run.doPost(ballot()).json).toMatchObject({ ok: true });
    flip(run, true);
    expect(run.doPost(ballot({ email: 'second@example.com', voteId: 'vote-close-0002' })).json).toEqual({ ok: false, error: 'voting_closed' });
    flip(run, false);
    expect(run.doPost(ballot({ email: 'third@example.com', voteId: 'vote-close-0003' })).json).toMatchObject({ ok: true });
  });

  it('an organiser test vote still goes through, as outside the window', () => {
    expect(script(true).doPost(ballot({ adminKey: ADMIN })).json).toMatchObject({ ok: true, data: { duplicate: false } });
  });

  it('?view=status answers { closedNow } with no passcode, cached until the cache expires', () => {
    const run = script(false);
    expect(run.doGet(undefined, 'status').json).toEqual({ ok: true, data: { closedNow: false } });
    flip(run, true);
    expect(run.doGet(undefined, 'status').json).toEqual({ ok: true, data: { closedNow: false } });
    run.clearCache();
    expect(run.doGet(undefined, 'status').json).toEqual({ ok: true, data: { closedNow: true } });
    expect(JSON.stringify(run.doGet(undefined, 'status').json)).not.toMatch(/@/);
  });
});

/** A fetch that plays the deployed web app, and an edge cache like caches.default. */
function setup(closedNow: boolean) {
  const run = script(closedNow);
  const calls: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith(SHEET)) throw new Error(`unexpected request to ${url}`);
    calls.push(url);
    const params = new URL(url).searchParams;
    const answer = init?.method === 'POST' ? run.doPost(String(init.body)) : run.doGet(params.get('key') ?? undefined, params.get('view') ?? undefined);
    return new Response(JSON.stringify(answer.json), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const stored = new Map<string, Response>();
  const cache: EdgeCache = {
    match: async (request) => stored.get(request.url)?.clone(),
    put: async (request, response) => {
      stored.set(request.url, response);
    },
  };
  return { run, calls, fetch, cache, stored };
}

const get = (query: string): Request => new Request(`https://youtrip-lookalike-vote.pages.dev/api/vote${query}`, { method: 'GET' });

describe('/api/vote: ?view=status at the edge', () => {
  it('asks Apps Script once, then serves the edge copy, marked cacheable for STATUS_EDGE_SECONDS', async () => {
    const { calls, fetch, cache } = setup(true);
    const first = await relay(get('?view=status'), ENV, fetch, cache);
    expect(await first.json()).toEqual({ ok: true, data: { closedNow: true } });
    expect(first.headers.get('Cache-Control')).toBe(`public, max-age=${STATUS_EDGE_SECONDS}`);
    for (let i = 0; i < 5; i += 1) {
      expect(await (await relay(get('?view=status'), ENV, fetch, cache)).json()).toEqual({ ok: true, data: { closedNow: true } });
    }
    expect(calls).toEqual([`${SHEET}?view=status`]);
    expect(STATUS_EDGE_SECONDS).toBeLessThanOrEqual(30);
  });

  it('does not keep a failure: the next request asks again', async () => {
    const { fetch, cache, stored } = setup(false);
    fetch.mockImplementationOnce(async () => new Response('nope', { status: 503 }));
    const failed = await relay(get('?view=status'), ENV, fetch, cache);
    expect(failed.status).toBe(502);
    expect(stored.size).toBe(0);
    expect(await (await relay(get('?view=status'), ENV, fetch, cache)).json()).toEqual({ ok: true, data: { closedNow: false } });
  });

  it('anything else (a passcode, other views) still passes straight through, never from the cache', async () => {
    const { calls, fetch, cache, stored } = setup(false);
    await relay(get('?view=status&key=x'), ENV, fetch, cache);
    await relay(get('?view=contestants'), ENV, fetch, cache);
    expect(stored.size).toBe(0);
    expect(calls).toEqual([`${SHEET}?view=status&key=x`, `${SHEET}?view=contestants`]);
  });

  it('works without an edge cache (local runs): every request goes to Apps Script', async () => {
    const { calls, fetch } = setup(true);
    await relay(get('?view=status'), ENV, fetch, undefined);
    await relay(get('?view=status'), ENV, fetch, undefined);
    expect(calls.length).toBe(2);
  });
});

describe('the page follows the switch (sheet store, through /api/vote)', () => {
  const page = (fetch: typeof globalThis.fetch, follow = true) =>
    new SheetVoteStore({
      endpoint: '/api/vote',
      contestants,
      window: { ...OPEN, autoOpen: true },
      rules: votingRules,
      now: () => NOW,
      fetch,
      humanToken: async () => 'token',
      followCloseSwitch: follow,
    });
  // The relay in front of the harness, as on Cloudflare (the page asks a relative /api/vote).
  const through = (closedNow: boolean) => {
    const s = setup(closedNow);
    const pageFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
      relay(new Request(new URL(String(input), 'https://youtrip-lookalike-vote.pages.dev'), init), ENV, s.fetch, s.cache),
    );
    return { ...s, pageFetch };
  };

  it('shows voting closed as soon as the switch is on', async () => {
    const { pageFetch } = through(true);
    expect((await page(pageFetch).getSession()).state.status).toBe('closed');
  });

  it('stays open while the switch is off', async () => {
    const { pageFetch } = through(false);
    expect((await page(pageFetch).getSession()).state.status).toBe('open');
  });

  it('stays open when the status cannot be read (Code.gs still refuses votes itself)', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect((await page(down).getSession()).state.status).toBe('open');
    // The deployed Code.gs before this revision answers bad_passcode to an unknown view: still open.
    const old = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'bad_passcode' }), { status: 200 }));
    expect((await page(old).getSession()).state.status).toBe('open');
  });

  it('does not ask when the window itself is shut, or when following is off', async () => {
    const { pageFetch } = through(true);
    const after = new SheetVoteStore({
      endpoint: '/api/vote', contestants, window: { ...OPEN, autoOpen: true }, rules: votingRules,
      now: () => new Date('2026-11-13T00:30:00+08:00'), fetch: pageFetch, humanToken: async () => 'token', followCloseSwitch: true,
    });
    expect((await after.getSession()).state.status).toBe('closed');
    expect((await page(pageFetch, false).getSession()).state.status).toBe('open');
    expect(pageFetch).not.toHaveBeenCalled();
  });
});
