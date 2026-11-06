/**
 * Revision 13e: which sheet is showing on the voting page.
 *
 *   grid  --tap a card-->  detail  --VOTE-->  confirm  --sent-->  grid
 *                            ^                   |
 *                            +------Back---------+
 *   detail --Close--> grid
 *
 * The detail sheet is remembered while the confirm sheet is up, so Back from
 * confirm returns to it. Only one sheet shows at a time: confirm wins.
 */
export interface SheetsState<C> {
  /** The contestant whose detail sheet is open, or remembered behind the confirm sheet. */
  detail: C | null;
  /** The contestant whose email-and-confirm sheet is open. */
  confirm: C | null;
}

export type SheetsAction<C> =
  /** A card was tapped. Always allowed: the detail sheet shows the pitch even when voting is not possible. */
  | { type: 'openDetail'; contestant: C }
  /** VOTE on the detail sheet: on to the email and confirm step for that contestant. */
  | { type: 'vote' }
  /** Back (or Escape) on the confirm sheet: back to the detail sheet, if one was open. */
  | { type: 'backFromConfirm' }
  /** Close (or the phone's Back) on the detail sheet. Ignored while confirm is up: the detail stays remembered. */
  | { type: 'closeDetail' }
  /** The vote is on its way: both sheets go. */
  | { type: 'sent' }
  /** The server refused the email: the confirm sheet comes back for this contestant. */
  | { type: 'reopenConfirm'; contestant: C };

export function initialSheets<C>(): SheetsState<C> {
  return { detail: null, confirm: null };
}

export function sheetsReducer<C>(state: SheetsState<C>, action: SheetsAction<C>): SheetsState<C> {
  switch (action.type) {
    case 'openDetail':
      return { detail: action.contestant, confirm: null };
    case 'vote':
      return state.detail === null ? state : { detail: state.detail, confirm: state.detail };
    case 'backFromConfirm':
      return state.confirm === null ? state : { detail: state.detail, confirm: null };
    case 'closeDetail':
      return state.confirm !== null || state.detail === null ? state : { detail: null, confirm: null };
    case 'sent':
      return { detail: null, confirm: null };
    case 'reopenConfirm':
      return { detail: null, confirm: action.contestant };
  }
}

/** The one sheet that is showing. */
export function visibleSheet<C>(state: SheetsState<C>): 'detail' | 'confirm' | null {
  if (state.confirm !== null) return 'confirm';
  return state.detail !== null ? 'detail' : null;
}
