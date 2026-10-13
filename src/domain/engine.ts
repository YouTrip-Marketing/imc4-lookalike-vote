import { tallyVotes } from './analytics';
import { VoteError } from './errors';
import { VOTER_REF_LENGTH } from './identity';
import type {
  AdminSnapshot,
  AdminStatus,
  AuditRecord,
  AuditRow,
  SharedAddressGroup,
  ContestantId,
  EventState,
  PublicSession,
  VoteReceipt,
  VoterIdentity,
  VotingRules,
  VotingWindow,
} from './types';
import {
  assertVotingOpen,
  checkAllowance,
  effectiveStatus,
  isWellFormedRequestId,
} from './voting';

/**
 * In-memory reference implementation of the vote store's behaviour.
 * Immutable: every operation returns a new state and leaves the input alone.
 * Used by the local (demo) store; the SQL in supabase/schema.sql mirrors it.
 */

export interface VoteRecord {
  id: number;
  contestantId: ContestantId;
  voterKey: string;
  requestId: string;
  castAt: string;
  replacedAt: string | null;
}

export interface EngineState {
  adminStatus: AdminStatus;
  votes: readonly VoteRecord[];
}

export interface EngineConfig {
  contestantIds: readonly ContestantId[];
  window: VotingWindow;
  rules: VotingRules;
  passcode: string;
}

export const INITIAL_ENGINE_STATE: EngineState = {
  adminStatus: 'pending',
  votes: [],
};

function assertPasscode(config: EngineConfig, passcode: string): void {
  if (config.passcode.length === 0 || passcode !== config.passcode) {
    throw new VoteError('bad_passcode');
  }
}

function countedVotesFor(state: EngineState, identity: VoterIdentity): VoteRecord[] {
  return state.votes.filter(
    (vote) => vote.voterKey === identity.voterKey && vote.replacedAt === null,
  );
}

export function readEventState(state: EngineState, config: EngineConfig, now: Date): EventState {
  return {
    status: effectiveStatus(state.adminStatus, config.window, now),
    adminStatus: state.adminStatus,
    opensAt: config.window.opensAt,
    closesAt: config.window.closesAt,
    allowVoteChange: config.rules.allowVoteChange,
    publicCounts: config.rules.publicCounts,
    serverTime: now.toISOString(),
  };
}

export function readSession(state: EngineState, config: EngineConfig, now: Date): PublicSession {
  return {
    state: readEventState(state, config, now),
    // Hidden means absent: the counts never reach the page, so they cannot be dug out of it.
    tallies: config.rules.publicCounts ? tallyVotes(state.votes, config.contestantIds) : null,
  };
}

export interface CastResult {
  state: EngineState;
  receipt: VoteReceipt;
}

export function castVote(
  state: EngineState,
  config: EngineConfig,
  identity: VoterIdentity,
  contestantId: unknown,
  requestId: unknown,
  now: Date,
): CastResult {
  if (!isWellFormedRequestId(requestId)) {
    throw new VoteError('invalid_vote', 'Missing or malformed request id.');
  }

  const receiptFor = (next: EngineState, vote: VoteRecord, replaced: boolean): CastResult => ({
    state: next,
    receipt: {
      contestantId: vote.contestantId,
      castAt: vote.castAt,
      replaced,
      session: readSession(next, config, now),
    },
  });

  // A retry of a vote that was already counted (the reply got lost on the way back)
  // is answered with the original receipt, even if voting has closed since.
  const replay = state.votes.find(
    (vote) => vote.requestId === requestId && vote.voterKey === identity.voterKey,
  );
  if (replay !== undefined) return receiptFor(state, replay, false);

  // Order matters and matches the SQL.
  assertVotingOpen(effectiveStatus(state.adminStatus, config.window, now));
  if (typeof contestantId !== 'string' || !config.contestantIds.includes(contestantId)) {
    throw new VoteError('invalid_vote', 'Unknown contestant.');
  }
  if (state.votes.some((vote) => vote.requestId === requestId)) {
    // Same request id from a different voter: not a retry, and not acceptable.
    throw new VoteError('invalid_vote', 'Request id already used.');
  }

  const counted = countedVotesFor(state, identity);
  const allowance = checkAllowance(counted.length, config.rules);
  if (allowance === 'reject') throw new VoteError('duplicate_vote');

  const timestamp = now.toISOString();
  const previous = counted[counted.length - 1];
  if (allowance === 'replace' && previous !== undefined) {
    // Choosing the same contestant again changes nothing.
    if (previous.contestantId === contestantId) return receiptFor(state, previous, false);
  }

  const vote: VoteRecord = {
    id: state.votes.reduce((max, existing) => Math.max(max, existing.id), 0) + 1,
    contestantId,
    voterKey: identity.voterKey,
    requestId,
    castAt: timestamp,
    replacedAt: null,
  };
  const kept =
    allowance === 'replace' && previous !== undefined
      ? state.votes.map((existing) =>
          existing.id === previous.id ? { ...existing, replacedAt: timestamp } : existing,
        )
      : state.votes;

  return receiptFor({ ...state, votes: [...kept, vote] }, vote, allowance === 'replace');
}

