export const VOTE_ERROR_CODES = [
  'voting_not_open',
  'voting_closed',
  'duplicate_vote',
  'invalid_email',
  'invalid_vote',
  'rate_limited',
  'human_check_failed',
  'bad_passcode',
  'unreachable',
  'misconfigured',
] as const;

export type VoteErrorCode = (typeof VOTE_ERROR_CODES)[number];

export function isVoteErrorCode(value: unknown): value is VoteErrorCode {
  return typeof value === 'string' && (VOTE_ERROR_CODES as readonly string[]).includes(value);
}

const DEFAULT_MESSAGES: Record<VoteErrorCode, string> = {
  voting_not_open: 'Voting is not open yet.',
  voting_closed: 'Voting has closed.',
  duplicate_vote: 'A vote has already been counted for this email.',
  invalid_email: 'That email address does not look right.',
  invalid_vote: 'That vote could not be counted.',
  rate_limited: 'Too many attempts. Wait a minute and try again.',
  human_check_failed: 'We could not confirm you are a person. Please try again.',
  bad_passcode: 'Wrong passcode.',
  unreachable: 'The voting server could not be reached.',
  misconfigured: 'The voting site is not set up correctly.',
};

export class VoteError extends Error {
  readonly code: VoteErrorCode;

  constructor(code: VoteErrorCode, message?: string) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.name = 'VoteError';
    this.code = code;
  }

  /** Only connection failures are worth retrying. A rejected vote stays rejected. */
  get retryable(): boolean {
    return this.code === 'unreachable';
  }
}

export function toVoteError(error: unknown): VoteError {
  if (error instanceof VoteError) return error;
  return new VoteError('unreachable', error instanceof Error ? error.message : undefined);
}
