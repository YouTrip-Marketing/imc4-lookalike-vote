import { VoteError } from './errors';
import type {
  AdminStatus,
  ContestantId,
  RankedTally,
  Standing,
  Tally,
  VotingRules,
  VotingStatus,
  VotingWindow,
} from './types';

/**
 * The voting rules, as pure functions.
 *
 * The local (demo) store runs these directly. The production backend enforces
 * the same rules in SQL (supabase/schema.sql); tests/schema.sql.test.ts runs the
 * same cases against both so the two cannot drift apart unnoticed.
 */

const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

function parseInstant(value: string | null, field: string): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new VoteError('misconfigured', `votingWindow.${field} is not a valid date: "${value}"`);
  }
  return ms;
}

/**
 * Combines what an admin pressed with the configured window.
 * The window is a guard rail: an admin can pause and resume voting inside it,
 * but can never open before opensAt or hold voting open past closesAt.
 */
export function effectiveStatus(
  adminStatus: AdminStatus,
  window: VotingWindow,
  now: Date,
): VotingStatus {
  const opensAt = parseInstant(window.opensAt, 'opensAt');
  const closesAt = parseInstant(window.closesAt, 'closesAt');
  const t = now.getTime();

  if (adminStatus === 'closed') return 'closed';
  if (closesAt !== null && t >= closesAt) return 'closed';
  if (opensAt !== null && t < opensAt) return 'not_open';
  if (adminStatus === 'open') return 'open';
  return window.autoOpen && opensAt !== null ? 'open' : 'not_open';
}

export function assertVotingOpen(status: VotingStatus): void {
  if (status === 'not_open') throw new VoteError('voting_not_open');
  if (status === 'closed') throw new VoteError('voting_closed');
}

/**
 * A request id is a random value the browser makes up for each vote it sends.
 * It lets a retry after a dropped connection be recognised as the same vote.
 */
export function isWellFormedRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

export type Allowance = 'accept' | 'replace' | 'reject';

/**
 * The uniqueness decision, in one place: one counted vote per voter. Given how
 * many this voter already has, may they cast another?
 */
export function checkAllowance(countedVotes: number, rules: VotingRules): Allowance {
  if (countedVotes < 1) return 'accept';
  return rules.allowVoteChange ? 'replace' : 'reject';
}

/**
 * Ranks by votes, highest first. Ties share a rank and are flagged, never
 * silently broken: a tie is a decision for the panel, not for the sort order.
 * Within a tie the original (config) order is kept so the list does not jitter.
 */
export function rankTallies(tallies: readonly Tally[]): RankedTally[] {
  const order = new Map(tallies.map((t, index) => [t.contestantId, index]));
  const sorted = [...tallies].sort(
    (a, b) =>
      b.votes - a.votes || (order.get(a.contestantId) ?? 0) - (order.get(b.contestantId) ?? 0),
  );
  const top = sorted[0]?.votes ?? 0;

  let rank = 0;
  let previousVotes: number | null = null;
  return sorted.map((tally, index) => {
    if (tally.votes !== previousVotes) {
      rank = index + 1;
      previousVotes = tally.votes;
    }
    const tied = sorted.filter((other) => other.votes === tally.votes).length > 1;
    return { ...tally, rank, tied, share: top === 0 ? 0 : tally.votes / top };
  });
}

/**
 * Who is through on votes alone. A tie that straddles the cut is reported as
 * `tied_at_cut` for every contestant in it, rather than picking between them.
 */
export function standings(
  ranked: readonly RankedTally[],
  places: number,
): Map<ContestantId, Standing> {
  const result = new Map<ContestantId, Standing>();
  const lastIn = ranked[places - 1];
  if (lastIn === undefined) {
    ranked.forEach((row) => result.set(row.contestantId, 'advancing'));
    return result;
  }
  const holders = ranked.filter((row) => row.votes >= lastIn.votes).length;
  const straddles = holders > places;
  for (const row of ranked) {
    if (row.votes > lastIn.votes) result.set(row.contestantId, 'advancing');
    else if (row.votes === lastIn.votes) {
      result.set(row.contestantId, straddles ? 'tied_at_cut' : 'advancing');
    } else result.set(row.contestantId, 'out');
  }
  return result;
}
