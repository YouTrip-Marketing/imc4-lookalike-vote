import { contestants as configuredContestants, votingRules, votingWindow } from '../../event.config';
import { canonicalEmail } from '../domain/email';
import { VoteError, isVoteErrorCode } from '../domain/errors';
import { effectiveStatus } from '../domain/voting';
import { turnstileToken } from '../turnstile';
import type {
  AdminSnapshot,
  AdminVoteRow,
  AuditRow,
  Contestant,
  ContestantDetails,
  ContestantId,
  ContestantList,
  EventState,
  PublicSession,
  VoteReceipt,
  VotingRules,
  VotingWindow,
} from '../domain/types';
import type { VoteStore } from './VoteStore';

/**
 * Google Sheet store (VITE_STORAGE_ADAPTER=sheet). Sends each vote to a Google
 * Apps Script web app bound to Kelicia's private sheet (apps-script/Code.gs),
 * which appends it as a row. The production vote store from 26 Oct 2026.
 *
 *   Production (default): no banner; the voting window from event.config.ts is
 *     shown and honoured here, and enforced again by Code.gs. The admin
 *     passcode is checked by Code.gs (doGet ?key=...), never by this page, so
 *     it is not in the bundle.
 *   Test (testMode, VITE_TEST_DEPLOY=1): TEST SITE banner, voting always shown
 *     as open (Code.gs still enforces the window).
 *
 * Requests go as text/plain so the browser sends them without a CORS
 * preflight, which Apps Script web apps cannot answer.
 *
 * Two ways to reach the sheet (6 Nov 2026):
 *   /api/vote (production): the Cloudflare Pages Function in
 *     functions/api/vote.ts. It holds the Apps Script address (so the address
 *     is not in this bundle), requires a Cloudflare Turnstile token with every
 *     vote (`humanToken` supplies it) and records the real caller IP. The page
 *     does no IP lookup in this mode.
 *   The Apps Script /exec address itself (test site, local tests): no token.
 *     IP is self-reported: the page asks a public lookup service for its own
 *     and sends that. INDICATIVE ONLY and forgeable, never used to accept or
 *     refuse a vote.
 */

/** Public "what is my IP" service. Answers {"ip":"..."} with CORS open. */
export const DEFAULT_IP_LOOKUP_URL = 'https://api.ipify.org?format=json';

export interface SheetStoreOptions {
  /** /api/vote (the Pages Function), or the web app's /exec address. */
  endpoint: string;
  contestants: readonly Pick<Contestant, 'id' | 'number' | 'stageName'>[];
  window: VotingWindow;
  rules: VotingRules;
  /** VITE_TEST_DEPLOY=1: TEST SITE banner and voting always shown as open. */
  testMode?: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
  /** The browser's user agent, shortened to a device label for the sheet. */
  userAgent?: string;
  /** Where the page looks up its own public IP. Omit to skip the lookup ('unavailable'). */
  ipLookupUrl?: string;
  ipTimeoutMs?: number;
  /**
   * A fresh Turnstile token for one attempt, asked for right before each vote
   * is sent (src/turnstile.ts). Required with a /api/... endpoint: the relay
   * refuses every vote without one.
   */
  humanToken?: () => Promise<string>;
}

const IP_PATTERN = /^[0-9A-Fa-f:.]{3,45}$/;

/** What the Votes tab's GET answer holds for one vote. No email. */
interface SheetVote {
  n: number;
  no: number;
  at: string;
  ref: string;
}

const ENDPOINT_PATTERN =
  /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/\S*$/;
