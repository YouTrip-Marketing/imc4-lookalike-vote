import type { ContestantId } from '../domain/types';
import type { KeyValueStorage } from './keyValue';

/**
 * A note this browser keeps for itself: "I voted, and for whom".
 *
 * It exists only so a returning voter sees their choice. It is NOT what stops a
 * second vote: that is the server's check on the email address. Anyone can
 * clear this marker, and clearing it gains them nothing.
 *
 * The email address is deliberately NOT kept here. The browser's own autofill
 * offers it back to the voter if they want it; this page never writes it down.
 */
export interface VoteMarker {
  contestantId: ContestantId;
  votedAt: string;
}

const keyFor = (eventId: string): string => `imc4-voted:${eventId}`;

export function readVoteMarker(storage: KeyValueStorage, eventId: string): VoteMarker | null {
  try {
    const raw = storage.getItem(keyFor(eventId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { contestantId, votedAt } = parsed as Partial<VoteMarker>;
    if (typeof contestantId !== 'string' || typeof votedAt !== 'string') return null;
    return { contestantId, votedAt };
  } catch {
    return null;
  }
}

export function writeVoteMarker(
  storage: KeyValueStorage,
  eventId: string,
  marker: VoteMarker,
): void {
  try {
    storage.setItem(keyFor(eventId), JSON.stringify(marker));
  } catch {
    // Storage full or blocked. The vote itself is already safe on the server.
  }
}

export function clearVoteMarker(storage: KeyValueStorage, eventId: string): void {
  try {
    storage.removeItem(keyFor(eventId));
  } catch {
    // Nothing to do.
  }
}
