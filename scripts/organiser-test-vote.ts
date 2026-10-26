/**
 * Casts ONE organiser test vote straight to the Apps Script web app, outside
 * the voting window, using the admin passcode (which the page never sends).
 * Prints only the sheet's answer (ok / duplicate / row number) and never the
 * passcode or the address. Delete the row afterwards.
 *
 *   npx tsx scripts/organiser-test-vote.ts <path-to-ADMIN-PASSCODE.txt>
 *
 * The /exec address comes from VITE_SHEET_ENDPOINT in .env.production.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv } from 'vite';

const root = resolve(import.meta.dirname, '..');
const endpoint = loadEnv('production', root, '').VITE_SHEET_ENDPOINT ?? '';
if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(endpoint)) {
  throw new Error('Set VITE_SHEET_ENDPOINT in .env.production first.');
}
const lines = readFileSync(process.argv[2] ?? '', 'utf8').trim().split('\n');
const adminKey = (lines[lines.length - 1] ?? '').trim();

const response = await fetch(endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain;charset=utf-8' },
  body: JSON.stringify({
    contestantNumber: 1,
    contestantName: 'Contestant 1',
    email: `organiser-test+${Date.now()}@example.com`,
    voteId: `organiser-test-${randomUUID()}`,
    device: 'Organiser test',
    ip: 'unavailable',
    adminKey,
  }),
  redirect: 'follow',
});
console.log(JSON.stringify(await response.json()));
