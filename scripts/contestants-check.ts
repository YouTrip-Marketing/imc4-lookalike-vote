/**
 * Before the reveal: checks the Contestants tab exactly as the page will see it
 * at 2 Nov 12:00, using the admin passcode (the public answer is empty until
 * then). For each contestant in event.config.ts (10 since Revision 13): is there a name, and does the photo address load
 * as an image? Prints numbers and OK/MISSING only.
 *
 *   npx tsx scripts/contestants-check.ts <path-to-ADMIN-PASSCODE.txt>
 *
 * The /exec address comes from VITE_SHEET_ENDPOINT in .env.production.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv } from 'vite';
import { contestants } from '../event.config';

const root = resolve(import.meta.dirname, '..');
const endpoint = loadEnv('production', root, '').VITE_SHEET_ENDPOINT ?? '';
if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(endpoint)) {
  throw new Error('Set VITE_SHEET_ENDPOINT in .env.production first.');
}
const lines = readFileSync(process.argv[2] ?? '', 'utf8').trim().split('\n');
const key = (lines[lines.length - 1] ?? '').trim();

const answer = (await (await fetch(`${endpoint}?view=contestants&key=${encodeURIComponent(key)}`)).json()) as {
  ok: boolean;
  data?: { revealed: boolean; contestants: { no: number; name: string; photo: string }[] };
};
if (!answer.ok || answer.data === undefined) throw new Error('The sheet did not answer. Is Code.gs deployed?');
const byNo = new Map(answer.data.contestants.map((c) => [c.no, c]));
let ready = 0;
const count = contestants.length;
for (let no = 1; no <= count; no += 1) {
  const c = byNo.get(no);
  let photo = 'MISSING';
  if (c !== undefined && c.photo !== '') {
    try {
      const response = await fetch(c.photo);
      const type = response.headers.get('content-type') ?? '';
      photo = response.ok && type.startsWith('image/') ? 'OK' : `NOT AN IMAGE (${response.status} ${type})`;
    } catch {
      photo = 'DOES NOT LOAD';
    }
  }
  const name = c !== undefined && c.name !== '' ? 'OK' : 'MISSING';
  if (name === 'OK' && photo === 'OK') ready += 1;
  console.log(`No. ${String(no).padStart(2, '0')}  name ${name}  photo ${photo}`);
}
console.log(`${ready}/${count} ready. Public until reveal: ${answer.data.revealed ? 'ALREADY REVEALED' : 'hidden (correct)'}.`);
