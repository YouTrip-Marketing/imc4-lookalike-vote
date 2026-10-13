import { VoteError } from '../domain/errors';
import type {
  AdminSnapshot,
  AdminStatus,
  AdminVoteRow,
  AuditRow,
  EventState,
  IpSource,
  SharedAddressGroup,
  PublicSession,
  Tally,
  VoteReceipt,
  VotingStatus,
} from '../domain/types';

/**
 * Runtime checks on what the backend sends. A response that does not match is
 * treated as a misconfiguration (wrong deployment, stale schema), never trusted.
 */

type Json = Record<string, unknown>;

function bad(what: string): never {
  throw new VoteError('misconfigured', `Unexpected response from the voting server (${what}).`);
}

function asObject(value: unknown, what: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) bad(what);
  return value as Json;
}

function asString(value: unknown, what: string): string {
  return typeof value === 'string' ? value : bad(what);
}

function asNullableString(value: unknown, what: string): string | null {
  return value === null || value === undefined ? null : asString(value, what);
}

function asCount(value: unknown, what: string): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : bad(what);
}

function asBoolean(value: unknown, what: string): boolean {
  return typeof value === 'boolean' ? value : bad(what);
}

function asVotingStatus(value: unknown): VotingStatus {
  return value === 'not_open' || value === 'open' || value === 'closed' ? value : bad('status');
}

function asAdminStatus(value: unknown): AdminStatus {
  return value === 'pending' || value === 'open' || value === 'closed' ? value : bad('adminStatus');
}

function asTallies(value: unknown): Tally[] {
  if (!Array.isArray(value)) bad('tallies');
  return (value as unknown[]).map((item) => {
    const row = asObject(item, 'tally');
    return {
      contestantId: asString(row.contestantId, 'tally.contestantId'),
      votes: asCount(row.votes, 'tally.votes'),
    };
  });
}

export function parseEventState(value: unknown): EventState {
  const data = asObject(value, 'event state');
  return {
    status: asVotingStatus(data.status),
    adminStatus: asAdminStatus(data.adminStatus),
    opensAt: asNullableString(data.opensAt, 'opensAt'),
    closesAt: asNullableString(data.closesAt, 'closesAt'),
    allowVoteChange: asBoolean(data.allowVoteChange, 'allowVoteChange'),
    publicCounts: asBoolean(data.publicCounts, 'publicCounts'),
    serverTime: asString(data.serverTime, 'serverTime'),
  };
}

export function parseSession(value: unknown): PublicSession {
  const data = asObject(value, 'session');
  return {
    state: parseEventState(data.state),
    tallies: data.tallies === null || data.tallies === undefined ? null : asTallies(data.tallies),
  };
}

export function parseReceipt(value: unknown): VoteReceipt {
  const data = asObject(value, 'receipt');
  return {
    contestantId: asString(data.contestantId, 'contestantId'),
    castAt: asString(data.castAt, 'castAt'),
    replaced: asBoolean(data.replaced, 'replaced'),
    session: parseSession(data.session),
  };
}

export function parseAdminSnapshot(value: unknown): AdminSnapshot {
  const data = asObject(value, 'snapshot');
  if (!Array.isArray(data.votes)) bad('votes');
  const votes: AdminVoteRow[] = (data.votes as unknown[]).map((item) => {
    const row = asObject(item, 'vote');
    return {
      id: asCount(row.id, 'vote.id'),
      contestantId: asString(row.contestantId, 'vote.contestantId'),
      castAt: asString(row.castAt, 'vote.castAt'),
      replacedAt: asNullableString(row.replacedAt, 'vote.replacedAt'),
      // Empty once the hashes have been purged after sign-off.
      voterRef: asNullableString(row.voterRef, 'vote.voterRef') ?? '',
    };
  });
  const shared = data.sharedAddresses === undefined ? [] : data.sharedAddresses;
  if (!Array.isArray(shared)) bad('sharedAddresses');
  const sharedAddresses: SharedAddressGroup[] = (shared as unknown[]).map((item) => {
    const group = asObject(item, 'sharedAddresses');
    if (!Array.isArray(group.contestants)) bad('sharedAddresses.contestants');
    return {
      votes: asCount(group.votes, 'sharedAddresses.votes'),
      contestants: (group.contestants as unknown[]).map((entry) => {
        const row = asObject(entry, 'sharedAddresses.contestant');
        return {
          contestantId: asString(row.contestantId, 'sharedAddresses.contestantId'),
          votes: asCount(row.votes, 'sharedAddresses.contestant.votes'),
        };
      }),
    };
  });
  return {
    state: parseEventState(data.state),
    takenAt: asString(data.takenAt, 'takenAt'),
    votes,
    sharedAddresses,
  };
}

const IP_SOURCES: readonly IpSource[] = ['platform', 'not reported', 'not kept', 'simulated (demo)'];

/** CONFIDENTIAL. The admin audit answer. */
export function parseAudit(value: unknown): AuditRow[] {
  if (!Array.isArray(value)) bad('audit');
  return (value as unknown[]).map((item) => {
    const row = asObject(item, 'audit row');
    const source = asString(row.ipSource, 'audit.ipSource') as IpSource;
    if (!IP_SOURCES.includes(source)) bad('audit.ipSource');
    return {
      voteId: asCount(row.voteId, 'audit.voteId'),
      contestantId: asString(row.contestantId, 'audit.contestantId'),
      castAt: asString(row.castAt, 'audit.castAt'),
      replacedAt: asNullableString(row.replacedAt, 'audit.replacedAt'),
      emailTyped: asString(row.emailTyped, 'audit.emailTyped'),
      emailNormalised: asString(row.emailNormalised, 'audit.emailNormalised'),
      ip: asString(row.ip, 'audit.ip'),
      ipSource: source,
      votesFromIp: asCount(row.votesFromIp, 'audit.votesFromIp'),
    };
  });
}
