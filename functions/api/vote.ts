/**
 * Cloudflare Pages Function at /api/vote: since 6 Nov 2026 the only way the
 * page reaches the Google Apps Script web app (apps-script/Code.gs).
 *
 *   POST /api/vote            a vote. Needs a Cloudflare Turnstile token
 *                             (`turnstileToken` in the JSON body), checked
 *                             with Cloudflare before anything is forwarded.
 *   GET  /api/vote?view=...   the Contestants tab and the organiser tally,
 *                             passed through as they are (Code.gs checks the
 *                             passcode itself).
 *
 * What it changes about a vote, and nothing else:
 *   - a vote without a token Cloudflare accepts is refused as
 *     human_check_failed and never reaches the sheet;
 *   - `ip` is the address Cloudflare saw the request come from
 *     (CF-Connecting-IP); the page's own value is dropped;
 *   - only the fields Code.gs reads are forwarded; the token is not.
 * The sheet's answer ({ok, data: {duplicate...}} or {ok: false, error}) is
 * relayed unchanged, so the page's error handling is the same as before.
 *
 * Settings (Pages project > Settings > Variables and Secrets, Production):
 *   SHEET_ENDPOINT        the Apps Script web app address (.../exec)
 *   TURNSTILE_SECRET_KEY  the Turnstile secret for the site key in the bundle
 * Both missing or wrong answer `misconfigured`; nothing falls back to the
 * sheet directly.
 *
 * Wrangler bundles this folder when `wrangler pages deploy dist-prod-cf` runs
 * from the repository root (.github/workflows/deploy-cloudflare-pages.yml).
 */

export interface Env {
  SHEET_ENDPOINT?: string;
  TURNSTILE_SECRET_KEY?: string;
}

/** The part of Cloudflare's Pages Function context this file uses. */
interface PagesContext {
  request: Request;
  env: Env;
}

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const SHEET_ENDPOINT =
  /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/\S*$/;
const MAX_BODY_BYTES = 4096;
const MAX_TOKEN_LENGTH = 2048;
const UPSTREAM_TIMEOUT_MS = 20_000;

const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

/** The caller's address as Cloudflare reports it, or 'unavailable' (never a header the caller controls). */
export function clientIp(request: Request): string {
  const ip = (request.headers.get('CF-Connecting-IP') ?? '').trim();
  return /^[0-9A-Fa-f:.]{3,45}$/.test(ip) && /[.:]/.test(ip) ? ip : 'unavailable';
}

/** Asks Cloudflare whether the token is a real, unused Turnstile answer. */
async function verifyTurnstile(
  fetchImpl: typeof fetch,
  secret: string,
  token: string,
  ip: string,
): Promise<'ok' | 'failed' | 'unreachable'> {
  const form = new URLSearchParams({ secret, response: token });
  if (ip !== 'unavailable') form.set('remoteip', ip);
  let response: Response;
  try {
    response = await fetchImpl(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return 'unreachable';
  }
  if (!response.ok) return 'unreachable';
  try {
    const result = (await response.json()) as { success?: unknown };
    return result.success === true ? 'ok' : 'failed';
  } catch {
    return 'unreachable';
  }
}

/** Sends the request on to Apps Script and relays its answer. */
async function forward(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetchImpl(url, { ...init, redirect: 'follow', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch {
    return answer({ ok: false, error: 'unreachable' }, 502);
  }
  // 429 and 5xx stay as a 502: the page treats those as "try again" (sheetStore.request).
  if (upstream.status === 429 || upstream.status >= 500) return answer({ ok: false, error: 'unreachable' }, 502);
  const text = await upstream.text();
  // Relayed as it is, JSON or not: the page already reads Apps Script's answers
  // (an HTML page means the web app is not deployed for "Anyone").
  return new Response(text, {
    status: 200,
    headers: { ...HEADERS, 'Content-Type': upstream.headers.get('Content-Type') ?? HEADERS['Content-Type'] },
  });
}

export async function relay(request: Request, env: Env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const endpoint = (env.SHEET_ENDPOINT ?? '').trim();
  const secret = (env.TURNSTILE_SECRET_KEY ?? '').trim();
  if (!SHEET_ENDPOINT.test(endpoint) || secret === '') return answer({ ok: false, error: 'misconfigured' });

  if (request.method === 'GET') {
    return forward(fetchImpl, `${endpoint}${new URL(request.url).search}`, { method: 'GET' });
  }
  if (request.method !== 'POST') return answer({ ok: false, error: 'invalid_vote' }, 405);

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return answer({ ok: false, error: 'invalid_vote' }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return answer({ ok: false, error: 'invalid_vote' });
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return answer({ ok: false, error: 'invalid_vote' });
  const vote = body as Record<string, unknown>;

  const token = vote.turnstileToken;
  if (typeof token !== 'string' || token.trim() === '' || token.length > MAX_TOKEN_LENGTH) {
    return answer({ ok: false, error: 'human_check_failed' });
  }
  const ip = clientIp(request);
  const verdict = await verifyTurnstile(fetchImpl, secret, token.trim(), ip);
  if (verdict === 'unreachable') return answer({ ok: false, error: 'unreachable' }, 502);
  if (verdict === 'failed') return answer({ ok: false, error: 'human_check_failed' });

  // Only what Code.gs reads. Code.gs validates each value itself.
  const payload: Record<string, unknown> = {
    contestantNumber: vote.contestantNumber,
    contestantName: vote.contestantName,
    email: vote.email,
    voteId: vote.voteId,
    device: vote.device,
    ip,
  };
  if (typeof vote.adminKey === 'string') payload.adminKey = vote.adminKey;

  return forward(fetchImpl, endpoint, {
    method: 'POST',
    // text/plain, as the page sent to Apps Script directly: no preflight, and Code.gs reads e.postData.contents.
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
  });
}

export const onRequestGet = (context: PagesContext): Promise<Response> => relay(context.request, context.env);
export const onRequestPost = (context: PagesContext): Promise<Response> => relay(context.request, context.env);
export const onRequest = (context: PagesContext): Promise<Response> => relay(context.request, context.env);
