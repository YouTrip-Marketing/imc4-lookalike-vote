import { describe, expect, it } from 'vitest';
import { VoteError } from '../src/domain/errors';
import {
  assertVotingOpen,
  checkAllowance,
  effectiveStatus,
  isWellFormedRequestId,
  rankTallies,
  standings,
} from '../src/domain/voting';
import { DURING, ONE_VOTE, STATUS_CASES } from './fixtures';

describe('effectiveStatus', () => {
  it.each(STATUS_CASES)('$name -> $expected', (c) => {
    const window = { opensAt: c.opensAt, closesAt: c.closesAt, autoOpen: c.autoOpen };
    expect(effectiveStatus(c.adminStatus, window, c.now)).toBe(c.expected);
  });

  it('reads the window in Singapore time when written with +08:00', () => {
    const window = { opensAt: '2026-11-03T12:00:00+08:00', closesAt: null, autoOpen: true };
    // 03:59:59 UTC is 11:59:59 in Singapore: one second too early.
    expect(effectiveStatus('pending', window, new Date('2026-11-03T03:59:59Z'))).toBe('not_open');
    expect(effectiveStatus('pending', window, new Date('2026-11-03T04:00:00Z'))).toBe('open');
  });

  it('refuses a window date it cannot read, rather than guessing', () => {
    const window = { opensAt: '3 Nov, noon', closesAt: null, autoOpen: true };
    expect(() => effectiveStatus('pending', window, DURING)).toThrowError(VoteError);
    expect(() => effectiveStatus('pending', window, DURING)).toThrow(/opensAt/);
  });
});

describe('assertVotingOpen', () => {
  it('passes when open', () => {
    expect(() => assertVotingOpen('open')).not.toThrow();
  });

  it.each([
    ['not_open', 'voting_not_open'],
    ['closed', 'voting_closed'],
  ] as const)('%s throws %s', (status, code) => {
    expect(() => assertVotingOpen(status)).toThrow(expect.objectContaining({ code }));
  });
});

describe('checkAllowance', () => {
  it('accepts the first vote from an email', () => {
    expect(checkAllowance(0, ONE_VOTE)).toBe('accept');
  });

  it('rejects once the email has used its vote, however many it tries', () => {
    expect([1, 2, 5].map((used) => checkAllowance(used, ONE_VOTE))).toEqual([
      'reject',
      'reject',
      'reject',
    ]);
  });

  it('replaces instead of rejecting when changing a vote is allowed', () => {
    expect(checkAllowance(1, { ...ONE_VOTE, allowVoteChange: true })).toBe('replace');
  });
});

describe('isWellFormedRequestId', () => {
  it.each(['3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b', 'abcdef0123456789', 'r-m1x2y3-abc123'])(
    'accepts %s',
    (value) => {
      expect(isWellFormedRequestId(value)).toBe(true);
    },
  );

  it.each([undefined, null, 42, '', 'short', 'has space in it', "x'; drop table votes; --", 'a'.repeat(65)])(
    'refuses %s',
    (value) => {
      expect(isWellFormedRequestId(value)).toBe(false);
    },
  );
});

describe('rankTallies', () => {
  it('ranks by votes, highest first', () => {
    const ranked = rankTallies([
      { contestantId: 'a', votes: 2 },
      { contestantId: 'b', votes: 9 },
      { contestantId: 'c', votes: 5 },
    ]);
    expect(ranked.map((row) => [row.contestantId, row.rank])).toEqual([
      ['b', 1],
      ['c', 2],
      ['a', 3],
    ]);
  });

  it('gives tied contestants the same rank, flags them, and skips the next rank', () => {
    const ranked = rankTallies([
      { contestantId: 'a', votes: 5 },
      { contestantId: 'b', votes: 7 },
      { contestantId: 'c', votes: 5 },
      { contestantId: 'd', votes: 1 },
    ]);
    expect(ranked.map((row) => [row.contestantId, row.rank, row.tied])).toEqual([
      ['b', 1, false],
      ['a', 2, true],
      ['c', 2, true],
      ['d', 4, false],
    ]);
  });

  it('reports share relative to the leader, and zero when nobody has voted', () => {
    expect(
      rankTallies([
        { contestantId: 'a', votes: 10 },
        { contestantId: 'b', votes: 4 },
      ]).map((row) => row.share),
    ).toEqual([1, 0.4]);
    expect(rankTallies([{ contestantId: 'a', votes: 0 }])[0]?.share).toBe(0);
  });

  it('does not change the list it was given', () => {
    const input = [
      { contestantId: 'a', votes: 1 },
      { contestantId: 'b', votes: 2 },
    ];
    rankTallies(input);
    expect(input.map((row) => row.contestantId)).toEqual(['a', 'b']);
  });
});

describe('standings: who is through on votes alone', () => {
  const tallies = (votes: readonly number[]): ReturnType<typeof rankTallies> =>
    rankTallies(votes.map((count, index) => ({ contestantId: `c${index + 1}`, votes: count })));

  it('puts the top N through when the cut is clean', () => {
    const result = standings(tallies([9, 8, 7, 6, 5]), 3);
    expect([...result.values()]).toEqual(['advancing', 'advancing', 'advancing', 'out', 'out']);
  });

  it('flags everyone level at the cut instead of picking between them', () => {
    // Third and fourth are level on 6, and there are only 3 places.
    const result = standings(tallies([9, 8, 6, 6, 5]), 3);
    expect([...result.values()]).toEqual([
      'advancing',
      'advancing',
      'tied_at_cut',
      'tied_at_cut',
      'out',
    ]);
  });

  it('does not flag a tie that sits wholly inside the places', () => {
    const result = standings(tallies([9, 7, 7, 4, 2]), 3);
    expect([...result.values()]).toEqual(['advancing', 'advancing', 'advancing', 'out', 'out']);
  });

  it('flags a three-way tie across the cut', () => {
    const result = standings(tallies([9, 5, 5, 5, 1]), 3);
    expect([...result.values()]).toEqual([
      'advancing',
      'tied_at_cut',
      'tied_at_cut',
      'tied_at_cut',
      'out',
    ]);
  });

  it('puts everyone through when there are no more contestants than places', () => {
    const result = standings(tallies([3, 2]), 10);
    expect([...result.values()]).toEqual(['advancing', 'advancing']);
  });

  it('works for the real shape (Revision 13): 10 contestants, 3 places', () => {
    const votes = [50, 48, 45, 45, 38, 30, 29, 25, 22, 0];
    const result = [...standings(tallies(votes), 3).values()];
    expect(result.filter((standing) => standing === 'advancing')).toHaveLength(2);
    expect(result.filter((standing) => standing === 'tied_at_cut')).toHaveLength(2);
    expect(result.filter((standing) => standing === 'out')).toHaveLength(6);
  });
});
