import { VoteError, isVoteErrorCode } from '../domain/errors';
import type {
  AdminSnapshot,
  AdminStatus,
  AuditRow,
  ContestantId,
  EventState,
  PublicSession,
  VoteReceipt,
} from '../domain/types';
import { parseAdminSnapshot, parseAudit, parseEventState, parseReceipt, parseSession } from './parse';
import type { VoteStore } from './VoteStore';

export interface ApiStoreOptions {
  /** Where the server function lives. '/api' when it is served from the same site. */
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Production store. Talks to the server function in server/handler.ts.
 *
 * This class holds no rules. It passes on the email the voter typed; the server
 * decides whether that email may vote, and enforces the voting window and the
 * admin passcode. A tampered page gains nothing the server would not give anyway.
 *
 * Live updates are polled by the views rather than pushed over a websocket.
 * Polling recovers from a dropped connection on its own, which suits phones
 * moving between wifi and mobile data.
 */
export class ApiVoteStore implements VoteStore {
  readonly kind = 'api' as const;
  readonly isDemo = false;

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ApiStoreOptions) {
    const baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
    if (!/^\/[^/]|^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)/.test(baseUrl)) {
      throw new VoteError(
        'misconfigured',
        'VITE_API_BASE_URL must be a path such as /api, or an https:// URL.',
      );
    }
    this.baseUrl = baseUrl;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 8000;
  }

  private async call(path: string, body: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
      });
    } catch {
      // Offline, DNS failure, dropped connection or our own timeout. All worth a retry.
      throw new VoteError('unreachable');
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429 || response.status >= 500) {
      throw new VoteError('unreachable', `Voting server answered ${response.status}.`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (!response.ok) {
        // 404 and friends with no JSON body: the function is not deployed at this path.
        throw new VoteError('misconfigured', `Voting server rejected the request (${response.status}).`);
      }
      throw new VoteError('unreachable', 'Voting server sent an unreadable response.');
    }

    if (typeof payload !== 'object' || payload === null || !('ok' in payload)) {
      throw new VoteError('misconfigured', 'Unexpected response from the voting server.');
    }
    const envelope = payload as { ok: unknown; data?: unknown; error?: unknown };
    if (envelope.ok === true) return envelope.data;
    throw new VoteError(isVoteErrorCode(envelope.error) ? envelope.error : 'misconfigured');
  }

  async getSession(): Promise<PublicSession> {
    return parseSession(await this.call('session', {}));
  }

  async castVote(
    contestantId: ContestantId,
    email: string,
    requestId: string,
    proof?: string,
  ): Promise<VoteReceipt> {
    // The email travels in the body of a POST over https: never in the address,
    // where it would end up in browser history and server access logs.
    const body: Record<string, unknown> = { contestantId, email, requestId };
    if (proof !== undefined) body.proof = proof;
    return parseReceipt(await this.call('vote', body));
  }

  async adminGetSnapshot(passcode: string): Promise<AdminSnapshot> {
    return parseAdminSnapshot(await this.call('admin/snapshot', { passcode }));
  }

  async adminGetAudit(passcode: string): Promise<AuditRow[]> {
    return parseAudit(await this.call('admin/audit', { passcode }));
  }

  async adminSetStatus(passcode: string, status: AdminStatus): Promise<EventState> {
    return parseEventState(await this.call('admin/status', { passcode, status }));
  }

  subscribe(): () => void {
    return () => undefined;
  }
}
