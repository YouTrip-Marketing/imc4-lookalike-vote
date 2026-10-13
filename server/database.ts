import { VoteError } from '../src/domain/errors';

/** The database functions the server may call, and the arguments each one takes. */
export const RPC_SIGNATURES = {
  get_session: [],
  cast_vote: [
    'p_voter_key',
    'p_contestant_id',
    'p_request_id',
    'p_email_typed',
    'p_email_normalised',
    'p_ip',
  ],
  admin_gate: [],
  admin_failed: [],
  admin_snapshot: [],
  admin_audit: [],
  admin_set_status: ['p_status'],
} as const;

export type RpcName = keyof typeof RPC_SIGNATURES;
export type RpcArgs<N extends RpcName> = Record<(typeof RPC_SIGNATURES)[N][number], string | null>;

/**
 * Where the rules live. One method, so swapping Postgres hosts (or putting an
 * embedded Postgres behind it for tests) means writing one small function.
 * Resolves to the function's JSON answer: {ok: true, data} or {ok: false, error}.
 */
export interface Database {
  rpc<N extends RpcName>(name: N, args: RpcArgs<N>): Promise<unknown>;
}

export interface PostgrestOptions {
  /** e.g. https://<project>.supabase.co */
  url: string;
  /** The SECRET service key. Server-side only. Never a VITE_ variable. */
  serviceKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Calls the functions in supabase/schema.sql over PostgREST, as Supabase exposes them. */
export function createPostgrestDatabase(options: PostgrestOptions): Database {
  const url = options.url.trim().replace(/\/+$/, '');
  if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)/.test(url)) {
    throw new VoteError('misconfigured', 'SUPABASE_URL must be an https:// URL.');
  }
  const serviceKey = options.serviceKey.trim();
  if (serviceKey === '') {
    throw new VoteError('misconfigured', 'SUPABASE_SERVICE_ROLE_KEY is missing.');
  }
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 6000;

  return {
    async rpc(name, args) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(`${url}/rest/v1/rpc/${name}`, {
          method: 'POST',
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(args),
          signal: controller.signal,
        });
      } catch {
        throw new VoteError('unreachable', 'The database could not be reached.');
      } finally {
        clearTimeout(timer);
      }

      if (response.status === 429 || response.status >= 500) {
        throw new VoteError('unreachable', `The database answered ${response.status}.`);
      }
      if (!response.ok) {
        // 401/403/404: wrong key, wrong project, or schema.sql not applied.
        throw new VoteError('misconfigured', `The database rejected the call (${response.status}).`);
      }
      try {
        return (await response.json()) as unknown;
      } catch {
        throw new VoteError('unreachable', 'The database sent an unreadable response.');
      }
    },
  };
}
