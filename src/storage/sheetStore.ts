import { contestants as configuredContestants, demo, votingRules, votingWindow } from '../../event.config';
import { canonicalEmail } from '../domain/email';
import { VoteError, isVoteErrorCode } from '../domain/errors';
import type {
  AdminSnapshot,
  AdminVoteRow,
  AuditRow,
  Contestant,
  ContestantId,
  EventState,
  PublicSession,
  Tally,
  VoteReceipt,
  VotingRules,
  VotingWindow,
} from '../domain/types';
import type { VoteStore } from './VoteStore';

/**
 * TEST SITE store (VITE_STORAGE_ADAPTER=sheet). Sends each vote to a Google
 * Apps Script web app bound to a Google Sheet (apps-script/Code.gs), which
 * appends it as a row. For Kelicia to watch votes land while testing on a phone.
 *
 * NOT FOR THE REAL VOTE:
 *   - voting is always open: the configured window is shown, not enforced;
 *   - the sheet holds readable emails, with no audit table or retention rule;
 *   - the admin passcode is the demo one, checked in the page.
 * `npm run check:deploy` refuses this build, like the demo.
 *
 * Requests go as text/plain so the browser sends them without a CORS
 * preflight, which Apps Script web apps cannot answer.
 */

export interface SheetStoreOptions {
  /** The web app's /exec address. */
  endpoint: string;
  contestants: readonly Pick<Contestant, 'id' | 'number' | 'stageName'>[];
  window: VotingWindow;
  rules: VotingRules;
  passcode: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
  /** The browser's user agent, shortened to a device label for the sheet. */
  userAgent?: string;
}

/** What the Votes tab's GET answer holds for one vote. No email. */
interface SheetVote {
  n: number;
  no: number;
  at: string;
  ref: string;
}

const ENDPOINT_PATTERN =
  /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/\S*$/;

/** "iPhone · Instagram", "Android · Chrome", "Mac · Safari". Nothing more specific. */
export function deviceLabel(userAgent: string): string {
  const ua = userAgent;
  const device = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Macintosh|Mac OS X/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Other';
  const browser = /Instagram/.test(ua)
    ? 'Instagram'
    : /FBAN|FBAV/.test(ua)
      ? 'Facebook'
      : /TikTok|musical_ly|BytedanceWebview/.test(ua)
        ? 'TikTok'
        : /SamsungBrowser/.test(ua)
          ? 'Samsung Internet'
          : /Edg\//.test(ua)
            ? 'Edge'
            : /Firefox|FxiOS/.test(ua)
              ? 'Firefox'
              : /Chrome|CriOS/.test(ua)
                ? 'Chrome'
                : /Safari/.test(ua)
                  ? 'Safari'
                  : 'Other';
  return `${device} · ${browser}`;
}

export class SheetVoteStore implements VoteStore {
  readonly kind = 'sheet' as const;
  /** Shows the TEST SITE banner. */
  readonly isDemo = true;

  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly device: string;
  private readonly byId: Map<ContestantId, Pick<Contestant, 'id' | 'number' | 'stageName'>>;
  private readonly byNumber: Map<number, ContestantId>;

  constructor(private readonly options: SheetStoreOptions) {
    const endpoint = options.endpoint.trim();
    if (!ENDPOINT_PATTERN.test(endpoint)) {
      throw new VoteError(
        'misconfigured',
        'VITE_SHEET_ENDPOINT must be the Apps Script web app address ending in /exec.',
      );
    }
    this.endpoint = endpoint;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    // Apps Script often takes a few seconds on the first request after a quiet spell.
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.now = options.now ?? (() => new Date());
    this.device = deviceLabel(options.userAgent ?? '');
    this.byId = new Map(options.contestants.map((c) => [c.id, c]));
    this.byNumber = new Map(options.contestants.map((c) => [c.number, c.id]));
  }

  private state(): EventState {
    return {
      status: 'open',
      adminStatus: 'open',
      opensAt: this.options.window.opensAt,
      closesAt: this.options.window.closesAt,
      // The sheet keeps the first vote per email and never replaces it.
      allowVoteChange: false,
      publicCounts: this.options.rules.publicCounts,
      serverTime: this.now().toISOString(),
    };
  }

