import type { VoterIdentity } from './types';

/**
 * What a voter hands over to be recognised.
 *
 * `proof` is not used yet. It is where a one-time code would travel once email
 * verification is switched on: the page would send the code the voter received,
 * and a verifying resolver would refuse the claim unless the code checked out.
 */
export interface IdentityClaim {
  email: unknown;
  proof?: unknown;
}

/**
 * Turns a claim into the identity votes are counted against.
 *
 * THE SEAM FOR UNIQUENESS. Everything that decides "who is this voter" sits
 * behind this one method. Swapping unverified email for verified email, or
 * adding a second factor, means writing another resolver. The voting rules,
 * the database, the page and its adapters do not change.
 *
 * Rejects with VoteError('invalid_email') when the claim is not acceptable.
 */
export interface VoterIdentityResolver {
  resolve(claim: IdentityClaim): Promise<VoterIdentity>;
}

/** Length of the voter reference shown to admins. Matches left(voter_key, 12) in SQL. */
export const VOTER_REF_LENGTH = 12;
