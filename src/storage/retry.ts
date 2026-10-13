import { toVoteError, type VoteError } from '../domain/errors';

export interface RetryOptions {
  /** Total tries, including the first. */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (error: VoteError, nextAttempt: number) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries connection failures with exponential backoff and jitter.
 * Anything the store actually answered (closed, duplicate, invalid vote) is
 * final and is thrown straight away. Jitter matters here: when a contestant
 * posts the link, many phones hit the same hiccup and must not all retry on the
 * same beat.
 *
 * Retrying a vote is safe because every attempt carries the same request id:
 * if the first try was counted and only the reply was lost, the retry is
 * answered with the original receipt instead of being counted twice.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 4);
  const baseDelayMs = options.baseDelayMs ?? 400;
  const maxDelayMs = options.maxDelayMs ?? 4000;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const voteError = toVoteError(error);
      if (!voteError.retryable || attempt >= attempts) throw voteError;
      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      options.onRetry?.(voteError, attempt + 1);
      await sleep(ceiling / 2 + random() * (ceiling / 2));
    }
  }
}
