import type { EngineConfig } from '../src/domain/engine';
import type { AdminStatus, VoterIdentity, VotingRules, VotingStatus } from '../src/domain/types';

export const PASSCODE = 'correct-horse-battery';

export const CONTESTANT_IDS = ['c01', 'c02', 'c03', 'c04'] as const;

/**
 * Stand-ins for hashed email addresses. Shaped like the real thing (64 hex
 * characters) so the same values are accepted by the SQL check constraint.
 */
export const voterKey = (seed: string): string =>
  [...seed].map((char) => char.charCodeAt(0).toString(16).padStart(2, '0')).join('').padEnd(64, '0');

export const ALICE: VoterIdentity = { voterKey: voterKey('alice') };
export const BEN: VoterIdentity = { voterKey: voterKey('ben') };
export const CHLOE: VoterIdentity = { voterKey: voterKey('chloe') };

let requestCounter = 0;
/** A fresh, well-formed request id. */
export const requestId = (): string => `req-${String((requestCounter += 1)).padStart(8, '0')}`;

export const ONE_VOTE: VotingRules = { allowVoteChange: false, publicCounts: false };

export function makeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    contestantIds: CONTESTANT_IDS,
    window: { opensAt: OPENS_AT, closesAt: CLOSES_AT, autoOpen: true },
    rules: ONE_VOTE,
    passcode: PASSCODE,
    ...overrides,
  };
}

// A placeholder window. The real dates are not settled; nothing in the code depends on them.
export const OPENS_AT = '2026-11-03T12:00:00+08:00';
export const CLOSES_AT = '2026-11-04T23:59:00+08:00';

export const BEFORE = new Date('2026-11-03T11:59:59+08:00');
export const DURING = new Date('2026-11-04T09:00:00+08:00');
export const AFTER = new Date('2026-11-04T23:59:00+08:00');

export interface StatusCase {
  name: string;
  adminStatus: AdminStatus;
  opensAt: string | null;
  closesAt: string | null;
  autoOpen: boolean;
  now: Date;
  expected: VotingStatus;
}

/**
 * The status truth table. Run against BOTH the TypeScript rule and the SQL
 * function, so the demo and production paths are held to the same behaviour.
 */
export const STATUS_CASES: readonly StatusCase[] = [
  { name: 'scheduled window, before it opens', adminStatus: 'pending', opensAt: OPENS_AT, closesAt: CLOSES_AT, autoOpen: true, now: BEFORE, expected: 'not_open' },
  { name: 'scheduled window, inside it: opens by itself', adminStatus: 'pending', opensAt: OPENS_AT, closesAt: CLOSES_AT, autoOpen: true, now: DURING, expected: 'open' },
  { name: 'scheduled window, after it: closes by itself', adminStatus: 'pending', opensAt: OPENS_AT, closesAt: CLOSES_AT, autoOpen: true, now: AFTER, expected: 'closed' },
  { name: 'opensAt is inclusive: the opening instant is open', adminStatus: 'pending', opensAt: OPENS_AT, closesAt: CLOSES_AT, autoOpen: true, now: new Date(OPENS_AT), expected: 'open' },
  { name: 'closesAt is exclusive: the closing instant is closed', adminStatus: 'pending', opensAt: OPENS_AT, closesAt: CLOSES_AT, autoOpen: true, now: new Date(CLOSES_AT), expected: 'closed' },
  { name: 'admin paused voting inside the window', adminStatus: 'closed', opensAt: OPENS_AT, closesAt: CLOSES_AT, autoOpen: true, now: DURING, expected: 'closed' },
  { name: 'admin reopened inside the window', adminStatus: 'open', opensAt: OPENS_AT, closesAt: CLOSES_AT, autoOpen: true, now: DURING, expected: 'open' },
  { name: 'admin pressed Open before the window starts', adminStatus: 'open', opensAt: OPENS_AT, closesAt: CLOSES_AT, autoOpen: true, now: BEFORE, expected: 'not_open' },
  { name: 'admin left it open past closesAt', adminStatus: 'open', opensAt: OPENS_AT, closesAt: CLOSES_AT, autoOpen: true, now: AFTER, expected: 'closed' },
  { name: 'manual mode, inside the window, nobody pressed Open', adminStatus: 'pending', opensAt: OPENS_AT, closesAt: CLOSES_AT, autoOpen: false, now: DURING, expected: 'not_open' },
  { name: 'manual mode, admin pressed Open', adminStatus: 'open', opensAt: OPENS_AT, closesAt: CLOSES_AT, autoOpen: false, now: DURING, expected: 'open' },
  { name: 'no window at all, nobody pressed Open', adminStatus: 'pending', opensAt: null, closesAt: null, autoOpen: true, now: DURING, expected: 'not_open' },
  { name: 'no window at all, admin pressed Open', adminStatus: 'open', opensAt: null, closesAt: null, autoOpen: false, now: DURING, expected: 'open' },
  { name: 'autoOpen with no opensAt never opens by itself', adminStatus: 'pending', opensAt: null, closesAt: CLOSES_AT, autoOpen: true, now: DURING, expected: 'not_open' },
];

