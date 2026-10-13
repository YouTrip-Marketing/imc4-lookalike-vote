import { canonicalEmail } from '../src/domain/email';
import { VoteError, isVoteErrorCode, toVoteError, type VoteErrorCode } from '../src/domain/errors';
import type { VoterIdentityResolver } from '../src/domain/identity';
import { recordableIp } from './clientIp';
import type { Database } from './database';

/**
 * The voting API, written against the web-standard Request and Response so the
 * same code runs on Supabase Edge Functions, Netlify Functions, Cloudflare or
 * plain Node. Each platform has a thin adapter in server/adapters/ that hands
 * this handler the request and the caller's IP address as that platform
 * reports it.
 *
 *   POST .../session          where voting stands
 *   POST .../vote             { contestantId, email, requestId }
 *   POST .../admin/snapshot   { passcode }                 no personal data
 *   POST .../admin/audit      { passcode }                 CONFIDENTIAL: emails and IPs
 *   POST .../admin/status     { passcode, status }
 *
 * Routes are matched on the END of the path, so the API works wherever a
 * platform mounts it: /api/vote, /vote-api/vote, /functions/v1/vote-api/vote.
 *
 * Every answer is HTTP 200 with {ok: true, data} or {ok: false, error: code},
 * except for requests that are not part of the API at all (403, 404, 405, 413).
 *
 * What this layer is for: it hashes the voter's email for the uniqueness check,
 * holds the two secrets (hashing secret, admin passcode), and hands the
 * readable email and the IP address to the database's AUDIT table (Revision 5,
 * Kelicia's decision of 2026-09-29). The voting rules are enforced in the database.
 *
 * THE IP ADDRESS IS RECORDED, NEVER ENFORCED. Nothing here blocks, limits or
 * delays a vote because of it, and a missing IP never rejects a vote.
 *
 * Readable emails and IPs leave this layer only in the admin/audit answer.
 * They are never logged, and never in any other response.
 */

export const MIN_PASSCODE_LENGTH = 12;
const MAX_BODY_BYTES = 4096;
const ROUTE = /\/(session|vote|admin\/snapshot|admin\/audit|admin\/status)\/?$/;

/**
 * Seam for bot protection. Not used in this draft. For launch, implement it with
 * a CAPTCHA-style check (for example Cloudflare Turnstile): the page sends the
 * widget's response in the body, and this verifies it with the provider.
 */
export type HumanCheck = (body: Record<string, unknown>) => Promise<boolean>;

export interface ApiHandlerOptions {
  database: Database;
  identity: VoterIdentityResolver;
  /** ADMIN_PASSCODE. Admin routes answer `misconfigured` if it is shorter than MIN_PASSCODE_LENGTH. */
  adminPasscode: string;
  /**
   * The sites allowed to call this API from a browser, as exact origins
   * (scheme + host + port, no path), e.g. ['https://youtrip-marketing.github.io'].
   *
   * Empty means same-origin only: no cross-origin permission is ever granted.
   * There is deliberately no wildcard. '*' is refused.
   */
  allowedOrigins?: readonly string[];
  humanCheck?: HumanCheck;
}

/** What the hosting platform told its adapter about the caller. */
export interface PlatformContext {
  /**
   * The caller's IP address as reported by the platform, never a value this
   * code reads from a header or body itself. Recorded for the audit export only.
   */
  clientIp?: string | null;
}

export type ApiHandler = (request: Request, platform?: PlatformContext) => Promise<Response>;

const BASE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

