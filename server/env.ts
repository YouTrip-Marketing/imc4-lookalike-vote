import { event } from '../event.config';
import { VoteError } from '../src/domain/errors';
import { createPostgrestDatabase } from './database';
import { createApiHandler, parseAllowedOrigins, type ApiHandler } from './handler';
import { createEmailIdentityResolver } from './identity';

export type ServerEnv = Readonly<Record<string, string | undefined>>;

/**
 * Builds the production handler from environment variables. The same on every platform.
 *
 *   SUPABASE_URL               https://<project>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY  the SECRET service key
 *                              (both are provided automatically inside a Supabase Edge Function)
 *   DB_SERVICE_KEY             optional: used instead of SUPABASE_SERVICE_ROLE_KEY if set
 *   VOTER_HASH_SECRET          32+ random characters, new for each event
 *   ADMIN_PASSCODE             12+ characters
 *   ALLOWED_ORIGINS            the site's origin(s), comma-separated,
 *                              e.g. https://youtrip-marketing.github.io
 *
 * None of these is a VITE_ variable, on purpose: anything prefixed VITE_ is
 * baked into the public bundle. Throws VoteError('misconfigured') if one is
 * missing, so a half-configured deployment refuses to take votes.
 */
/**
 * TRUSTED_PROXY_HOPS: how many X-Forwarded-For entries, counted from the RIGHT,
 * the platform itself adds (Supabase adapter). A whole number from 1 to 5,
 * default 1. Restored from the archived IP version, with one change: a bad value
 * no longer stops the API. The IP is only recorded, so a typo here must never
 * cost a vote; it falls back to 1 and says so in the log.
 */
export function trustedHops(env: ServerEnv): number {
  const raw = env.TRUSTED_PROXY_HOPS;
  if (raw === undefined || raw.trim() === '') return 1;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    console.error('[vote-api] TRUSTED_PROXY_HOPS must be a whole number from 1 to 5. Using 1.');
    return 1;
  }
  return value;
}

export function createHandlerFromEnv(env: ServerEnv): ApiHandler {
  return createApiHandler({
    database: createPostgrestDatabase({
      url: env.SUPABASE_URL ?? '',
      serviceKey: env.DB_SERVICE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    }),
    // Unverified email. To require a one-time code, swap this one line for a
    // verifying resolver: see server/identity.ts.
    identity: createEmailIdentityResolver({
      secret: env.VOTER_HASH_SECRET ?? '',
      eventId: event.id,
    }),
    adminPasscode: env.ADMIN_PASSCODE ?? '',
    allowedOrigins: parseAllowedOrigins(env.ALLOWED_ORIGINS),
  });
}

/** What to answer when the function cannot even start. Says nothing about why. */
export function notConfigured(error: unknown): Response {
  const message = error instanceof VoteError ? error.message : 'unknown error';
  console.error(`[vote-api] not configured: ${message}`);
  return new Response(JSON.stringify({ ok: false, error: 'misconfigured' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