/** The same-origin relay (functions/api/vote.ts). */
export const RELAY_ENDPOINT_PATTERN = /^\/api\/[A-Za-z0-9_-]+$/;

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
  /** Shows the TEST SITE banner. False in production. */
  readonly isDemo: boolean;

  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly device: string;
  private readonly byId: Map<ContestantId, Pick<Contestant, 'id' | 'number' | 'stageName'>>;
  private readonly byNumber: Map<number, ContestantId>;
  private ipLookup: Promise<string> | null = null;
  readonly supportsOrganiserTest = true;
  private organiserKey: string | null = null;
  /** Names from the Contestants tab, once revealed: they go into the Votes rows. */
  private readonly revealedNames = new Map<number, string>();

  constructor(private readonly options: SheetStoreOptions) {
    const endpoint = options.endpoint.trim();
    const relay = RELAY_ENDPOINT_PATTERN.test(endpoint);
    if (!relay && !ENDPOINT_PATTERN.test(endpoint)) {
      throw new VoteError(
        'misconfigured',
        'VITE_SHEET_ENDPOINT must be /api/vote or the Apps Script web app address ending in /exec.',
      );
    }
    if (relay && options.humanToken === undefined) {
      throw new VoteError(
        'misconfigured',
        'VITE_TURNSTILE_SITE_KEY is not set: /api/vote refuses every vote without a Turnstile token.',
      );
    }
    this.endpoint = endpoint;
    this.isDemo = options.testMode === true;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    // Apps Script often takes a few seconds on the first request after a quiet spell.
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.now = options.now ?? (() => new Date());
    this.device = deviceLabel(options.userAgent ?? '');
    this.byId = new Map(options.contestants.map((c) => [c.id, c]));
    this.byNumber = new Map(options.contestants.map((c) => [c.number, c.id]));
  }

  /**
   * The page's public IP as a lookup service sees it, or 'unavailable'. Looked
   * up once and kept for the page visit. Never throws, and gives up after
   * ipTimeoutMs (2.5 s) so a slow lookup cannot hold up a vote for long.
   */
  lookupIp(): Promise<string> {
    if (this.ipLookup !== null) return this.ipLookup;
    const url = this.options.ipLookupUrl;
    if (url === undefined || !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)/.test(url)) {
      this.ipLookup = Promise.resolve('unavailable');
      return this.ipLookup;
    }
    this.ipLookup = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.ipTimeoutMs ?? 2500);
      try {
        const response = await this.fetchImpl(url, {
          signal: controller.signal,
          cache: 'no-store',
          credentials: 'omit',
        });
        const body = (await response.json()) as { ip?: unknown };
        return typeof body.ip === 'string' && IP_PATTERN.test(body.ip.trim()) && /[.:]/.test(body.ip)
          ? body.ip.trim()
          : 'unavailable';
      } catch {
        return 'unavailable';
      } finally {
        clearTimeout(timer);
      }
    })();
    return this.ipLookup;
  }

  setOrganiserKey(key: string | null): void {
    this.organiserKey = key === null || key.trim() === '' ? null : key;
  }

  get organiserMode(): boolean {
    return this.organiserKey !== null;
  }

  private state(): EventState {
    const now = this.now();
    return {
      // An organiser test is open at any time; Code.gs checks the passcode.
      status: this.isDemo || this.organiserKey !== null ? 'open' : effectiveStatus('pending', this.options.window, now),
      adminStatus: this.isDemo ? 'open' : 'pending',
      opensAt: this.options.window.opensAt,
      closesAt: this.options.window.closesAt,
      // The sheet keeps the first vote per email and never replaces it.
      allowVoteChange: false,
      publicCounts: this.options.rules.publicCounts,
      serverTime: now.toISOString(),
    };
  }

  private async request(init: RequestInit, query = ''): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.endpoint}${query}`, {
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

  private async readVotes(passcode: string): Promise<{ takenAt: string; votes: SheetVote[] }> {
    const data = await this.request({ method: 'GET' }, `?key=${encodeURIComponent(passcode)}`);
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

  /**
   * Never asks the sheet: the counts need the admin passcode, so public counts
   * (votingRules.publicCounts) are not available with this store.
   */
  async getSession(): Promise<PublicSession> {
    return { state: this.state(), tallies: null };
  }

  /** The Contestants tab, from the reveal. Never throws for bad rows: they are dropped. */
  async getContestants(): Promise<ContestantList> {
    const key = this.organiserKey;
    const data = await this.request(
      { method: 'GET' },
      key === null ? '?view=contestants' : `?view=contestants&key=${encodeURIComponent(key)}`,
    );
    const answer = (typeof data === 'object' && data !== null ? data : {}) as { revealed?: unknown; contestants?: unknown };
    const rows = Array.isArray(answer.contestants) ? answer.contestants : [];
    const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');
    const contestants: ContestantDetails[] = [];
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue;
      const item = row as Record<string, unknown>;
      const number = item.no;
      if (typeof number !== 'number' || !this.byNumber.has(number)) continue;
      const photo = text(item.photo, 500);
      contestants.push({
        number,
        stageName: text(item.name, 40),
        handle: /^@[A-Za-z0-9._]{1,30}$/.test(text(item.handle, 31)) ? text(item.handle, 31) : '',
        tagline: text(item.tagline, 320),
        photo: /^https:\/\/[^\s"'<>]+$|^http:\/\/127\.0\.0\.1:\d+\/[^\s"'<>]+$/.test(photo) ? photo : '',
      });
    }
    const revealed = answer.revealed === true;
    // Before the reveal only an organiser (passcode) gets a list: a preview.
    const preview = !revealed && key !== null && contestants.length > 0;
    if (revealed || preview) {
      for (const c of contestants) if (c.stageName !== '') this.revealedNames.set(c.number, c.stageName);
    }
    return { revealed, preview, contestants: revealed || preview ? contestants : [] };
  }

  async castVote(contestantId: ContestantId, email: string, requestId: string): Promise<VoteReceipt> {
    const contestant = this.byId.get(contestantId);
    if (contestant === undefined) throw new VoteError('invalid_vote');
    if (canonicalEmail(email) === null) throw new VoteError('invalid_email');

    const ip = await this.lookupIp();
    const token = this.options.humanToken === undefined ? undefined : await this.options.humanToken();
    const data = await this.request({
      method: 'POST',
      // text/plain: a "simple" request, so no preflight (see the class comment).
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        contestantNumber: contestant.number,
        contestantName: this.revealedNames.get(contestant.number) ?? contestant.stageName,
        email: email.trim(),
        voteId: requestId,
        device: this.device,
        ip,
        ...(token === undefined ? {} : { turnstileToken: token }),
        ...(this.organiserKey === null ? {} : { adminKey: this.organiserKey }),
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
    if (passcode.trim() === '') throw new VoteError('bad_passcode');
    const { takenAt, votes } = await this.readVotes(passcode);
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
    await this.adminGetSnapshot(passcode);
    throw new VoteError('misconfigured', 'The emails are in the Google Sheet.');
  }

  async adminSetStatus(passcode: string): Promise<EventState> {
    await this.adminGetSnapshot(passcode);
    throw new VoteError('misconfigured', 'Voting opens and closes by itself at the times in event.config.ts.');
  }

  subscribe(): () => void {
    return () => undefined;
  }
}

/**
 * Wires the sheet store to event.config.ts. With /api/vote, every vote first
 * gets a Turnstile token for `turnstileSiteKey`, and the page's own IP lookup
 * is skipped (the relay records the real address).
 */
export function createSheetStore(
  endpoint: string,
  ipLookupUrl?: string,
  testMode = false,
  turnstileSiteKey?: string,
): SheetVoteStore {
  const relay = RELAY_ENDPOINT_PATTERN.test(endpoint.trim());
  const siteKey = (turnstileSiteKey ?? '').trim();
  const store = new SheetVoteStore({
    endpoint,
    contestants: configuredContestants,
    window: votingWindow,
    rules: votingRules,
    testMode,
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    ...(relay
      ? {}
      : { ipLookupUrl: ipLookupUrl === undefined || ipLookupUrl.trim() === '' ? DEFAULT_IP_LOOKUP_URL : ipLookupUrl.trim() }),
    ...(siteKey === '' ? {} : { humanToken: () => turnstileToken(siteKey) }),
  });
  // Start the lookup while the page loads, so it is ready by the time someone votes.
  if (!relay) void store.lookupIp();
  return store;
}
