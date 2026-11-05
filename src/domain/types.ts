export type ContestantId = string;

export interface Contestant {
  /** Stable id. Votes are stored against this, so never reuse or rename one mid-vote. */
  id: ContestantId;
  /** Number shown on the card. Matches the number used in the Instagram posts. */
  number: number;
  stageName: string;
  /**
   * Path to a consented contestant photo (relative to /public), or null.
   * null renders a generated abstract placeholder.
   */
  photo: string | null;
  /** Instagram handle, shown as plain text. Never rendered as a link. */
  handle?: string;
  /**
   * Optional short free text for the card's label line, e.g. a town. What
   * contestants will submit is undecided, so nothing is filled in for the
   * placeholders. The label line is: "No. 07", then this, then the handle.
   */
  tagline?: string;
}

/**
 * The contest's key visual, shown as a banner at the top of the voting page.
 * Paths are relative to /public, e.g. 'key-visual/mobile.jpg'. Sizes and ratios
 * are in developer/outbox/imc4-voting-site-key-visual-spec.md.
 */
/**
 * A campaign promo banner on the voting page (Revision 7). An image and,
 * optionally, a link: nothing else. Paths are relative to /public.
 */
export interface PromoBanner {
  /** 3:1 image used at every width unless `phoneImage` is set. null = no banner. */
  image: string | null;
  /** Optional 16:9 image used below 640px wide. */
  phoneImage?: string | null;
  /** What the banner says, for screen readers. */
  alt: string;
  /** Optional https:// link. Empty = a plain image. Opens in a new tab. */
  href?: string;
}

/** The "Your vote is in" panel that opens straight after a vote (Revision 11). */
export interface PromoDetails {
  /** Heading when the contestant is not known. */
  heading: string;
  /** Heading when the contestant is known. `{name}` becomes e.g. "#7 Jun Hao". */
  headingWithName: string;
  /** Short lines under the promo image, in order. Plain text. */
  lines: readonly string[];
  /** Label of the button that opens promoBanner.href. */
  cta: string;
}

export interface KeyVisual {
  /** 16:9 image used on phones, and at every width when `desktop` is not set. null = no key visual yet. */
  mobile: string | null;
  /** Optional 3:1 image used from 900px wide. */
  desktop?: string | null;
  /** What the image shows, for screen readers. Required once an image is set. */
  alt: string;
}

export interface EventInfo {
  /** Short, stable id. Separates this event's browser storage and vote hashes from any other. */
  id: string;
  title: string;
  organiser: string;
  /** How many contestants the vote sends through. */
  advancing: number;
  /** YYYY-MM-DD (Singapore date) the Top 10 are announced. */
  top10AnnouncedOn: string;
  /**
   * true while the event title or any voter-facing wording still awaits legal
   * review. Not shown on the page. It stops `npm run deploy` from publishing.
   */
  legalReviewPending: boolean;
}

export interface VotingWindow {
  /** ISO 8601 with offset, e.g. 2026-11-03T12:00:00+08:00. null = no lower bound. */
  opensAt: string | null;
  /** ISO 8601 with offset. null = no upper bound. */
  closesAt: string | null;
  /** true = voting opens by itself at opensAt. false = an admin must press Open. */
  autoOpen: boolean;
}

/** One vote per email address. That part is not configurable. */
export interface VotingRules {
  /** true = a repeat vote from the same email replaces the earlier one. */
  allowVoteChange: boolean;
  /** true = per-contestant counts are shown on the public page. */
  publicCounts: boolean;
}

export interface BurstRule {
  /** Flag a contestant who receives at least this many votes... */
  votes: number;
  /** ...inside any window this many minutes long. */
  windowMinutes: number;
}

/** What an admin last pressed. */
export type AdminStatus = 'pending' | 'open' | 'closed';

/** What voters actually experience once the window is applied. */
export type VotingStatus = 'not_open' | 'open' | 'closed';

