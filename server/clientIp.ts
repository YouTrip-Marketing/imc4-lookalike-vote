/**
 * The caller's IP address, for the AUDIT RECORD ONLY (Revision 5, Kelicia's
 * decision of 2026-09-29).
 *
 * RECORDED, NEVER ENFORCED. Nothing in this codebase blocks, limits or delays
 * a vote because of its IP address, and a missing or unreadable address never
 * rejects a vote: it is recorded as an empty value. One vote per EMAIL is the
 * only uniqueness rule.
 *
 * The parsing and the X-Forwarded-For reading below are restored unchanged
 * from the archived one-vote-per-IP version
 * (developer/builds/_archive/imc4-lookalike-voting-ip-uniqueness/server/identity.ts).
 */

const IPV4_PART = /^(0|[1-9]\d{0,2})$/;
const HEXTET = /^[0-9a-f]{1,4}$/;

function parseIpv4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!IPV4_PART.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

/** Expands an IPv6 address to its eight 16-bit groups, or null if it is not one. */
function parseIpv6(text: string): number[] | null {
  let source = text;

  // A trailing dotted quad (::ffff:203.0.113.7) stands for the last two groups.
  const lastColon = source.lastIndexOf(':');
  const tail = source.slice(lastColon + 1);
  if (tail.includes('.')) {
    const bytes = parseIpv4(tail);
    if (bytes === null) return null;
    const [a = 0, b = 0, c = 0, d = 0] = bytes;
    const high = ((a << 8) | b).toString(16);
    const low = ((c << 8) | d).toString(16);
    source = `${source.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = source.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const groups: number[] = [];
    for (const group of part.split(':')) {
      if (!HEXTET.test(group)) return null;
      groups.push(parseInt(group, 16));
    }
    return groups;
  };

  const head = parseGroups(halves[0] ?? '');
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;

  const rest = parseGroups(halves[1] ?? '');
  if (rest === null) return null;
  const missing = 8 - head.length - rest.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...rest];
}

/**
 * The address to record for a request, or '' when there is none worth keeping.
 *
 *   IPv4                 as reported             203.0.113.7
 *   IPv6                 lower-cased, as written 2001:db8::1
 *   IPv4-mapped IPv6     the IPv4 address inside ::ffff:203.0.113.7 -> 203.0.113.7
 *
 * The full address is kept (not a /64 prefix): this is a record of what the
 * platform reported, not a uniqueness key. Anything that is not a plain IP
 * address (empty, "unknown", a list) is recorded as ''.
 */
export function recordableIp(clientIp: string | null | undefined): string {
  if (typeof clientIp !== 'string') return '';
  const text = clientIp.trim().toLowerCase();
  if (text === '' || text.length > 45) return '';

  if (!text.includes(':')) {
    const bytes = parseIpv4(text);
    return bytes === null ? '' : bytes.join('.');
  }

  const groups = parseIpv6(text);
  if (groups === null) return '';
  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (mapped) {
    const high = groups[6] ?? 0;
    const low = groups[7] ?? 0;
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
  }
  return text;
}

/**
 * Picks the caller's address out of an X-Forwarded-For header, for platforms
 * that report it no other way.
 *
 * The header is a list that grows from the left: whatever the caller sent comes
 * first, and each proxy the request passes through adds the address it received
 * the request from to the END. So the entries at the right-hand end were written
 * by the platform, and everything to the left of them could have been typed by
 * the caller.
 *
 * `trustedHops` is how many entries, counting from the right, the platform
 * itself adds. The caller's address is the first of those. Taking the LEFTMOST
 * entry, as many examples do, takes whatever the caller chose to send.
 *
 * Returns null if the header is missing or shorter than `trustedHops`.
 */
export function forwardedClientIp(
  header: string | null | undefined,
  trustedHops: number,
): string | null {
  if (typeof header !== 'string') return null;
  if (!Number.isInteger(trustedHops) || trustedHops < 1) return null;
  const entries = header
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  return entries[entries.length - trustedHops] ?? null;
}
