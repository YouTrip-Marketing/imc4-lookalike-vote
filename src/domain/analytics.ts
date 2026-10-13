import type {
  BurstFlag,
  BurstRule,
  ContestantId,
  Tally,
  VolumeBucket,
} from './types';

/**
 * Everything the admin view derives from the list of votes. One implementation,
 * used for both the demo and the production backend: the server sends the vote
 * rows and these functions do the counting.
 */

interface CountableVote {
  contestantId: ContestantId;
  castAt: string;
  replacedAt: string | null;
}

/** Counts votes per contestant. A vote that was later replaced is not counted. */
export function tallyVotes(
  votes: Iterable<CountableVote>,
  contestantIds: readonly ContestantId[],
): Tally[] {
  const counts = new Map<ContestantId, number>(contestantIds.map((id) => [id, 0]));
  for (const vote of votes) {
    if (vote.replacedAt !== null) continue;
    // A vote for a contestant since removed from the config is ignored, not counted elsewhere.
    const current = counts.get(vote.contestantId);
    if (current !== undefined) counts.set(vote.contestantId, current + 1);
  }
  return contestantIds.map((contestantId) => ({
    contestantId,
    votes: counts.get(contestantId) ?? 0,
  }));
}

export interface TimelineOptions {
  bucketMinutes: number;
  /** Buckets are laid out from here... */
  from: Date;
  /** ...up to and including the bucket that holds this instant. */
  to: Date;
  /** Safety cap so a mistyped window cannot produce an endless chart. */
  maxBuckets?: number;
}

/**
 * Votes received per time bucket, including empty buckets so quiet periods show
 * as gaps. Counts every vote as it arrived, replaced or not: this is traffic, not the tally.
 */
export function volumeTimeline(
  votes: Iterable<CountableVote>,
  options: TimelineOptions,
): VolumeBucket[] {
  const size = options.bucketMinutes * 60_000;
  const maxBuckets = options.maxBuckets ?? 400;
  if (!(size > 0)) return [];

  const first = Math.floor(options.from.getTime() / size) * size;
  const last = Math.floor(options.to.getTime() / size) * size;
  if (Number.isNaN(first) || Number.isNaN(last) || last < first) return [];

  const count = Math.min(maxBuckets, (last - first) / size + 1);
  const buckets = Array.from({ length: count }, (_, index) => ({
    start: new Date(first + index * size).toISOString(),
    votes: 0,
  }));

  for (const vote of votes) {
    const index = Math.floor((Date.parse(vote.castAt) - first) / size);
    const bucket = buckets[index];
    if (bucket !== undefined) bucket.votes += 1;
  }
  return buckets;
}

/**
 * Flags runs of votes for one contestant that arrive unusually close together.
 *
 * A flag is a prompt to look, never a verdict: a contestant posting a Story to a
 * large following produces a genuine burst. Nothing is removed or discounted here.
 *
 * Overlapping windows that each meet the threshold are merged into one flag.
 */
export function detectBursts(votes: Iterable<CountableVote>, rule: BurstRule): BurstFlag[] {
  const windowMs = rule.windowMinutes * 60_000;
  if (!(windowMs > 0) || !(rule.votes >= 2)) return [];

  const byContestant = new Map<ContestantId, number[]>();
  for (const vote of votes) {
    const time = Date.parse(vote.castAt);
    if (Number.isNaN(time)) continue;
    const times = byContestant.get(vote.contestantId) ?? [];
    times.push(time);
    byContestant.set(vote.contestantId, times);
  }

  const flags: BurstFlag[] = [];
  for (const [contestantId, times] of byContestant) {
    times.sort((a, b) => a - b);
    let runStart = -1;
    let runEnd = -1;
    let windowStart = 0;

    const flush = (): void => {
      if (runStart === -1) return;
      flags.push({
        contestantId,
        firstVoteAt: new Date(times[runStart] ?? 0).toISOString(),
        lastVoteAt: new Date(times[runEnd] ?? 0).toISOString(),
        votes: runEnd - runStart + 1,
      });
      runStart = -1;
      runEnd = -1;
    };

    for (let end = 0; end < times.length; end += 1) {
      const endTime = times[end] ?? 0;
      while (endTime - (times[windowStart] ?? 0) >= windowMs) windowStart += 1;
      if (end - windowStart + 1 < rule.votes) continue;
      // This window qualifies. Extend the current run if it overlaps, otherwise start a new one.
      if (runStart !== -1 && windowStart > runEnd) flush();
      if (runStart === -1) runStart = windowStart;
      runEnd = end;
    }
    flush();
  }

  return flags.sort(
    (a, b) => a.firstVoteAt.localeCompare(b.firstVoteAt) || a.contestantId.localeCompare(b.contestantId),
  );
}
