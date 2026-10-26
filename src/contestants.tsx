import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { contestants as configured, event } from '../event.config';
import type { Contestant, ContestantDetails } from './domain/types';
import { browserStorage } from './storage/keyValue';
import type { VoteStore } from './storage';

/**
 * The contestant list the page shows (26 Oct 2026).
 *
 * Starts from event.config.ts (placeholders). Where the store can list the
 * Top 20 at runtime (the sheet store's Contestants tab), the names, handles,
 * taglines and photos from there replace the placeholders field by field, from
 * the reveal on. Ids and numbers always come from the config, so votes are
 * counted against the same ids whatever the sheet says.
 *
 * Safe on the day: a failed or slow load keeps what is on screen; the last good
 * list is kept in this browser for the next visit; before the reveal the store
 * answers an empty list and the placeholders stay.
 */

const CACHE_KEY = `imc4-contestants:${event.id}`;
/** Before the reveal (and after a failure): look again every minute. */
const WAITING_MS = 60_000;
/** After the reveal: pick up edits to the tab every five minutes. */
const REFRESH_MS = 5 * 60_000;

export function mergeContestants(
  base: readonly Contestant[],
  details: readonly ContestantDetails[],
): Contestant[] {
  const byNumber = new Map(details.map((d) => [d.number, d]));
  return base.map((contestant) => {
    const d = byNumber.get(contestant.number);
    if (d === undefined) return contestant;
    return {
      ...contestant,
      stageName: d.stageName !== '' ? d.stageName : contestant.stageName,
      handle: d.handle !== '' ? d.handle : contestant.handle,
      tagline: d.tagline !== '' ? d.tagline : contestant.tagline,
      photo: d.photo !== '' ? d.photo : contestant.photo,
    };
  });
}

function readCache(): ContestantDetails[] {
  try {
    const raw = browserStorage().getItem(CACHE_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ContestantDetails[]) : [];
  } catch {
    return [];
  }
}

function writeCache(details: readonly ContestantDetails[]): void {
  try {
    browserStorage().setItem(CACHE_KEY, JSON.stringify(details));
  } catch {
    // Storage blocked: the list is simply fetched again next visit.
  }
}

const ContestantsContext = createContext<readonly Contestant[]>(configured);

export function ContestantsProvider({ store, children }: { store: VoteStore; children: ReactNode }): JSX.Element {
  const [details, setDetails] = useState<ContestantDetails[]>(() => (store.getContestants === undefined ? [] : readCache()));

  useEffect(() => {
    if (store.getContestants === undefined) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (): Promise<void> => {
      let next = WAITING_MS;
      try {
        const list = await store.getContestants!();
        if (cancelled) return;
        if (list.revealed && list.contestants.length > 0) {
          setDetails([...list.contestants]);
          writeCache(list.contestants);
          next = REFRESH_MS;
        }
      } catch {
        // Keep what is on screen and try again later.
      }
      if (!cancelled) timer = setTimeout(() => void load(), next);
    };
    void load();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [store]);

  const list = useMemo(() => mergeContestants(configured, details), [details]);
  return <ContestantsContext.Provider value={list}>{children}</ContestantsContext.Provider>;
}

export function useContestants(): readonly Contestant[] {
  return useContext(ContestantsContext);
}
