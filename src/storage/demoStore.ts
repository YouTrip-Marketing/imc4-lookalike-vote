import { contestants, demo, votingRules, votingWindow } from '../../event.config';
import { browserStorage } from './keyValue';
import { LocalVoteStore, type LocalStoreOptions } from './localStore';

/**
 * Tells this tab when another tab has changed the demo data.
 *
 * Built on the browser's `storage` event rather than a BroadcastChannel: the
 * event fires in the other tabs only once the change is readable there, whereas
 * a broadcast message can overtake the data it is announcing.
 */
function otherTabs(): LocalStoreOptions['channel'] {
  if (typeof window === 'undefined') return undefined;
  const wrapped = new Map<EventListenerOrEventListenerObject, EventListener>();
  return {
    // Nothing to send: writing to localStorage is the announcement.
    postMessage: () => undefined,
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      const onStorage: EventListener = (storageEvent) => {
        if (typeof listener === 'function') listener(storageEvent);
        else listener.handleEvent(storageEvent);
      };
      wrapped.set(listener, onStorage);
      window.addEventListener('storage', onStorage);
    },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      const onStorage = wrapped.get(listener);
      if (onStorage !== undefined) window.removeEventListener('storage', onStorage);
      wrapped.delete(listener);
    },
  };
}

/** Wires the DEMO store to event.config.ts. Local adapter only. */
export function createDemoStore(): LocalVoteStore {
  return new LocalVoteStore({
    config: {
      contestantIds: contestants.map((contestant) => contestant.id),
      window: votingWindow,
      rules: votingRules,
      passcode: demo.passcode,
    },
    storage: browserStorage(),
    latencyMs: 250,
    // Start inside the voting window, so the page can be voted on whatever today's date is.
    initialClock: 'during',
    channel: otherTabs(),
  });
}
