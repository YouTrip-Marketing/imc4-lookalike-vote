/**
 * The caller's IP address, for the audit record only (Revision 5). Recorded,
 * never enforced. The X-Forwarded-For cases are carried over from the archived
 * one-vote-per-IP version. All addresses are from documentation ranges.
 */
import { describe, expect, it } from 'vitest';
import { forwardedClientIp, recordableIp } from '../server/clientIp';

describe('recordableIp: what goes in the audit record', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    [' 203.0.113.7 ', '203.0.113.7'],
    ['0.0.0.0', '0.0.0.0'],
    ['2001:DB8::1', '2001:db8::1'],
    ['2001:db8:12:3400:aaaa:bbbb:cccc:1', '2001:db8:12:3400:aaaa:bbbb:cccc:1'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['::ffff:cb00:7107', '203.0.113.7'],
  ])('keeps %s as %s', (input, expected) => {
    expect(recordableIp(input)).toBe(expected);
  });

  it('keeps the full IPv6 address, not a /64: it is a record, not a uniqueness key', () => {
    expect(recordableIp('2001:db8:12:3400::1')).not.toBe(recordableIp('2001:db8:12:3400::2'));
  });

  it.each([
    null,
    undefined,
    '',
    '   ',
    'unknown',
    '203.0.113.7, 192.0.2.1',
    '256.1.1.1',
    '01.2.3.4',
    '1.2.3',
    '2001:db8::1::2',
    '203.0.113.7:8080',
    "203.0.113.7'; drop table votes; --",
    'x'.repeat(100),
  ])('records %j as empty, never as an error', (input) => {
    expect(recordableIp(input)).toBe('');
  });
});

describe('forwardedClientIp: reading X-Forwarded-For without being fooled by it', () => {
  it('reads a header with one address', () => {
    expect(forwardedClientIp('203.0.113.7', 1)).toBe('203.0.113.7');
  });

  it('takes the entry the platform added, not the one the caller sent', () => {
    expect(forwardedClientIp('192.0.2.99, 203.0.113.7', 1)).toBe('203.0.113.7');
  });

  it('is not fooled by a long forged list', () => {
    expect(forwardedClientIp('192.0.2.1, 192.0.2.2, 192.0.2.3, 203.0.113.7', 1)).toBe('203.0.113.7');
  });

  it('counts back past the platform’s own proxies when told how many there are', () => {
    expect(forwardedClientIp('192.0.2.99, 203.0.113.7, 10.0.0.1', 2)).toBe('203.0.113.7');
  });

  it('tolerates spacing and empty entries', () => {
    expect(forwardedClientIp(' 192.0.2.99 ,, 203.0.113.7 ,', 1)).toBe('203.0.113.7');
  });

  it.each([
    ['a missing header', null, 1],
    ['an undefined header', undefined, 1],
    ['an empty header', '', 1],
    ['only commas', ' , ,', 1],
    ['fewer entries than trusted hops', '203.0.113.7', 2],
    ['zero hops', '203.0.113.7', 0],
    ['fractional hops', '203.0.113.7', 1.5],
  ])('returns null for %s, which is then recorded as an empty IP', (_name, header, hops) => {
    expect(forwardedClientIp(header, hops)).toBeNull();
    expect(recordableIp(forwardedClientIp(header, hops))).toBe('');
  });
});
