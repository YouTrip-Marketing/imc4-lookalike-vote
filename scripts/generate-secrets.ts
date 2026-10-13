/**
 * Prints fresh values for the two server secrets. Nothing is written to disk.
 *
 *   npm run secrets
 *
 * Paste them into the hosting platform's environment variable settings.
 * Generate a new pair for every event: a new VOTER_HASH_SECRET is what stops this
 * event's hashes from being matched against any other's.
 */
import { randomSecret } from './lib';

console.log('\nServer environment variables (keep these out of chat, email and git):\n');
console.log(`VOTER_HASH_SECRET=${randomSecret(32)}`);
console.log(`ADMIN_PASSCODE=${randomSecret(15)}`);
console.log('\nAfter the Top 10 tally is signed off: run purge_voter_keys() in the');
console.log('database and delete VOTER_HASH_SECRET from where the vote API runs.\n');
