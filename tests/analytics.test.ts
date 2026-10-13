import { describe, expect, it } from 'vitest';
import { detectBursts, tallyVotes, volumeTimeline } from '../src/domain/analytics';

const at = (time: string): string => new Date(`2026-11-03T${time}+08:00`).toISOString();

function vote(contestantId: string, time: string, replaced = false) {
  return { contestantId, castAt: at(time), replacedAt: replaced ? at('23:00:00') : null };
}

/** `count` votes for one contestant, `gapSeconds` apart, starting at `start`. */
function run(contestantId: string, start: string, count: number, gapSeconds: number) {
  const first = Date.parse(at(start));
  return Array.from({ length: count }, (_, index) => ({
    contestantId,
    castAt: new Date(first + index * gapSeconds * 1000).toISOString(),
    replacedAt: null,
  }));
}

describe('tallyVotes', () => {
  it('counts votes per contestant and lists contestants with none', () => {
    const votes = [vote('a', '12:00:00'), vote('b', '12:01:00'), vote('a', '12:02:00')];
    expect(tallyVotes(votes, ['a', 'b', 'c'])).toEqual([
      { contestantId: 'a', votes: 2 },
      { contestantId: 'b', votes: 1 },
      { contestantId: 'c', votes: 0 },
    ]);
  });

  it('does not count a vote that was replaced', () => {
    const votes = [vote('a', '12:00:00', true), vote('b', '12:05:00')];
    expect(tallyVotes(votes, ['a', 'b'])).toEqual([
      { contestantId: 'a', votes: 0 },
      { contestantId: 'b', votes: 1 },
    ]);
  });

  it('ignores a vote for a contestant no longer in the config', () => {
    expect(tallyVotes([vote('gone', '12:00:00')], ['a'])).toEqual([{ contestantId: 'a', votes: 0 }]);
  });
});

describe('volumeTimeline', () => {
  const options = {
    bucketMinutes: 60,
    from: new Date(at('12:00:00')),
    to: new Date(at('15:30:00')),
  };

  it('counts votes into hourly buckets and keeps the empty ones', () => {
    const votes = [
      vote('a', '12:00:00'),
      vote('a', '12:59:59'),
      vote('b', '13:00:00'),
      vote('b', '15:10:00'),
    ];
    expect(volumeTimeline(votes, options)).toEqual([
      { start: at('12:00:00'), votes: 2 },
      { start: at('13:00:00'), votes: 1 },
      { start: at('14:00:00'), votes: 0 },
      { start: at('15:00:00'), votes: 1 },
    ]);
  });

  it('counts replaced votes too: this is traffic, not the tally', () => {
    const votes = [vote('a', '12:10:00', true), vote('b', '12:20:00')];
    expect(volumeTimeline(votes, options)[0]).toEqual({ start: at('12:00:00'), votes: 2 });
  });

  it('leaves out votes that fall outside the range', () => {
    const votes = [vote('a', '11:59:59'), vote('a', '16:00:00')];
    expect(volumeTimeline(votes, options).reduce((sum, bucket) => sum + bucket.votes, 0)).toBe(0);
  });

  it('returns nothing for a range that ends before it starts', () => {
    expect(
      volumeTimeline([], { bucketMinutes: 60, from: new Date(at('15:00:00')), to: new Date(at('12:00:00')) }),
    ).toEqual([]);
  });

  it('caps the number of buckets, so a mistyped window cannot hang the page', () => {
    const buckets = volumeTimeline([], {
      bucketMinutes: 1,
      from: new Date('2026-01-01T00:00:00Z'),
      to: new Date('2027-01-01T00:00:00Z'),
      maxBuckets: 50,
    });
    expect(buckets).toHaveLength(50);
  });
});

describe('detectBursts', () => {
  const rule = { votes: 5, windowMinutes: 5 };

  it('flags nothing for steady voting', () => {
    // One vote every two minutes: never more than three in any five-minute window.
    expect(detectBursts(run('a', '12:00:00', 30, 120), rule)).toEqual([]);
  });

  it('flags a run that reaches the threshold inside the window', () => {
    expect(detectBursts(run('a', '12:00:00', 5, 30), rule)).toEqual([
      { contestantId: 'a', firstVoteAt: at('12:00:00'), lastVoteAt: at('12:02:00'), votes: 5 },
    ]);
  });

  it('does not flag one vote short of the threshold', () => {
    expect(detectBursts(run('a', '12:00:00', 4, 1), rule)).toEqual([]);
  });

  it('does not flag the threshold spread over exactly the window length', () => {
    // Five votes 75 seconds apart: the first and last are exactly five minutes apart.
    expect(detectBursts(run('a', '12:00:00', 5, 75), rule)).toEqual([]);
  });

  it('reports one long burst as one flag, not one per overlapping window', () => {
    const flags = detectBursts(run('a', '12:00:00', 40, 20), rule);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ votes: 40, firstVoteAt: at('12:00:00') });
  });

  it('reports two separate bursts for the same contestant separately', () => {
    const votes = [...run('a', '12:00:00', 6, 10), ...run('a', '18:00:00', 7, 10)];
    expect(detectBursts(votes, rule).map((flag) => [flag.firstVoteAt, flag.votes])).toEqual([
      [at('12:00:00'), 6],
      [at('18:00:00'), 7],
    ]);
  });

  it('judges each contestant on their own votes', () => {
    // Ten votes in a minute, but spread over five contestants: nobody reaches five.
    const spread = ['a', 'b', 'c', 'd', 'e'].flatMap((id) => run(id, '12:00:00', 2, 30));
    expect(detectBursts(spread, rule)).toEqual([]);

    const mixed = [...run('a', '12:00:00', 6, 10), ...run('b', '12:00:00', 2, 10)];
    expect(detectBursts(mixed, rule).map((flag) => flag.contestantId)).toEqual(['a']);
  });

  it('does not depend on the order the votes arrive in', () => {
    const votes = run('a', '12:00:00', 8, 15);
    expect(detectBursts([...votes].reverse(), rule)).toEqual(detectBursts(votes, rule));
  });

  it('flags nothing when the rule is switched off or nonsensical', () => {
    const votes = run('a', '12:00:00', 20, 1);
    expect(detectBursts(votes, { votes: 5, windowMinutes: 0 })).toEqual([]);
    expect(detectBursts(votes, { votes: 1, windowMinutes: 5 })).toEqual([]);
  });
});
