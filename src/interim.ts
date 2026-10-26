/**
 * INTERIM build (26 Oct 2026, Kelicia: "see the voting site up and running; the
 * Google Sheet can be linked after"). VITE_INTERIM_LOCAL=1 with the local store:
 * looks exactly like production (no DEMO/TEST banner, no demo controls, real
 * clock), but each vote is kept only in the visitor's own browser. Replaced by
 * the sheet build as soon as the Apps Script /exec address exists.
 */
export const INTERIM_LOCAL = import.meta.env.VITE_INTERIM_LOCAL === '1';
