/**
 * A random id for one vote attempt. Sent with the vote and with every retry of
 * it, so the server can tell "the same vote again" from "another vote".
 *
 * It identifies the attempt, not the person: a new one is made for each vote and
 * the browser does not keep it.
 */
export function newRequestId(): string {
  const source = globalThis.crypto;
  // randomUUID needs a secure context and a recent engine; older in-app browsers lack it.
  if (typeof source?.randomUUID === 'function') return source.randomUUID();
  if (typeof source?.getRandomValues === 'function') {
    const bytes = source.getRandomValues(new Uint8Array(16));
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  // Last resort. Uniqueness matters here, secrecy does not.
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
