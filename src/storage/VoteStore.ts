import type {
  AdminSnapshot,
  AdminStatus,
  AuditRow,
  ContestantId,
  EventState,
  PublicSession,
  VoteReceipt,
} from '../domain/types';

/**
 * The one seam between the UI and wherever votes live.
 * Every method rejects with a VoteError; views switch on `error.code`.
 *
 * To add a backend, implement this interface and register it in ./index.ts.
 * A production implementation must enforce the rules server-side. The client
 * checks in the views are there for a good experience, not for integrity.
 */
export interface VoteStore {
  readonly kind: 'local' | 'api' | 'sheet';
  /** True when the data is a mock. Views show a DEMO DATA banner. */
  readonly isDemo: boolean;

  /** Event state, and counts if they are public. Says nothing about any voter. */
  getSession(): Promise<PublicSession>;

  /**
   * Casts one vote for the voter with this email address.
   *
   * `requestId` is a random value made up by the caller for this vote;
   * repeating a call with the same id is safe and returns the same receipt.
   *
   * `proof` is reserved for email verification (a one-time code). Nothing reads
   * it yet. It is in the signature so that switching verification on changes
   * the backend's identity resolver and one extra field in the page, not this
   * interface.
   *
   * Rejects with voting_not_open, voting_closed, duplicate_vote, invalid_email,
   * invalid_vote or rate_limited.
   */
  castVote(
    contestantId: ContestantId,
    email: string,
    requestId: string,
    proof?: string,
  ): Promise<VoteReceipt>;

  /** Admin methods reject with `bad_passcode` when the passcode is wrong. */
  adminGetSnapshot(passcode: string): Promise<AdminSnapshot>;
  /**
   * CONFIDENTIAL. Every vote with the email as typed, the normalised email and
   * the IP address. For the audit export only: never shown on screen.
   */
  adminGetAudit(passcode: string): Promise<AuditRow[]>;
  adminSetStatus(passcode: string, status: AdminStatus): Promise<EventState>;

  /**
   * Push-style change notification, where the backend has one. Views also poll,
   * so an implementation with nothing to push may return a no-op unsubscribe.
   */
  subscribe(listener: () => void): () => void;
}

export type DemoClockPhase = 'real' | 'before' | 'during' | 'after';

/** Extra controls that only make sense against mock data. */
export interface DemoControls {
  readonly demoPasscode: string;
  /**
   * A fresh made-up address that has not voted, e.g. visitor3@example.com: a new
   * demo visitor. With sameNetwork, the new visitor keeps the current visitor's
   * stand-in IP address, as a second person on the same wifi would.
   */
  nextSampleEmail(options?: { sameNetwork?: boolean }): Promise<string>;
  /** The current demo visitor's stand-in IP address (documentation range, simulated). */
  demoVisitorIp(): string;
  /** The made-up address handed out last, or null if none has been. */
  lastSampleEmail(): string | null;
  demoClock(): DemoClockPhase;
  /** Moves the pretend clock relative to the configured voting window. */
  setDemoClock(phase: DemoClockPhase): Promise<void>;
  simulateVotes(count: number): Promise<number>;
  /** Casts a tight run of votes for one contestant, to show what a burst flag looks like. */
  simulateBurst(count: number): Promise<number>;
  /** Casts votes from several made-up voters who share one IP address. */
  simulateSharedNetwork(count: number): Promise<number>;
  reset(): Promise<void>;
}

export function hasDemoControls(store: VoteStore): store is VoteStore & DemoControls {
  return store.isDemo && 'simulateVotes' in store && 'nextSampleEmail' in store;
}
