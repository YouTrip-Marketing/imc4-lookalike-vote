import { describe, expect, it } from 'vitest';
import { initialSheets, sheetsReducer, visibleSheet, type SheetsAction, type SheetsState } from '../src/domain/sheets';

/** Revision 13e: grid > detail > confirm > back to detail > close. */
const run = (...actions: SheetsAction<string>[]): SheetsState<string> =>
  actions.reduce((state, action) => sheetsReducer(state, action), initialSheets<string>());

describe('contestant sheets (Revision 13e)', () => {
  it('starts on the grid with nothing open', () => {
    expect(visibleSheet(initialSheets())).toBeNull();
  });

  it('a tap opens the detail sheet', () => {
    const state = run({ type: 'openDetail', contestant: 'c01' });
    expect(state).toEqual({ detail: 'c01', confirm: null });
    expect(visibleSheet(state)).toBe('detail');
  });

  it('VOTE goes on to confirm for the same contestant, with the detail remembered behind it', () => {
    const state = run({ type: 'openDetail', contestant: 'c05' }, { type: 'vote' });
    expect(state).toEqual({ detail: 'c05', confirm: 'c05' });
    expect(visibleSheet(state)).toBe('confirm');
  });

  it('Back from confirm returns to the detail sheet, not the grid', () => {
    const state = run({ type: 'openDetail', contestant: 'c05' }, { type: 'vote' }, { type: 'backFromConfirm' });
    expect(state).toEqual({ detail: 'c05', confirm: null });
    expect(visibleSheet(state)).toBe('detail');
  });

  it('Close on the detail sheet returns to the grid', () => {
    const state = run(
      { type: 'openDetail', contestant: 'c05' },
      { type: 'vote' },
      { type: 'backFromConfirm' },
      { type: 'closeDetail' },
    );
    expect(state).toEqual({ detail: null, confirm: null });
    expect(visibleSheet(state)).toBeNull();
  });

  it('a late "close detail" (the history entry going) while confirm is up keeps the detail remembered', () => {
    const state = run({ type: 'openDetail', contestant: 'c05' }, { type: 'vote' }, { type: 'closeDetail' });
    expect(state).toEqual({ detail: 'c05', confirm: 'c05' });
    expect(sheetsReducer(state, { type: 'backFromConfirm' })).toEqual({ detail: 'c05', confirm: null });
  });

  it('sending the vote closes both', () => {
    expect(run({ type: 'openDetail', contestant: 'c05' }, { type: 'vote' }, { type: 'sent' })).toEqual({ detail: null, confirm: null });
  });

  it('a refused email brings the confirm sheet back; its Back then goes to the grid', () => {
    const state = run({ type: 'openDetail', contestant: 'c05' }, { type: 'vote' }, { type: 'sent' }, { type: 'reopenConfirm', contestant: 'c05' });
    expect(state).toEqual({ detail: null, confirm: 'c05' });
    expect(visibleSheet(sheetsReducer(state, { type: 'backFromConfirm' }))).toBeNull();
  });

  it('tapping another card replaces the detail sheet; VOTE and Back with nothing open do nothing', () => {
    expect(run({ type: 'openDetail', contestant: 'c01' }, { type: 'openDetail', contestant: 'c02' })).toEqual({ detail: 'c02', confirm: null });
    expect(run({ type: 'vote' })).toEqual({ detail: null, confirm: null });
    expect(run({ type: 'backFromConfirm' })).toEqual({ detail: null, confirm: null });
  });
});