  private async request(init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        ...init,
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'follow',
      });
    } catch {
      throw new VoteError('unreachable');
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 429 || response.status >= 500) {
      throw new VoteError('unreachable', `The sheet answered ${response.status}.`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      // Apps Script answers an HTML page when the web app is not deployed for "Anyone".
      throw new VoteError('misconfigured', 'The sheet did not answer with JSON. Check the web app is deployed for Anyone.');
    }
    if (typeof payload !== 'object' || payload === null || !('ok' in payload)) {
      throw new VoteError('misconfigured', 'Unexpected answer from the sheet.');
    }
    const envelope = payload as { ok: unknown; data?: unknown; error?: unknown };
    if (envelope.ok === true) return envelope.data;
    // 'busy': another vote held the sheet's lock for 10 seconds. Worth a retry.
    if (envelope.error === 'busy') throw new VoteError('unreachable', 'The sheet was busy.');
    throw new VoteError(isVoteErrorCode(envelope.error) ? envelope.error : 'misconfigured');
  }

  private async readVotes(): Promise<{ takenAt: string; votes: SheetVote[] }> {
    const data = await this.request({ method: 'GET' });
    if (typeof data !== 'object' || data === null || !Array.isArray((data as { votes?: unknown }).votes)) {
      throw new VoteError('misconfigured', 'Unexpected answer from the sheet.');
    }
    const { takenAt, votes } = data as { takenAt?: unknown; votes: unknown[] };
    const parsed = votes.filter(
      (vote): vote is SheetVote =>
        typeof vote === 'object' &&
        vote !== null &&
        typeof (vote as SheetVote).n === 'number' &&
        typeof (vote as SheetVote).no === 'number' &&
        typeof (vote as SheetVote).at === 'string' &&
        typeof (vote as SheetVote).ref === 'string',
    );
    return { takenAt: typeof takenAt === 'string' ? takenAt : this.now().toISOString(), votes: parsed };
  }

  private tallies(votes: readonly SheetVote[]): Tally[] {
    const counts = new Map<ContestantId, number>(this.options.contestants.map((c) => [c.id, 0]));
    for (const vote of votes) {
      const id = this.byNumber.get(vote.no);
      if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return [...counts].map(([contestantId, count]) => ({ contestantId, votes: count }));
  }

  async getSession(): Promise<PublicSession> {
    // Counts cost a request to the sheet, so they are fetched only when shown.
    if (!this.options.rules.publicCounts) return { state: this.state(), tallies: null };
    const { votes } = await this.readVotes();
    return { state: this.state(), tallies: this.tallies(votes) };
  }

  async castVote(contestantId: ContestantId, email: string, requestId: string): Promise<VoteReceipt> {
    const contestant = this.byId.get(contestantId);
    if (contestant === undefined) throw new VoteError('invalid_vote');
    if (canonicalEmail(email) === null) throw new VoteError('invalid_email');

    const data = await this.request({
      method: 'POST',
      // text/plain: a "simple" request, so no preflight (see the class comment).
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        contestantNumber: contestant.number,
        contestantName: contestant.stageName,
        email: email.trim(),
        voteId: requestId,
        device: this.device,
      }),
    });
    const answer = (typeof data === 'object' && data !== null ? data : {}) as {
      duplicate?: unknown;
      castAt?: unknown;
    };
    if (answer.duplicate === true) throw new VoteError('duplicate_vote');
    if (answer.duplicate !== false) throw new VoteError('misconfigured', 'Unexpected answer from the sheet.');
    return {
      contestantId,
      castAt: typeof answer.castAt === 'string' && answer.castAt !== '' ? answer.castAt : this.now().toISOString(),
      replaced: false,
      session: await this.getSession(),
    };
  }

  async adminGetSnapshot(passcode: string): Promise<AdminSnapshot> {
    if (passcode !== this.options.passcode) throw new VoteError('bad_passcode');
    const { takenAt, votes } = await this.readVotes();
    const rows: AdminVoteRow[] = [];
    for (const vote of votes) {
      const contestantId = this.byNumber.get(vote.no);
      if (contestantId === undefined) continue;
      rows.push({ id: vote.n, contestantId, castAt: vote.at, replacedAt: null, voterRef: vote.ref });
    }
    rows.sort((a, b) => a.castAt.localeCompare(b.castAt) || a.id - b.id);
    return { state: this.state(), takenAt, votes: rows, sharedAddresses: [] };
  }

  async adminGetAudit(passcode: string): Promise<AuditRow[]> {
    if (passcode !== this.options.passcode) throw new VoteError('bad_passcode');
    throw new VoteError('misconfigured', 'Test site: the emails are in the Google Sheet.');
  }

  async adminSetStatus(passcode: string): Promise<EventState> {
    if (passcode !== this.options.passcode) throw new VoteError('bad_passcode');
    throw new VoteError('misconfigured', 'Test site: voting stays open.');
  }

  subscribe(): () => void {
    return () => undefined;
  }
}

/** Wires the sheet store to event.config.ts. */
export function createSheetStore(endpoint: string): SheetVoteStore {
  return new SheetVoteStore({
    endpoint,
    contestants: configuredContestants,
    window: votingWindow,
    rules: votingRules,
    passcode: demo.passcode,
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
  });
}
