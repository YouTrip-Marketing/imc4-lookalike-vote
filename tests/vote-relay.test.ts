import { describe, expect, it, vi } from 'vitest';
import { contestants, votingRules, votingWindow } from '../event.config';
import { SITEVERIFY_URL, clientIp, relay, type Env } from '../functions/api/vote';
import { SheetVoteStore } from '../src/storage/sheetStore';
import { loadAppsScript, type AppsScriptRun } from '../scripts/apps-script-harness';

/**
 * functions/api/vote.ts, the Pages Function between the page and Apps Script
 * (6 Nov 2026). The sheet side is the real Code.gs under the harness; the
 * Turnstile side is a stand-in for Cloudflare's siteverify.
 */

const SHEET = 'https://script.google.com/macros/s/AKfycbRELAY_id-123/exec';
const ENV: Env = { SHEET_ENDPOINT: SHEET, TURNSTILE_SECRET_KEY: 'unit-test-secret' };
const CALLER = '203.0.113.9';
const OPEN = { opensAt: '2026-10-26T00:00:00+08:00', closesAt: '2026-11-12T23:59:00+08:00' };

interface World {
  fetch: ReturnType<typeof vi.fn>;
  script: AppsScriptRun;
  siteverify: () => { secret: string; response: string; remoteip: string | null }[];
  sheetCalls: () => { url: string; init: RequestInit | undefined }[];
}

/** A fetch that plays Cloudflare siteverify and the deployed web app. */
function world(options: { tokens?: Record<string, boolean>; siteverifyDown?: boolean; sheetStatus?: number; sheetHtml?: boolean } = {}): World {
  const script = loadAppsScript({ window: OPEN, now: () => new Date('2026-11-07T12:00:00+08:00') });
  const checks: { secret: string; response: string; remoteip: string | null }[] = [];
  const sheetCalls: { url: string; init: RequestInit | undefined }[] = [];
  const accepted = options.tokens ?? { 'good-token': true };
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === SITEVERIFY_URL) {
      if (options.siteverifyDown === true) throw new TypeError('fetch failed');
      const form = new URLSearchParams(String(init?.body));
      checks.push({ secret: form.get('secret') ?? '', response: form.get('response') ?? '', remoteip: form.get('remoteip') });
      return new Response(JSON.stringify({ success: accepted[form.get('response') ?? ''] === true }), { status: 200 });
    }
    if (url.startsWith(SHEET)) {
      sheetCalls.push({ url, init });
      if (options.sheetStatus !== undefined) return new Response('nope', { status: options.sheetStatus });
      if (options.sheetHtml === true) return new Response('<html>Sign in</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
      const params = new URL(url).searchParams;
      const answer =
        init?.method === 'POST'
          ? script.doPost(String(init.body))
          : script.doGet(params.get('key') ?? undefined, params.get('view') ?? undefined);
      return new Response(JSON.stringify(answer.json), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`unexpected request to ${url}`);
  });
  return { fetch, script, siteverify: () => checks, sheetCalls: () => sheetCalls };
}