export function setAdminStatus(
  state: EngineState,
  config: EngineConfig,
  passcode: string,
  adminStatus: AdminStatus,
): EngineState {
  assertPasscode(config, passcode);
  return { ...state, adminStatus };
}

export function readAdminSnapshot(
  state: EngineState,
  config: EngineConfig,
  passcode: string,
  now: Date,
  /** Audit records by vote id. Only used to group votes by IP; no address leaves. */
  audit: ReadonlyMap<number, AuditRecord> = new Map(),
): AdminSnapshot {
  assertPasscode(config, passcode);
  return {
    state: readEventState(state, config, now),
    takenAt: now.toISOString(),
    votes: oldestFirst(state.votes).map((vote) => ({
      id: vote.id,
      contestantId: vote.contestantId,
      castAt: vote.castAt,
      replacedAt: vote.replacedAt,
      voterRef: vote.voterKey.slice(0, VOTER_REF_LENGTH),
    })),
    sharedAddresses: sharedAddressGroups(state.votes, audit),
  };
}

function oldestFirst(votes: readonly VoteRecord[]): VoteRecord[] {
  return [...votes].sort((a, b) => a.castAt.localeCompare(b.castAt) || a.id - b.id);
}

/** Votes grouped by IP address, largest group first, WITHOUT the address. Mirrors admin_snapshot() in SQL. */
export function sharedAddressGroups(
  votes: readonly VoteRecord[],
  audit: ReadonlyMap<number, AuditRecord>,
): SharedAddressGroup[] {
  const byIp = new Map<string, VoteRecord[]>();
  for (const vote of votes) {
    const ip = audit.get(vote.id)?.ip ?? '';
    if (ip === '') continue;
    byIp.set(ip, [...(byIp.get(ip) ?? []), vote]);
  }
  return [...byIp.values()]
    .filter((group) => group.length >= 2)
    .map((group) => {
      const perContestant = new Map<string, number>();
      for (const vote of group) perContestant.set(vote.contestantId, (perContestant.get(vote.contestantId) ?? 0) + 1);
      return {
        votes: group.length,
        contestants: [...perContestant.entries()]
          .map(([contestantId, count]) => ({ contestantId, votes: count }))
          .sort((a, b) => b.votes - a.votes || a.contestantId.localeCompare(b.contestantId)),
      };
    })
    .sort((a, b) => b.votes - a.votes);
}

/**
 * CONFIDENTIAL. Every vote with its audit record, oldest first. Mirrors
 * admin_audit() in SQL: a vote with no audit record appears with blanks.
 */
export function readAudit(
  state: EngineState,
  config: EngineConfig,
  passcode: string,
  audit: ReadonlyMap<number, AuditRecord>,
): AuditRow[] {
  assertPasscode(config, passcode);
  const perIp = new Map<string, number>();
  for (const vote of state.votes) {
    const ip = audit.get(vote.id)?.ip ?? '';
    if (ip !== '') perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
  }
  return oldestFirst(state.votes).map((vote) => {
    const record = audit.get(vote.id);
    return {
      voteId: vote.id,
      contestantId: vote.contestantId,
      castAt: vote.castAt,
      replacedAt: vote.replacedAt,
      emailTyped: record?.emailTyped ?? '',
      emailNormalised: record?.emailNormalised ?? '',
      ip: record?.ip ?? '',
      ipSource: record?.ipSource ?? 'not kept',
      votesFromIp: record === undefined || record.ip === '' ? 0 : (perIp.get(record.ip) ?? 0),
    };
  });
}
