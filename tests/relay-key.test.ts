import { describe, expect, it, vi } from 'vitest';
import { SITEVERIFY_URL, relay, type Env } from '../functions/api/vote';
import { loadAppsScript, type AppsScriptRun } from '../scripts/apps-script-harness';

/**
 * Revision 16: the shared key between /api/vote and Code.gs. Once the RELAY_KEY
 * Script Property is set, the sheet takes votes only from the relay (which adds
 * the key from its RELAY_KEY secret), so nobody can skip the Turnstile check by
 * posting to the /exec address directly.
 */

const KEY = 'relay-key-for-unit-tests-0123456789abcdef';
const OPEN = { opensAt: '2026-10-26T00:00:00+08:00', closesAt: '2026-11-12T23:59:00+08:00' };
const NOW = new Date('2026-11-08T12:00:00+08:00');
const SHEET = 'https://script.google.com/macros/s/AKfycbRELAY_key-123/exec';

const script = (relayKey?: string): AppsScriptRun =>
  loadAppsScript({ window: OPEN, now: () => NOW, ...(relayKey === undefined ? {} : { relayKey }), contestants: [[1, 'One', '', '', '']] });

const ballot = (extra: Record<string, unknown> = {}) => ({
  contestantNumber: 2,
  contestantName: 'Two',
  email: 'fan@example.com',
  voteId: 'vote-key-0001',
  device: 'x',
  ip: 'unavailable',
  ...extra,
});

describe('Code.gs: votes only from the relay once RELAY_KEY is set', () => {
  it('not set: a vote without a key is accepted, as before (rollout step)', () => {
    expect(script().doPost(JSON.stringify(ballot())).json).toMatchObject({ ok: true, data: { duplicate: false } });
  });

  it('set: no key, an empty key or a wrong key is refused as misconfigured, and nothing is written', () => {
    const run = script(KEY);
    for (const relayKey of [undefined, '', 'wrong', KEY.slice(0, -1), 42]) {
      expect(run.doPost(JSON.stringify(ballot({ relayKey }))).json).toEqual({ ok: false, error: 'misconfigured' });
    }
    expect(run.votes()?.rows.length ?? 0).toBe(0);
  });

  it('set: the right key is accepted, and the key is never written to the sheet', () => {
    const run = script(KEY);
    expect(run.doPost(JSON.stringify(ballot({ relayKey: KEY }))).json).toMatchObject({ ok: true, data: { duplicate: false } });
    expect(JSON.stringify(run.votes()?.rows)).not.toContain(KEY);
  });

  it('reads are not affected: the contestants view and the status still answer without a key', () => {
    const run = script(KEY);
    expect(run.doGet(undefined, 'contestants').json).toMatchObject({ ok: true });
    expect(run.doGet(undefined, 'status').json).toEqual({ ok: true, data: { closedNow: false } });
  });
});

/** Cloudflare siteverify (every token passes) in front of the harness. */
function through(run: AppsScriptRun) {
  const forwarded: Record<string, unknown>[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === SITEVERIFY_URL) return new Response(JSON.stringify({ success: true }), { status: 200 });
    if (!url.startsWith(SHEET)) throw new Error(`unexpected request to ${url}`);
    forwarded.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(run.doPost(String(init?.body)).json), { status: 200 });
  });
  return { fetch, forwarded };
}

const post = (body: unknown): Request =>
  new Request('https://youtrip-lookalike-vote.pages.dev/api/vote', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8', 'CF-Connecting-IP': '203.0.113.9' },
    body: JSON.stringify(body),
  });

const env = (relayKey?: string): Env => ({
  SHEET_ENDPOINT: SHEET,
  TURNSTILE_SECRET_KEY: 'unit-test-secret',
  ...(relayKey === undefined ? {} : { RELAY_KEY: relayKey }),
});

describe('/api/vote adds the key from its secret', () => {
  it('with RELAY_KEY set on both sides, a vote through the relay is counted', async () => {
    const { fetch, forwarded } = through(script(KEY));
    const answer = await (await relay(post(ballot({ turnstileToken: 'ok' })), env(KEY), fetch, undefined)).json();
    expect(answer).toMatchObject({ ok: true, data: { duplicate: false } });
    expect(forwarded[0]?.relayKey).toBe(KEY);
    expect(forwarded[0]).not.toHaveProperty('turnstileToken');
  });

  it('never forwards a key the page put in its own body', async () => {
    const { fetch, forwarded } = through(script());
    await relay(post(ballot({ turnstileToken: 'ok', relayKey: 'from-the-page' })), env(), fetch, undefined);
    expect(forwarded[0]).not.toHaveProperty('relayKey');
    const second = through(script(KEY));
    await relay(post(ballot({ turnstileToken: 'ok', relayKey: 'from-the-page' })), env(KEY), second.fetch, undefined);
    expect(second.forwarded[0]?.relayKey).toBe(KEY);
  });

  it('rollout order: the secret first is harmless; the Script Property first stops every vote', async () => {
    // 1. Pages secret set, Script Property not yet: votes still counted.
    const first = through(script());
    expect(await (await relay(post(ballot({ turnstileToken: 'ok' })), env(KEY), first.fetch, undefined)).json()).toMatchObject({ ok: true });
    // The wrong way round: property set, relay without the secret, every vote refused.
    const wrong = through(script(KEY));
    expect(await (await relay(post(ballot({ turnstileToken: 'ok' })), env(), wrong.fetch, undefined)).json()).toEqual({
      ok: false,
      error: 'misconfigured',
    });
  });
});