export type Outcome =
  | 'counted'
  | 'replaced'
  | 'duplicate_vote'
  | 'invalid_vote'
  | 'voting_not_open'
  | 'voting_closed';

export interface VoteStep {
  from: VoterIdentity;
  contestant: unknown;
  /** Reuse a name to send the same request id again, as a retry would. */
  request: string;
  expect: Outcome;
}

export interface VoteScenario {
  name: string;
  rules: VotingRules;
  steps: readonly VoteStep[];
  /** Counted votes per contestant once every step has run. */
  tally: Readonly<Record<string, number>>;
}

/**
 * The uniqueness rules as stories. Run against BOTH the TypeScript engine and
 * the SQL, inside an open voting window.
 */
export const VOTE_SCENARIOS: readonly VoteScenario[] = [
  {
    name: 'a vote is accepted',
    rules: ONE_VOTE,
    steps: [{ from: ALICE, contestant: 'c01', request: 'a', expect: 'counted' }],
    tally: { c01: 1 },
  },
  {
    name: 'a second vote from the same email is rejected, whoever it is for',
    rules: ONE_VOTE,
    steps: [
      { from: ALICE, contestant: 'c01', request: 'a', expect: 'counted' },
      { from: ALICE, contestant: 'c01', request: 'b', expect: 'duplicate_vote' },
      { from: ALICE, contestant: 'c02', request: 'c', expect: 'duplicate_vote' },
    ],
    tally: { c01: 1 },
  },
  {
    name: 'different emails each get their vote',
    rules: ONE_VOTE,
    steps: [
      { from: ALICE, contestant: 'c01', request: 'a', expect: 'counted' },
      { from: BEN, contestant: 'c01', request: 'b', expect: 'counted' },
      { from: CHLOE, contestant: 'c03', request: 'c', expect: 'counted' },
    ],
    tally: { c01: 2, c03: 1 },
  },
  {
    name: 'a retry with the same request id is the same vote, not a second one',
    rules: ONE_VOTE,
    steps: [
      { from: ALICE, contestant: 'c01', request: 'a', expect: 'counted' },
      { from: ALICE, contestant: 'c01', request: 'a', expect: 'counted' },
      { from: ALICE, contestant: 'c01', request: 'a', expect: 'counted' },
    ],
    tally: { c01: 1 },
  },
  {
    name: 'a request id cannot be borrowed by another voter',
    rules: ONE_VOTE,
    steps: [
      { from: ALICE, contestant: 'c01', request: 'a', expect: 'counted' },
      { from: BEN, contestant: 'c02', request: 'a', expect: 'invalid_vote' },
      { from: BEN, contestant: 'c02', request: 'b', expect: 'counted' },
    ],
    tally: { c01: 1, c02: 1 },
  },
  {
    name: 'unknown or malformed contestants are rejected and use up nothing',
    rules: ONE_VOTE,
    steps: [
      { from: ALICE, contestant: 'c99', request: 'a', expect: 'invalid_vote' },
      { from: ALICE, contestant: '', request: 'b', expect: 'invalid_vote' },
      { from: ALICE, contestant: null, request: 'c', expect: 'invalid_vote' },
      { from: ALICE, contestant: "c01'; delete from votes; --", request: 'd', expect: 'invalid_vote' },
      { from: ALICE, contestant: 'c01', request: 'e', expect: 'counted' },
    ],
    tally: { c01: 1 },
  },
  {
    name: 'with allowVoteChange, a second vote replaces the first',
    rules: { ...ONE_VOTE, allowVoteChange: true },
    steps: [
      { from: ALICE, contestant: 'c01', request: 'a', expect: 'counted' },
      { from: ALICE, contestant: 'c03', request: 'b', expect: 'replaced' },
      { from: ALICE, contestant: 'c02', request: 'c', expect: 'replaced' },
    ],
    tally: { c02: 1 },
  },
  {
    name: 'with allowVoteChange, choosing the same contestant again changes nothing',
    rules: { ...ONE_VOTE, allowVoteChange: true },
    steps: [
      { from: ALICE, contestant: 'c01', request: 'a', expect: 'counted' },
      { from: ALICE, contestant: 'c01', request: 'b', expect: 'counted' },
    ],
    tally: { c01: 1 },
  },
  {
    name: "with allowVoteChange, one voter's change leaves another voter's vote alone",
    rules: { ...ONE_VOTE, allowVoteChange: true },
    steps: [
      { from: ALICE, contestant: 'c01', request: 'a', expect: 'counted' },
      { from: BEN, contestant: 'c01', request: 'b', expect: 'counted' },
      { from: ALICE, contestant: 'c04', request: 'c', expect: 'replaced' },
    ],
    tally: { c01: 1, c04: 1 },
  },
];