/**
 * Who a vote is counted against. Worked out from the voter's email by a
 * VoterIdentityResolver, and never shown to the browser.
 */
export interface VoterIdentity {
  /** Keyed hash of the voter's email address. Never the address itself. */
  voterKey: string;
}

export interface EventState extends VotingRules {
  status: VotingStatus;
  adminStatus: AdminStatus;
  opensAt: string | null;
  closesAt: string | null;
  /** Store clock at the time of the read. */
  serverTime: string;
}

export interface Tally {
  contestantId: ContestantId;
  votes: number;
}

/** What anyone may know. Nothing in it is about any one voter. */
export interface PublicSession {
  state: EventState;
  /** Per-contestant counts. null unless public counts are switched on. */
  tallies: readonly Tally[] | null;
}

export interface VoteReceipt {
  contestantId: ContestantId;
  castAt: string;
  /** true when this vote replaced an earlier one from the same email. */
  replaced: boolean;
  session: PublicSession;
}

export interface AdminVoteRow {
  id: number;
  contestantId: ContestantId;
  castAt: string;
  /** Set when a later vote from the same email replaced this one. Replaced votes are not counted. */
  replacedAt: string | null;
  /** First characters of the email's hash: enough to tell voters apart, not an address. */
  voterRef: string;
}

export interface AdminSnapshot {
  state: EventState;
  takenAt: string;
  /** Every vote, oldest first. No personal data. */
  votes: readonly AdminVoteRow[];
  /**
   * Groups of votes that came from one IP address, WITHOUT the address: for the
   * "many votes from one network" flag. Largest first. Groups of 2 or more.
   */
  sharedAddresses: readonly SharedAddressGroup[];
}

export interface SharedAddressGroup {
  votes: number;
  contestants: readonly { contestantId: ContestantId; votes: number }[];
}

/** When the admin view flags many votes from one IP address. Flag only. */
export interface SharedAddressRule {
  votes: number;
}

/** Where a recorded IP address came from. */
export type IpSource = 'platform' | 'not reported' | 'not kept' | 'simulated (demo)';

/**
 * CONFIDENTIAL. What the audit table holds for one vote (Revision 5).
 * Only ever in the admin audit answer and the audit export.
 */
export interface AuditRecord {
  /** As typed, trimmed. */
  emailTyped: string;
  /** The form the uniqueness check used. */
  emailNormalised: string;
  /** '' when none was reported. */
  ip: string;
  ipSource: IpSource;
}

/** CONFIDENTIAL. One row of the audit export. */
export interface AuditRow extends AuditRecord {
  voteId: number;
  contestantId: ContestantId;
  castAt: string;
  replacedAt: string | null;
  /** How many votes in the whole event share this IP address. 0 when there is none. */
  votesFromIp: number;
}

export interface RankedTally extends Tally {
  /** 1-based. Tied contestants share a rank. */
  rank: number;
  tied: boolean;
  /** 0..1 share of the leader's votes, for bar widths. */
  share: number;
}

export type Standing = 'advancing' | 'tied_at_cut' | 'out';

export interface VolumeBucket {
  /** ISO start of the bucket. */
  start: string;
  votes: number;
}

export interface BurstFlag {
  contestantId: ContestantId;
  firstVoteAt: string;
  lastVoteAt: string;
  votes: number;
}

/**
 * Contestant details loaded at runtime (the sheet's "Contestants" tab, from the
 * Top 20 reveal). Each field, when non-empty, replaces the one in event.config.ts.
 */
export interface ContestantDetails {
  number: number;
  stageName: string;
  handle: string;
  tagline: string;
  /** https image address, or '' for the abstract placeholder. */
  photo: string;
}

export interface ContestantList {
  /** false before the reveal: the list is empty and the page keeps its placeholders. */
  revealed: boolean;
  /** true when an organiser sees the list early (admin passcode). Never cached. */
  preview?: boolean;
  contestants: readonly ContestantDetails[];
}
