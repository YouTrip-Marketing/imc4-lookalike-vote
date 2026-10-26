/**
 * The admin passcode, remembered for THIS browser tab only (sessionStorage),
 * once #/admin has been unlocked with it. The voting page in the same tab then
 * runs as an ORGANISER TEST (26 Oct 2026): it sends the passcode with each vote,
 * and Code.gs accepts the vote at any time and marks its row as a test.
 * Closing the tab, or Lock in #/admin, ends it. Nothing is kept beyond the tab.
 */
const SESSION_KEY = 'imc4-admin-passcode';

export function rememberPasscode(passcode: string | null): void {
  try {
    if (passcode === null) window.sessionStorage.removeItem(SESSION_KEY);
    else window.sessionStorage.setItem(SESSION_KEY, passcode);
  } catch {
    // Storage blocked: the admin just re-enters the passcode after a reload.
  }
}

export function recallPasscode(): string | null {
  try {
    return window.sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}
