import { canonicalEmail } from '../src/domain/email';
import { VoteError } from '../src/domain/errors';
import type { IdentityClaim, VoterIdentityResolver } from '../src/domain/identity';

const encoder = new TextEncoder();

/** HMAC-SHA256, hex. Web Crypto, so it runs the same on Node, Netlify, Deno and Workers. */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const MIN_SECRET_LENGTH = 32;

export interface EmailResolverOptions {
  /** VOTER_HASH_SECRET. Generated per event, kept only in the vote API's environment. */
  secret: string;
  /** Mixed into the hash so the same address hashes differently for any other event. */
  eventId: string;
}

/**
 * One vote per email address, taking the voter's word for which address is theirs.
 *
 * NOT VERIFIED. Nothing here checks that the address exists or belongs to the
 * person typing it. Anyone can vote again by typing another address, real or
 * made up. That is a decision for this draft, not an oversight: see README,
 * "What email uniqueness does and does not stop".
 *
 * The readable address exists only inside `resolve`, for the length of one
 * request. What leaves is an HMAC: without the secret it cannot be reversed, or
 * even checked against a guessed address. With the secret it can, which is why
 * the secret never goes in the database and is destroyed along with the hashes
 * after the vote.
 *
 * TO ADD VERIFICATION: write a second resolver with this same shape that also
 * checks `claim.proof` (the one-time code the voter was sent) before returning,
 * and pass it to createApiHandler instead of this one. The rule for what counts
 * as the same voter (canonicalEmail) and the hashing stay exactly as they are,
 * so votes cast before and after the switch are counted against the same keys.
 */
export function createEmailIdentityResolver(options: EmailResolverOptions): VoterIdentityResolver {
  if (options.secret.length < MIN_SECRET_LENGTH) {
    throw new VoteError(
      'misconfigured',
      `VOTER_HASH_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`,
    );
  }
  if (options.eventId.trim() === '') {
    throw new VoteError('misconfigured', 'Event id is missing.');
  }

  return {
    async resolve(claim: IdentityClaim) {
      const email = canonicalEmail(claim.email);
      if (email === null) throw new VoteError('invalid_email');
      return { voterKey: await hmacSha256Hex(options.secret, `${options.eventId}|email|${email}`) };
    },
  };
}
