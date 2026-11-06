import { useId } from 'react';
import type { Contestant } from '../domain/types';
import { ContestantArt } from './ContestantArt';
import { Sheet, useBackClosesSheet } from './common';

interface Props {
  contestant: Contestant | null;
  /** "No. 07 · @handle", the same label as on the card. */
  label: string;
  /** False once this browser has voted, or while voting is not open: no VOTE button then. */
  canVote: boolean;
  /** VOTE: on to the email and confirm step for this contestant. */
  onVote: () => void;
  /** Close, the backdrop, Escape or the phone's Back. */
  onClose: () => void;
}

/**
 * Revision 13e: the contestant detail sheet, opened by tapping a card. The
 * photo, name, label and the full pitch (no line limit), then VOTE and Close.
 * VOTE only while this browser can vote; otherwise the sheet is for reading.
 *
 * Same pattern as the promo panel: the native dialog moves focus in and back to
 * the card on close, and the phone's Back gesture closes it.
 */
export function ContestantDetail({ contestant, label, canVote, onVote, onClose }: Props): JSX.Element | null {
  const headingId = useId();
  const open = contestant !== null;
  const close = useBackClosesSheet(open, onClose, 'imc4ContestantDetail');

  // Not in the page at all while closed: only one dialog.sheet exists at a time.
  if (contestant === null) return null;

  const vote = (): void => {
    onVote();
    // Take back this sheet's history entry; the confirm sheet has none of its own.
    if ((window.history.state as Record<string, unknown> | null)?.imc4ContestantDetail === true) {
      window.history.back();
    }
  };
  const pitch = contestant.tagline?.trim() ?? '';

  return (
    <Sheet open onClose={close} labelledBy={headingId} className="sheet--detail">
      <div className={`sheet__art${contestant.photo !== null ? ' sheet__art--photo' : ''}`}>
        <ContestantArt contestant={contestant} />
      </div>
      <h2 id={headingId}>{contestant.stageName}</h2>
      <p className="detail__label">{label}</p>
      {pitch !== '' && <p className="detail__pitch">{pitch}</p>}
      <div className="sheet__actions">
        {canVote && (
          <button type="button" className="button button--wide" onClick={vote}>
            Vote
          </button>
        )}
        <button type="button" className="button button--ghost button--wide" onClick={close}>
          Close
        </button>
      </div>
    </Sheet>
  );
}
