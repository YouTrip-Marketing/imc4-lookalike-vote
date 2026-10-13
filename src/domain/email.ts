/**
 * Email addresses: checking what was typed, and deciding when two spellings are
 * the same voter.
 *
 * The page uses `checkEmail` to help the voter as they type. The server and the
 * demo use `canonicalEmail` to build the uniqueness key: a keyed hash of the
 * canonical form. Since Revision 5 the readable address is also kept, but only
 * in the separate server-only audit table (see supabase/schema.sql).
 */

export type EmailProblem = 'empty' | 'malformed' | 'too_long';

export type EmailCheck =
  | { ok: true; email: string }
  | { ok: false; problem: EmailProblem };

const MAX_LENGTH = 254;
const MAX_LOCAL_LENGTH = 64;

/** Domains where Google ignores dots and "+anything" in the part before the @. */
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * Is this shaped like an email address? Deliberately forgiving: it catches
 * slips (a missing @, a space, a trailing dot) and leaves the rest alone. The
 * only real proof that an address exists is sending mail to it, and this draft
 * does not do that.
 */
export function checkEmail(raw: unknown): EmailCheck {
  if (typeof raw !== 'string') return { ok: false, problem: 'empty' };
  const email = raw.trim().toLowerCase();
  if (email === '') return { ok: false, problem: 'empty' };
  if (email.length > MAX_LENGTH) return { ok: false, problem: 'too_long' };

  const at = email.lastIndexOf('@');
  if (at < 1 || at !== email.indexOf('@')) return { ok: false, problem: 'malformed' };
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);

  if (local.length > MAX_LOCAL_LENGTH) return { ok: false, problem: 'too_long' };
  if (/[\s<>()[\]\\,;:"]/.test(email)) return { ok: false, problem: 'malformed' };
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    return { ok: false, problem: 'malformed' };
  }

  const labels = domain.split('.');
  const lastLabel = labels[labels.length - 1] ?? '';
  if (labels.length < 2 || lastLabel.length < 2 || /^\d+$/.test(lastLabel)) {
    return { ok: false, problem: 'malformed' };
  }
  for (const label of labels) {
    if (label === '' || label.length > 63 || label.startsWith('-') || label.endsWith('-')) {
      return { ok: false, problem: 'malformed' };
    }
    if (!/^[\p{L}\p{N}-]+$/u.test(label)) return { ok: false, problem: 'malformed' };
  }
  return { ok: true, email };
}

/**
 * The form of an address that votes are counted against, or null if it is not
 * an email address.
 *
 *   Everyone          trimmed, lower-cased
 *   Gmail only        dots removed and "+anything" dropped from the part
 *                     before the @, and googlemail.com read as gmail.com
 *
 * Why Gmail gets special treatment: to Google, j.doe@gmail.com,
 * jdoe@gmail.com and jdoe+vote2@gmail.com are one inbox. Counting them as
 * three voters would hand every Gmail user unlimited votes from one address.
 * Folding them together can never merge two different people, because Google
 * will not let two people hold addresses that differ only in those ways.
 *
 * Why only Gmail: for any other provider, "+tag" or a dot may or may not mean
 * the same inbox, and guessing wrong would tell a real person they had already
 * voted. So other addresses are taken exactly as typed.
 *
 * This rule cannot change once votes exist: the stored hashes are made from it.
 */
export function canonicalEmail(raw: unknown): string | null {
  const checked = checkEmail(raw);
  if (!checked.ok) return null;
  const at = checked.email.lastIndexOf('@');
  const local = checked.email.slice(0, at);
  const domain = checked.email.slice(at + 1);

  if (!GMAIL_DOMAINS.has(domain)) return checked.email;

  const plus = local.indexOf('+');
  const mailbox = (plus === -1 ? local : local.slice(0, plus)).replace(/\./g, '');
  // "+tag@gmail.com" has no mailbox left once the tag is dropped.
  return mailbox === '' ? null : `${mailbox}@gmail.com`;
}
