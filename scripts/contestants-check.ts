/**
 * Checks the Contestants tab exactly as the page sees it, using the admin
 * passcode (so it also works before the reveal, when the public answer is
 * empty). For each contestant in event.config.ts (10 since Revision 13): is
 * there a name, and does the photo address load as an image? Prints numbers and
 * OK/MISSING only, never the passcode.
 *
 *   npx tsx scripts/contestants-check.ts <path-to-ADMIN-PASSCODE.txt> [--endpoint <url>]
 *
 * Where it asks (6 Nov 2026, after the Turnstile relay went live), first match wins:
 *   1. --endpoint <url>
 *   2. the CONTESTANTS_CHECK_ENDPOINT environment variable
 *   3. the live relay, https://youtrip-lookalike-vote.pages.dev/api/vote, which
 *      passes ?view=contestants&key=... through to Apps Script unchanged.
 * An Apps Script /exec address works too. It no longer reads .env.production:
 * that file now holds /api/vote for the build (check:deploy refuses /exec there).
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { contestants } from '../event.config';

export const LIVE_RELAY = 'https://youtrip-lookalike-vote.pages.dev/api/vote';

const ACCEPTED =
  /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$|^https:\/\/[A-Za-z0-9.-]+\/api\/[A-Za-z0-9_-]+$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/\S*$/;

/** The address to ask, from the command line, then the environment, then the live relay. */
export function resolveEndpoint(argv: readonly string[], env: Record<string, string | undefined>): string {
  const flag = argv.indexOf('--endpoint');
  const fromFlag = flag >= 0 ? argv[flag + 1] : undefined;
  if (flag >= 0 && (fromFlag === undefined || fromFlag.startsWith('--'))) {
    throw new Error('--endpoint needs an address after it.');
  }
  const endpoint = (fromFlag ?? env.CONTESTANTS_CHECK_ENDPOINT ?? LIVE_RELAY).trim();
  if (!ACCEPTED.test(endpoint)) {
    throw new Error(
      `Not an address this check can use: ${endpoint}. Use the site's /api/vote (https://<host>/api/vote) or an Apps Script /exec address.`,
    );
  }
  return endpoint;
}

/** The passcode file path: the first argument that is not --endpoint or its value. */
export function passcodePath(argv: readonly string[]): string {
  const flag = argv.indexOf('--endpoint');
  const path = argv.find((arg, index) => !arg.startsWith('--') && !(flag >= 0 && index === flag + 1));
  if (path === undefined) throw new Error('Give the path to the admin passcode file.');
  return path;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const endpoint = resolveEndpoint(args, process.env);
  const lines = readFileSync(passcodePath(args), 'utf8').trim().split('\n');
  const key = (lines[lines.length - 1] ?? '').trim();

  const response = await fetch(`${endpoint}?view=contestants&key=${encodeURIComponent(key)}`);
  let answer: { ok: boolean; error?: string; data?: { revealed: boolean; contestants: { no: number; name: string; photo: string }[] } };
  try {
    answer = (await response.json()) as typeof answer;
  } catch {
    throw new Error(`The answer from ${endpoint} was not JSON (HTTP ${response.status}). Is the site or Code.gs deployed?`);
  }
  if (!answer.ok || answer.data === undefined) {
    throw new Error(`The sheet did not answer (${answer.error ?? 'no data'}). Is Code.gs deployed, and the passcode right?`);
  }
  const byNo = new Map(answer.data.contestants.map((c) => [c.no, c]));
  let ready = 0;
  const count = contestants.length;
  console.log(`Asking ${endpoint}`);
  for (let no = 1; no <= count; no += 1) {
    const c = byNo.get(no);
    let photo = 'MISSING';
    if (c !== undefined && c.photo !== '') {
      try {
        const image = await fetch(c.photo);
        const type = image.headers.get('content-type') ?? '';
        photo = image.ok && type.startsWith('image/') ? 'OK' : `NOT AN IMAGE (${image.status} ${type})`;
      } catch {
        photo = 'DOES NOT LOAD';
      }
    }
    const name = c !== undefined && c.name !== '' ? 'OK' : 'MISSING';
    if (name === 'OK' && photo === 'OK') ready += 1;
    console.log(`No. ${String(no).padStart(2, '0')}  name ${name}  photo ${photo}`);
  }
  const extra = answer.data.contestants.filter((c) => c.no > count).length;
  if (extra > 0) console.log(`Note: the sheet answered ${extra} row(s) numbered above ${count}; the page ignores them.`);
  console.log(`${ready}/${count} ready. Public until reveal: ${answer.data.revealed ? 'ALREADY REVEALED' : 'hidden (correct)'}.`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
