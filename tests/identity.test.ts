/**
 * Turning an email address into a voter identity: checking, normalising and
 * hashing. The case tables in fixtures.ts are shared with the demo store's
 * tests, so the page, the demo and the server agree on who is who.
 */
import { describe, expect, it } from 'vitest';
import { canonicalEmail, checkEmail } from '../src/domain/email';
import { simulatedVoterKey } from '../src/storage/localStore';
import { createEmailIdentityResolver, hmacSha256Hex } from '../server/identity';
import { DIFFERENT_VOTERS, EMAIL_CASES, SAME_VOTER } from './fixtures';

const SECRET = 'test-secret-that-is-at-least-32-chars-long';
const resolver = createEmailIdentityResolver({ secret: SECRET, eventId: 'test-event' });
const keyOf = async (email: string): Promise<string> => (await resolver.resolve({ email })).voterKey;

describe('canonicalEmail', () => {
  it.each(EMAIL_CASES)('"$typed" -> $canonical', ({ typed, canonical }) => {
    expect(canonicalEmail(typed)).toBe(canonical);
  });

  it.each([null, undefined, 42, {}, ['alice@example.com']])('refuses a non-string (%s)', (value) => {
    expect(canonicalEmail(value)).toBeNull();
  });
});

describe('checkEmail (what the page tells the voter)', () => {
  it('accepts exactly the addresses the server accepts, apart from the Gmail-only rule', () => {
    for (const { typed, canonical } of EMAIL_CASES) {
      // "+tag@gmail.com" is shaped like an address, so the page lets it through;
      // the server then refuses it because no Gmail mailbox is left.
      if (typed === '+tag@gmail.com') continue;
      expect(checkEmail(typed).ok, typed).toBe(canonical !== null);
    }
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['alice', 'malformed'],
    ['alice@example', 'malformed'],
    [`${'a'.repeat(65)}@example.com`, 'too_long'],
    [`alice@${'a'.repeat(250)}.com`, 'too_long'],
  ] as const)('explains what is wrong with "%s": %s', (typed, problem) => {
    expect(checkEmail(typed)).toEqual({ ok: false, problem });
  });

  it('trims and lower-cases, and does not apply the Gmail rule (that is for counting only)', () => {
    expect(checkEmail('  Jane.Doe+x@Gmail.com ')).toEqual({ ok: true, email: 'jane.doe+x@gmail.com' });
  });
});

describe('hmacSha256Hex', () => {
  it('matches the published HMAC-SHA256 test vector (RFC 4231, case 2)', async () => {
    expect(await hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });
});

describe('the email identity resolver (server)', () => {
  it.each(SAME_VOTER)('counts %s and %s as one voter', async (a, b) => {
    expect(await keyOf(a)).toBe(await keyOf(b));
  });

  it.each(DIFFERENT_VOTERS)('counts %s and %s as two voters', async (a, b) => {
    expect(await keyOf(a)).not.toBe(await keyOf(b));
  });

  it('produces 64 hex characters that contain no part of the address', async () => {
    const key = await keyOf('alice.tan@example.com');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain('alice');
    expect(key).not.toContain('example');
  });

  it('is not a plain hash: without the secret the key cannot be recomputed', async () => {
    const key = await keyOf('alice@example.com');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('alice@example.com'));
    const plain = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(key).not.toBe(plain);
  });

  it('gives a different key under a different secret', async () => {
    const other = createEmailIdentityResolver({
      secret: 'another-secret-that-is-at-least-32-chars',
      eventId: 'test-event',
    });
    expect((await other.resolve({ email: 'alice@example.com' })).voterKey).not.toBe(
      await keyOf('alice@example.com'),
    );
  });

  it('gives a different key for a different event, even with the same secret', async () => {
    const other = createEmailIdentityResolver({ secret: SECRET, eventId: 'another-event' });
    expect((await other.resolve({ email: 'alice@example.com' })).voterKey).not.toBe(
      await keyOf('alice@example.com'),
    );
  });

  it.each(EMAIL_CASES.filter((c) => c.canonical === null))(
    'refuses "$typed" with invalid_email',
    async ({ typed }) => {
      await expect(resolver.resolve({ email: typed })).rejects.toMatchObject({ code: 'invalid_email' });
    },
  );

  it.each([null, undefined, 42, { email: 'alice@example.com' }])(
    'refuses a non-string email (%s)',
    async (email) => {
      await expect(resolver.resolve({ email })).rejects.toMatchObject({ code: 'invalid_email' });
    },
  );

  it('ignores `proof` for now: the seam for a one-time code exists but nothing checks it', async () => {
    expect((await resolver.resolve({ email: 'alice@example.com', proof: '123456' })).voterKey).toBe(
      await keyOf('alice@example.com'),
    );
  });

  it.each(['', 'short', 'x'.repeat(31)])('refuses a weak secret (%s)', (secret) => {
    expect(() => createEmailIdentityResolver({ secret, eventId: 'test-event' })).toThrow(
      /VOTER_HASH_SECRET/,
    );
  });

  it('refuses to run without an event id', () => {
    expect(() => createEmailIdentityResolver({ secret: SECRET, eventId: ' ' })).toThrow(/Event id/);
  });
});

describe('the demo store agrees with the server on who is who', () => {
  const demoKey = (email: string): string => simulatedVoterKey(canonicalEmail(email) ?? '');

  it.each(SAME_VOTER)('demo: %s and %s are one voter', (a, b) => {
    expect(demoKey(a)).toBe(demoKey(b));
  });

  it.each(DIFFERENT_VOTERS)('demo: %s and %s are two voters', (a, b) => {
    expect(demoKey(a)).not.toBe(demoKey(b));
  });

  it('demo keys never contain the address', () => {
    expect(demoKey('alice@example.com')).not.toContain('alice');
  });
});
