import { useCallback, useEffect, useRef, useState } from 'react';
import { toVoteError, type VoteError } from '../domain/errors';

export interface PollingState<T> {
  /** Last good value. Kept on screen when a later poll fails. */
  data: T | null;
  /** Error from the most recent attempt, or null if it succeeded. */
  error: VoteError | null;
  loading: boolean;
  refresh: () => void;
}

export interface PollingOptions {
  intervalMs: number;
  /** Set false to pause, e.g. while a vote is being saved. */
  enabled?: boolean;
  /** Optional push source; each notification triggers an immediate reload. */
  subscribe?: (listener: () => void) => () => void;
}

/**
 * Loads a value, then keeps it fresh.
 *
 * Built for bad connections: a failed poll never blanks the screen, a slow
 * response can never overwrite a newer one, polling stops while the tab is
 * hidden, and coming back online or back to the tab reloads straight away.
 * The interval is jittered so a crowd of phones does not poll in lockstep.
 */
export function usePolling<T>(load: () => Promise<T>, options: PollingOptions): PollingState<T> {
  const { intervalMs, enabled = true, subscribe } = options;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<VoteError | null>(null);
  const [loading, setLoading] = useState(true);

  const loadRef = useRef(load);
  loadRef.current = load;
  const sequence = useRef(0);

  const run = useCallback(async (): Promise<void> => {
    const ticket = ++sequence.current;
    try {
      const value = await loadRef.current();
      if (ticket !== sequence.current) return;
      setData(value);
      setError(null);
    } catch (caught) {
      if (ticket !== sequence.current) return;
      const voteError = toVoteError(caught);
      setError(voteError);
      // A definite answer (e.g. a wrong passcode) replaces stale data. A dropped connection does not.
      if (!voteError.retryable) setData(null);
    } finally {
      if (ticket === sequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const schedule = (): void => {
      const jitter = intervalMs * 0.2 * Math.random();
      timer = setTimeout(tick, intervalMs + jitter);
    };
    const tick = (): void => {
      if (stopped) return;
      if (document.visibilityState === 'hidden') {
        schedule();
        return;
      }
      void run().finally(() => {
        if (!stopped) schedule();
      });
    };
    const reloadNow = (): void => {
      if (stopped || document.visibilityState === 'hidden') return;
      void run();
    };

    void run().finally(() => {
      if (!stopped) schedule();
    });
    window.addEventListener('online', reloadNow);
    document.addEventListener('visibilitychange', reloadNow);
    const unsubscribe = subscribe?.(reloadNow);

    return () => {
      stopped = true;
      // Invalidate anything still in flight so it cannot land after a pause.
      sequence.current += 1;
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener('online', reloadNow);
      document.removeEventListener('visibilitychange', reloadNow);
      unsubscribe?.();
    };
  }, [enabled, intervalMs, run, subscribe]);

  return { data, error, loading, refresh: () => void run() };
}