export interface EmailCase {
  typed: string;
  /** The form votes are counted against, or null when it is not accepted as an email. */
  canonical: string | null;
}

/**
 * What counts as the same voter. Run against the page's own check, the demo
 * store and the server's resolver, so all three agree on who is who.
 */
export const EMAIL_CASES: readonly EmailCase[] = [
  { typed: 'alice@example.com', canonical: 'alice@example.com' },
  { typed: '  Alice@Example.COM  ', canonical: 'alice@example.com' },
  { typed: 'alice+votes@example.com', canonical: 'alice+votes@example.com' },
  { typed: 'a.lice@example.com', canonical: 'a.lice@example.com' },
  { typed: 'jane.doe@gmail.com', canonical: 'janedoe@gmail.com' },
  { typed: 'JaneDoe+vote2@Gmail.com', canonical: 'janedoe@gmail.com' },
  { typed: 'j.a.n.e.d.o.e+x+y@googlemail.com', canonical: 'janedoe@gmail.com' },
  { typed: 'tan.wei@yahoo.com.sg', canonical: 'tan.wei@yahoo.com.sg' },
  { typed: 'user@sub.domain.co', canonical: 'user@sub.domain.co' },
  { typed: 'o\'brien@example.ie', canonical: "o'brien@example.ie" },
  { typed: '', canonical: null },
  { typed: '   ', canonical: null },
  { typed: 'alice', canonical: null },
  { typed: 'alice@', canonical: null },
  { typed: '@example.com', canonical: null },
  { typed: 'alice@example', canonical: null },
  { typed: 'alice@@example.com', canonical: null },
  { typed: 'alice@exa mple.com', canonical: null },
  { typed: 'alice@example.c', canonical: null },
  { typed: 'alice@example.123', canonical: null },
  { typed: 'alice@-example.com', canonical: null },
  { typed: 'alice@example..com', canonical: null },
  { typed: '.alice@example.com', canonical: null },
  { typed: 'al..ice@example.com', canonical: null },
  { typed: 'alice.@example.com', canonical: null },
  { typed: '<alice@example.com>', canonical: null },
  { typed: 'alice@example.com, ben@example.com', canonical: null },
  { typed: '+tag@gmail.com', canonical: null },
  { typed: `${'a'.repeat(65)}@example.com`, canonical: null },
  { typed: `alice@${'a'.repeat(250)}.com`, canonical: null },
];

/** Pairs that must be counted as ONE voter, and pairs that must stay TWO. */
export const SAME_VOTER: readonly (readonly [string, string])[] = [
  ['alice@example.com', 'ALICE@example.com'],
  ['jane.doe@gmail.com', 'janedoe@gmail.com'],
  ['janedoe@gmail.com', 'janedoe+contest@gmail.com'],
  ['janedoe@googlemail.com', 'jane.doe@gmail.com'],
];
export const DIFFERENT_VOTERS: readonly (readonly [string, string])[] = [
  ['alice@example.com', 'alice+2@example.com'],
  ['a.lice@example.com', 'alice@example.com'],
  ['alice@example.com', 'alice@example.org'],
  ['janedoe@gmail.com', 'janedoe@gmail.co'],
];

/** Request names in a scenario become real, well-formed request ids. */
export const scenarioRequestId = (scenarioIndex: number, name: string): string =>
  `scenario-${String(scenarioIndex).padStart(3, '0')}-${name}`;

export function fullTally(tally: Readonly<Record<string, number>>): { contestantId: string; votes: number }[] {
  return CONTESTANT_IDS.map((contestantId) => ({ contestantId, votes: tally[contestantId] ?? 0 }));
}