function post(body: unknown, headers: Record<string, string> = { 'CF-Connecting-IP': CALLER }): Request {
  return new Request('https://youtrip-lookalike-vote.pages.dev/api/vote', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const vote = (extra: Record<string, unknown> = {}) => ({
  contestantNumber: 7,
  contestantName: 'Seven',
  email: 'Jane.Doe@gmail.com',
  voteId: 'req-0001-aaaa',
  device: 'iPhone · Instagram',
  ip: '198.51.100.1',
  turnstileToken: 'good-token',
  ...extra,
});

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('/api/vote: a vote', () => {
  it('checks the token with Cloudflare, then forwards the vote with the real caller IP and without the token', async () => {
    const w = world();
    const response = await relay(post(vote()), ENV, w.fetch);
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ ok: true, data: { duplicate: false } });

    expect(w.siteverify()).toEqual([{ secret: 'unit-test-secret', response: 'good-token', remoteip: CALLER }]);
    const [call] = w.sheetCalls();
    expect(call?.url).toBe(SHEET);
    expect(call?.init?.method).toBe('POST');
    expect(new Headers(call?.init?.headers).get('Content-Type')).toMatch(/^text\/plain/);
    const forwarded = JSON.parse(String(call?.init?.body)) as Record<string, unknown>;
    expect(forwarded).toEqual({
      contestantNumber: 7,
      contestantName: 'Seven',
      email: 'Jane.Doe@gmail.com',
      voteId: 'req-0001-aaaa',
      device: 'iPhone · Instagram',
      ip: CALLER,
    });
    expect(forwarded).not.toHaveProperty('turnstileToken');

    const row = w.script.votes()?.rows[1];
    expect(row?.[3]).toBe(CALLER);
    expect(row?.[2]).toBe('janedoe@gmail.com');
  });

  it('refuses a vote without a token, or with one Cloudflare rejects, before the sheet sees it', async () => {
    const w = world();
    for (const bad of [vote({ turnstileToken: undefined }), vote({ turnstileToken: '' }), vote({ turnstileToken: 'forged' }), vote({ turnstileToken: 42 })]) {
      const response = await relay(post(bad), ENV, w.fetch);
      expect(response.status).toBe(200);
      expect(await json(response)).toEqual({ ok: false, error: 'human_check_failed' });
    }
    expect(w.sheetCalls()).toEqual([]);
    expect(w.script.votes()).toBeUndefined();
    // Only the one string token was worth asking Cloudflare about.
    expect(w.siteverify().map((c) => c.response)).toEqual(['forged']);
  });

  it('relays the sheet\'s own refusals unchanged (duplicate, closed)', async () => {
    const w = world({ tokens: { t1: true, t2: true, t3: true } });
    await relay(post(vote({ turnstileToken: 't1' })), ENV, w.fetch);
    const again = await relay(post(vote({ turnstileToken: 't2', voteId: 'req-0002-bbbb', email: 'janedoe+x@gmail.com' })), ENV, w.fetch);
    expect(await json(again)).toEqual({ ok: true, data: { duplicate: true } });

    const late = loadAppsScript({ window: OPEN, now: () => new Date('2026-11-13T00:00:00+08:00') });
    const closed = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
      String(input) === SITEVERIFY_URL
        ? new Response(JSON.stringify({ success: true }))
        : new Response(JSON.stringify(late.doPost(String(init?.body)).json)),
    );
    expect(await json(await relay(post(vote({ turnstileToken: 't3' })), ENV, closed))).toEqual({ ok: false, error: 'voting_closed' });
  });

  it('passes the organiser key through, and nothing else the page did not mean to send', async () => {
    const w = world();
    await relay(post(vote({ adminKey: 'organiser-passcode', extra: 'dropped', ip: 'spoofed' })), ENV, w.fetch);
    const forwarded = JSON.parse(String(w.sheetCalls()[0]?.init?.body)) as Record<string, unknown>;
    expect(forwarded.adminKey).toBe('organiser-passcode');
    expect(forwarded).not.toHaveProperty('extra');
    expect(forwarded.ip).toBe(CALLER);
  });

  it('records "unavailable" when Cloudflare sends no usable address, never the page\'s value', async () => {
    const w = world();
    await relay(post(vote(), {}), ENV, w.fetch);
    expect((JSON.parse(String(w.sheetCalls()[0]?.init?.body)) as { ip: string }).ip).toBe('unavailable');
    expect(w.siteverify()[0]?.remoteip).toBeNull();
    expect(clientIp(new Request('https://x/api/vote', { headers: { 'CF-Connecting-IP': '2001:db8::1' } }))).toBe('2001:db8::1');
    expect(clientIp(new Request('https://x/api/vote', { headers: { 'CF-Connecting-IP': 'not an ip' } }))).toBe('unavailable');
  });

  it('answers "try again" (502) when Cloudflare or the sheet cannot be reached, and misconfigured without its settings', async () => {
    expect(await json(await relay(post(vote()), ENV, world({ siteverifyDown: true }).fetch))).toEqual({ ok: false, error: 'unreachable' });
    const down = world({ sheetStatus: 503 });
    const response = await relay(post(vote()), ENV, down.fetch);
    expect(response.status).toBe(502);
    expect(await json(response)).toEqual({ ok: false, error: 'unreachable' });

    for (const env of [{}, { SHEET_ENDPOINT: SHEET }, { TURNSTILE_SECRET_KEY: 'x' }, { ...ENV, SHEET_ENDPOINT: 'https://example.com/exec' }]) {
      const w = world();
      expect(await json(await relay(post(vote()), env, w.fetch))).toEqual({ ok: false, error: 'misconfigured' });
      expect(w.fetch).not.toHaveBeenCalled();
    }
  });

  it('relays a non-JSON answer as it is, so the page can say the web app is not deployed for Anyone', async () => {
    const response = await relay(post(vote()), ENV, world({ sheetHtml: true }).fetch);
    expect(response.headers.get('Content-Type')).toBe('text/html');
    expect(await response.text()).toContain('Sign in');
  });

  it('refuses junk without asking anyone', async () => {
    const w = world();
    expect(await json(await relay(post('not json'), ENV, w.fetch))).toEqual({ ok: false, error: 'invalid_vote' });
    expect(await json(await relay(post('[1,2]'), ENV, w.fetch))).toEqual({ ok: false, error: 'invalid_vote' });
    expect((await relay(post(vote({ device: 'x'.repeat(5000) })), ENV, w.fetch)).status).toBe(413);
    const put = new Request('https://x/api/vote', { method: 'PUT' });
    expect((await relay(put, ENV, w.fetch)).status).toBe(405);
    expect(w.fetch).not.toHaveBeenCalled();
  });
});