/** Exact origins only: 'https://host' or 'https://host:port'. No paths, no wildcards. */
export function parseAllowedOrigins(value: string | undefined): string[] {
  const origins = (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');
  for (const origin of origins) {
    if (origin.includes('*')) {
      throw new VoteError(
        'misconfigured',
        `ALLOWED_ORIGINS: "${origin}" is a wildcard. List each site's origin in full.`,
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new VoteError('misconfigured', `ALLOWED_ORIGINS: "${origin}" is not an origin.`);
    }
    const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (parsed.origin !== origin || (parsed.protocol !== 'https:' && !local)) {
      throw new VoteError(
        'misconfigured',
        `ALLOWED_ORIGINS: "${origin}" must be an https origin with no path, like https://example.github.io`,
      );
    }
  }
  return origins;
}

/** Compares without stopping at the first difference, so timing says nothing about the passcode. */
function sameText(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function readBody(request: Request): Promise<Record<string, unknown> | 'too_large' | null> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return 'too_large';
  if (text.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isRefused(answer: unknown): boolean {
  return !(typeof answer === 'object' && answer !== null && (answer as { ok?: unknown }).ok === true);
}

export function createApiHandler(options: ApiHandlerOptions): ApiHandler {
  const { database, identity } = options;
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  if (allowedOrigins.has('*')) {
    throw new VoteError('misconfigured', 'A wildcard origin is not allowed. List the site origins.');
  }
  const allowedHeaders = 'content-type, accept';

  return async (request, platform = {}) => {
    const origin = request.headers.get('origin');
    const url = new URL(request.url);
    // A browser calling from the API's own site also sends Origin on a POST.
    const sameOrigin = origin !== null && origin === url.origin;
    const crossOriginAllowed = origin !== null && allowedOrigins.has(origin);

    // Permission is granted to the one origin that asked, and only if it is on the list.
    const cors: Record<string, string> = crossOriginAllowed
      ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
      : { Vary: 'Origin' };

    const json = (status: number, body: unknown): Response =>
      new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...cors } });
    const fail = (code: VoteErrorCode): Response => json(200, { ok: false, error: code });
    /** Passes the database's own envelope through, after checking it is one. */
    const relay = (answer: unknown): Response => {
      if (typeof answer === 'object' && answer !== null && 'ok' in answer) {
        const envelope = answer as { ok: unknown; data?: unknown; error?: unknown };
        if (envelope.ok === true) return json(200, { ok: true, data: envelope.data });
        return fail(isVoteErrorCode(envelope.error) ? envelope.error : 'misconfigured');
      }
      return fail('misconfigured');
    };

    const match = ROUTE.exec(url.pathname);
    if (match === null) return json(404, { ok: false, error: 'not_found' });
    const route = match[1];

    // A request from a browser on some other site. Refused before anything else happens.
    if (origin !== null && !sameOrigin && !crossOriginAllowed) {
      return json(403, { ok: false, error: 'forbidden_origin' });
    }

    if (request.method === 'OPTIONS') {
      // The browser asking permission before a cross-origin POST.
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': allowedHeaders,
          'Access-Control-Max-Age': '86400',
          'Cache-Control': 'no-store',
        },
      });
    }
    if (request.method !== 'POST') {
      return json(405, { ok: false, error: 'method_not_allowed' });
    }

    const body = await readBody(request);
    if (body === 'too_large') return json(413, { ok: false, error: 'too_large' });
    if (body === null) return fail('invalid_vote');

    try {
      if (route === 'session') {
        return relay(await database.rpc('get_session', {}));
      }

      if (route === 'vote') {
        const { contestantId, requestId } = body;
        if (typeof contestantId !== 'string' || typeof requestId !== 'string') {
          return fail('invalid_vote');
        }
        if (options.humanCheck !== undefined) {
          const human = await options.humanCheck(body);
          if (!human) return fail('invalid_vote');
        }
        // The hash decides uniqueness. The readable forms go only to the audit table.
        const { voterKey } = await identity.resolve({ email: body.email, proof: body.proof });
        const typed = typeof body.email === 'string' ? body.email.trim() : '';
        return relay(
          await database.rpc('cast_vote', {
            p_voter_key: voterKey,
            p_contestant_id: contestantId,
            p_request_id: requestId,
            p_email_typed: typed,
            p_email_normalised: canonicalEmail(body.email) ?? '',
            // '' when the platform reported nothing usable. Never a reason to refuse.
            p_ip: recordableIp(platform.clientIp),
          }),
        );
      }

      // Admin routes. Throttle first, so a guesser learns nothing once over the limit.
      const gate = await database.rpc('admin_gate', {});
      if (isRefused(gate)) return relay(gate);

      if (options.adminPasscode.length < MIN_PASSCODE_LENGTH) {
        // Fail closed: a missing or weak passcode disables the admin view, it does not open it.
        return fail('misconfigured');
      }
      const passcode = typeof body.passcode === 'string' ? body.passcode : '';
      if (!sameText(passcode, options.adminPasscode)) {
        await database.rpc('admin_failed', {});
        return fail('bad_passcode');
      }

      if (route === 'admin/snapshot') {
        return relay(await database.rpc('admin_snapshot', {}));
      }
      if (route === 'admin/audit') {
        return relay(await database.rpc('admin_audit', {}));
      }
      const status = typeof body.status === 'string' ? body.status : null;
      return relay(await database.rpc('admin_set_status', { p_status: status }));
    } catch (error) {
      const voteError = error instanceof VoteError ? error : toVoteError(error);
      // The message stays in the server log. The caller gets the code only.
      // No message in this codebase contains an email or IP address, so none is logged.
      console.error(`[vote-api] ${route}: ${voteError.code}: ${voteError.message}`);
      return fail(voteError.code);
    }
  };
}
