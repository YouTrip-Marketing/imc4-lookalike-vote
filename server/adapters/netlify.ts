/**
 * Netlify Functions adapter for the voting API (the current format: a
 * web-standard Request in, a Response out).
 *
 * NOT DEPLOYED, and never run on Netlify. ALTERNATIVE deployment: the primary
 * path is GitHub Pages + Supabase.
 *
 * THE CALLER'S IP ADDRESS (Revision 5, for the audit export only): `context.ip`,
 * the second argument Netlify passes to the function, described in Netlify's
 * reference as "A string containing the client IP address". Restored from the
 * archived one-vote-per-IP version. UNVERIFIED whether a caller can influence
 * it. This file reads no address-looking header itself.
 *
 * The IP is recorded, never enforced: if `context.ip` is missing, the vote is
 * counted as normal and the audit record holds ''.
 */
import { createHandlerFromEnv, notConfigured } from '../env';
import type { ApiHandler } from '../handler';

/** The part of Netlify's context object this function relies on. */
export interface NetlifyContext {
  ip?: string;
}

let handler: ApiHandler | null = null;

export async function netlifyFunction(request: Request, context: NetlifyContext = {}): Promise<Response> {
  try {
    handler ??= createHandlerFromEnv(process.env);
  } catch (error) {
    return notConfigured(error);
  }
  return handler(request, { clientIp: context.ip });
}