describe('/api/vote: reads', () => {
  it('passes the Contestants and tally requests through with their query string', async () => {
    const w = world();
    const contestantsAnswer = await relay(new Request('https://x/api/vote?view=contestants'), ENV, w.fetch);
    expect(await json(contestantsAnswer)).toMatchObject({ ok: true });
    expect(w.sheetCalls()[0]?.url).toBe(`${SHEET}?view=contestants`);
    expect(w.sheetCalls()[0]?.init?.method).toBe('GET');
    await relay(new Request('https://x/api/vote?key=a%20passcode'), ENV, w.fetch);
    expect(w.sheetCalls()[1]?.url).toBe(`${SHEET}?key=a%20passcode`);
  });
});

describe('the page through /api/vote', () => {
  const page = (fetch: typeof globalThis.fetch, humanToken?: () => Promise<string>) =>
    new SheetVoteStore({ endpoint: '/api/vote', contestants, window: votingWindow, rules: votingRules, fetch, humanToken });

  it('sends the token with the vote and does no IP lookup of its own', async () => {
    const w = world();
    const calls: string[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(String(input));
      return relay(new Request(`https://youtrip-lookalike-vote.pages.dev${String(input)}`, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), 'CF-Connecting-IP': CALLER } }), ENV, w.fetch);
    }) as typeof globalThis.fetch;
    const humanToken = vi.fn(async () => 'good-token');
    const receipt = await page(fetch, humanToken).castVote('c07', 'a@example.com', 'req-0001-aaaa');
    expect(receipt.contestantId).toBe('c07');
    expect(humanToken).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['/api/vote']);
    expect(w.script.votes()?.rows[1]?.[3]).toBe(CALLER);
  });

  it('shows the human-check refusal, and refuses to start without a token source', async () => {
    const w = world({ tokens: {} });
    const fetch = ((input: string | URL | Request, init?: RequestInit) =>
      relay(new Request(`https://x${String(input)}`, init), ENV, w.fetch)) as typeof globalThis.fetch;
    await expect(page(fetch, async () => 'stale').castVote('c07', 'a@example.com', 'req-0001-aaaa')).rejects.toMatchObject({ code: 'human_check_failed' });
    expect(() => page(fetch)).toThrow(/VITE_TURNSTILE_SITE_KEY/);
  });
});
