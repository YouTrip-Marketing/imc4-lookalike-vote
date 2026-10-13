/**
 * Supabase Edge Function adapter for the voting API.
 *
 * NOT DEPLOYED. Supabase runs Deno; `npm run build:edge`
 * bundles this file into supabase/functions/vote-api/index.js, and the tests run
 * that bundle under Node with a stand-in for the `Deno` global.
 *
 * THE CALLER'S IP ADDRESS (Revision 5, for the audit export only): read from
 * the `X-Forwarded-For` request header, counting TRUSTED_PROXY_HOPS entries
 * from the RIGHT (default 1), never the leftmost entry, which is the one a
 * caller can write. Restored from the archived one-vote-per-IP version.
 *
 * UNVERIFIED: Supabase does not document how it fills X-Forwarded-For. The only
 * source found is a maintainer's reply in supabase/supabase discussion #7884.
 * Until it has been checked on a real project, treat the recorded IPs as
 * indicative, not as proof. The IP is recorded, never enforced: a missing or odd
 * header is recorded as '' and the vote is counted as normal.
 */
import { createHandlerFromEnv, notConfigured, trustedHops } from '../env';
import type { ApiHandler } from '../handler';
import { forwardedClientIp } from '../clientIp';

/** The parts of the Deno runtime this file uses. */
declare const Deno: {
  env: { toObject(): Record<string, string> };
  serve(handler: (request: Request) => Response | Promise<Response>): unknown;
};

let handler: ApiHandler | null = null;
let hops = 1;

Deno.serve(async (request) => {
  try {
    if (handler === null) {
      const env = Deno.env.toObject();
      hops = trustedHops(env);
      handler = createHandlerFromEnv(env);
    }
  } catch (error) {
    return notConfigured(error);
  }
  return handler(request, {
    clientIp: forwardedClientIp(request.headers.get('x-forwarded-for'), hops),
  });
});
