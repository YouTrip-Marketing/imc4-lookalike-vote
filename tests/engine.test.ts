/**
 * The voting engine: what the local (demo) adapter runs, and the reference the
 * SQL is held to. The same scenarios run against the SQL in schema.sql.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  INITIAL_ENGINE_STATE,
  castVote,
  readAdminSnapshot,
  readEventState,
  readSession,
  setAdminStatus,
  type EngineState,
} from '../src/domain/engine';
import { VoteError } from '../src/domain/errors';
import {
  AFTER,
  BEFORE,
  DURING,
  ALICE,
  BEN,
  ONE_VOTE,
  PASSCODE,
  VOTE_SCENARIOS,
  fullTally,
  makeConfig,
  requestId,
  scenarioRequestId,
  type Outcome,
} from './fixtures';

function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof VoteError) return error.code;
    throw error;
  }
}

describe('the six cases the brief asks for', () => {
  const config = makeConfig();

  it('vote accepted', () => {
    const { state, receipt } = castVote(INITIAL_ENGINE_STATE, config, ALICE, 'c02', requestId(), DURING);
    expect(receipt).toMatchObject({ contestantId: 'c02', replaced: false });
    expect(state.votes).toHaveLength(1);
  });

  it('duplicate from the same email rejected', () => {
    const first = castVote(INITIAL_ENGINE_STATE, config, ALICE, 'c02', requestId(), DURING);
    expect(codeOf(() => castVote(first.state, config, ALICE, 'c03', requestId(), DURING))).toBe(
      'duplicate_vote',
    );
  });

  it('different email accepted', () => {
    const first = castVote(INITIAL_ENGINE_STATE, config, ALICE, 'c02', requestId(), DURING);
    const second = castVote(first.state, config, BEN, 'c02', requestId(), DURING);
    expect(second.state.votes).toHaveLength(2);
  });

  it('window not open', () => {
    expect(
      codeOf(() => castVote(INITIAL_ENGINE_STATE, config, ALICE, 'c01', requestId(), BEFORE)),
    ).toBe('voting_not_open');
  });

  it('window closed', () => {
    expect(
      codeOf(() => castVote(INITIAL_ENGINE_STATE, config, ALICE, 'c01', requestId(), AFTER)),
    ).toBe('voting_closed');
  });
});

describe('uniqueness scenarios', () => {
  it.each(VOTE_SCENARIOS.map((scenario, index) => ({ ...scenario, index })))(
    '$name',
    ({ rules, steps, tally, index }) => {
      const config = makeConfig({ rules });
      let state: EngineState = INITIAL_ENGINE_STATE;

      steps.forEach((step, stepIndex) => {
        let outcome: Outcome;
        try {
          const result = castVote(
            state,
            config,
            step.from,
            step.contestant,
            scenarioRequestId(index, step.request),
            DURING,
          );
          state = result.state;
          outcome = result.receipt.replaced ? 'replaced' : 'counted';
        } catch (error) {
          if (!(error instanceof VoteError)) throw error;
          outcome = error.code as Outcome;
        }
        expect(outcome, `step ${stepIndex + 1}`).toBe(step.expect);
      });

      expect(readAdminSnapshot(state, config, PASSCODE, DURING).votes.length).toBeGreaterThan(0);
      const session = readSession(state, { ...config, rules: { ...rules, publicCounts: true } }, DURING);
      expect(session.tallies).toEqual(fullTally(tally));
    },
  );
});

describe('castVote', () => {
  const config = makeConfig();

  it('leaves the state it was given untouched', () => {
    const before = INITIAL_ENGINE_STATE;
    castVote(before, config, ALICE, 'c01', requestId(), DURING);
    expect(before.votes).toHaveLength(0);
  });

  it('a rejected vote changes nothing', () => {
    const first = castVote(INITIAL_ENGINE_STATE, config, ALICE, 'c01', requestId(), DURING);
    expect(() => castVote(first.state, config, ALICE, 'c02', requestId(), DURING)).toThrow();
    expect(first.state.votes).toHaveLength(1);
  });

  it('refuses a vote with no request id', () => {
    expect(codeOf(() => castVote(INITIAL_ENGINE_STATE, config, ALICE, 'c01', undefined, DURING))).toBe(
      'invalid_vote',
    );
    expect(codeOf(() => castVote(INITIAL_ENGINE_STATE, config, ALICE, 'c01', 'x', DURING))).toBe(
      'invalid_vote',
    );
  });

  it('answers a retry with the original receipt even after voting has closed', () => {
    const id = requestId();
    const first = castVote(INITIAL_ENGINE_STATE, config, ALICE, 'c01', id, DURING);
    const retry = castVote(first.state, config, ALICE, 'c01', id, AFTER);
    expect(retry.receipt).toMatchObject({ contestantId: 'c01', castAt: first.receipt.castAt });
    expect(retry.state.votes).toHaveLength(1);
  });

  it('a vote cast while an admin has paused voting is refused', () => {
    const paused = setAdminStatus(INITIAL_ENGINE_STATE, config, PASSCODE, 'closed');
    expect(codeOf(() => castVote(paused, config, ALICE, 'c01', requestId(), DURING))).toBe(
      'voting_closed',
    );
    const reopened = setAdminStatus(paused, config, PASSCODE, 'open');
    expect(codeOf(() => castVote(reopened, config, ALICE, 'c01', requestId(), DURING))).toBeNull();
  });

  it('keeps a replaced vote in the record, marked, instead of deleting it', () => {
    const changeable = makeConfig({ rules: { ...ONE_VOTE, allowVoteChange: true } });
    const first = castVote(INITIAL_ENGINE_STATE, changeable, ALICE, 'c01', requestId(), DURING);
    const later = new Date(DURING.getTime() + 60_000);
    const second = castVote(first.state, changeable, ALICE, 'c02', requestId(), later);

    const { votes } = readAdminSnapshot(second.state, changeable, PASSCODE, later);
    expect(votes.map((vote) => [vote.contestantId, vote.replacedAt])).toEqual([
      ['c01', later.toISOString()],
      ['c02', null],
    ]);
  });
});

describe('what the public page is told', () => {
  it('carries no counts while public counts are off', () => {
    const config = makeConfig();
    const { state } = castVote(INITIAL_ENGINE_STATE, config, ALICE, 'c01', requestId(), DURING);
    const session = readSession(state, config, DURING);
    expect(session.tallies).toBeNull();
    expect(JSON.stringify(session)).not.toContain('c01');
  });

  it('carries counts when public counts are on', () => {
    const config = makeConfig({ rules: { ...ONE_VOTE, publicCounts: true } });
    const { state } = castVote(INITIAL_ENGINE_STATE, config, ALICE, 'c03', requestId(), DURING);
    expect(readSession(state, config, DURING).tallies).toEqual(fullTally({ c03: 1 }));
  });

  it('says nothing about any voter: not who voted, not for whom', () => {
    const config = makeConfig({ rules: { ...ONE_VOTE, publicCounts: false } });
    const { state, receipt } = castVote(INITIAL_ENGINE_STATE, config, ALICE, 'c04', requestId(), DURING);
    const session = readSession(state, config, DURING);
    expect(Object.keys(session).sort()).toEqual(['state', 'tallies']);
    expect(JSON.stringify(session)).not.toContain('c04');
    expect(JSON.stringify(session)).not.toContain(ALICE.voterKey);
    expect(JSON.stringify(receipt)).not.toContain(ALICE.voterKey);
  });

  it('reports the window and the rules', () => {
    expect(readEventState(INITIAL_ENGINE_STATE, makeConfig(), DURING)).toEqual({
      status: 'open',
      adminStatus: 'pending',
      opensAt: '2026-11-03T12:00:00+08:00',
      closesAt: '2026-11-04T23:59:00+08:00',
      allowVoteChange: false,
      publicCounts: false,
      serverTime: DURING.toISOString(),
    });
  });
});

describe('admin', () => {
  const config = makeConfig();

  it.each(['', 'nope', PASSCODE.toUpperCase(), `${PASSCODE} `])(
    'refuses the passcode "%s"',
    (passcode) => {
      expect(codeOf(() => readAdminSnapshot(INITIAL_ENGINE_STATE, config, passcode, DURING))).toBe(
        'bad_passcode',
      );
      expect(codeOf(() => setAdminStatus(INITIAL_ENGINE_STATE, config, passcode, 'closed'))).toBe(
        'bad_passcode',
      );
    },
  );

  it('an unset passcode disables the admin view rather than accepting an empty one', () => {
    const open = makeConfig({ passcode: '' });
    expect(codeOf(() => readAdminSnapshot(INITIAL_ENGINE_STATE, open, '', DURING))).toBe(
      'bad_passcode',
    );
  });

  it('lists every vote oldest first, with a short voter reference and never the full key', () => {
    let state: EngineState = INITIAL_ENGINE_STATE;
    const later = new Date(DURING.getTime() + 5 * 60_000);
    state = castVote(state, config, BEN, 'c02', requestId(), later).state;
    state = castVote(state, config, ALICE, 'c01', requestId(), DURING).state;

    const snapshot = readAdminSnapshot(state, config, PASSCODE, later);
    expect(snapshot.votes.map((vote) => vote.contestantId)).toEqual(['c01', 'c02']);
    expect(snapshot.votes[0]?.voterRef).toBe(ALICE.voterKey.slice(0, 12));
    expect(JSON.stringify(snapshot)).not.toContain(ALICE.voterKey);
  });
});
