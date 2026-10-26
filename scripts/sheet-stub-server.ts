/**
 * TEST ONLY. Stands in for the deployed Apps Script web app in `npm run test:e2e`.
 * Runs the real apps-script/Code.gs (scripts/apps-script-harness.ts) and
 * answers the way script.google.com does:
 *   - /exec answers with a 302 to a one-time address on another path, where the
 *     JSON waits (Apps Script redirects to script.googleusercontent.com);
 *   - every answer carries Access-Control-Allow-Origin: *;
 *   - /ip stands in for the public IP lookup (api.ipify.org);
 *   - a CORS preflight (OPTIONS) is refused, as Apps Script cannot answer one,
 *     so a page that triggers a preflight fails here as it would for real.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { loadAppsScript, type AppsScriptOptions, type AppsScriptRun } from './apps-script-harness';

export const STUB_IP = '203.0.113.5';
const PHOTO = readFileSync(resolve(import.meta.dirname, '..', 'public', 'promo', 'imc4-100-flights-korea-banner-1080x608.jpg'));

/** A filled-in Contestants tab for the dry run: 20 names, handles, taglines, photo addresses on the stub. */
export function dryRunContestants(port: number): (string | number)[][] {
  return Array.from({ length: 20 }, (_, index) => {
    const n = String(index + 1).padStart(2, '0');
    return [index + 1, `Dry Run ${n}`, `dryrun_${n}`, 'Town', `http://127.0.0.1:${port}/photo/${n}.jpg`];
  });
}

export interface SheetStubServer {
  url: string;
  script: AppsScriptRun;
  preflights: () => number;
  photosServed: () => number;
  close: () => Promise<void>;
}

export async function startSheetStubServer(port: number, options: AppsScriptOptions = {}): Promise<SheetStubServer> {
  const script = loadAppsScript(options);
  const waiting = new Map<string, string>();
  let preflights = 0;
  let photosServed = 0;

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    if (request.method === 'OPTIONS') {
      preflights += 1;
      response.writeHead(405).end();
      return;
    }
    if (/^\/photo\/\d\d\.jpg$/.test(url.pathname)) {
      // Stands in for contestant photos on Google's image server: one real JPEG for all 20.
      photosServed += 1;
      response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }).end(PHOTO);
      return;
    }
    if (url.pathname === '/ip') {
      // Stands in for api.ipify.org. A documentation-range address (RFC 5737).
      response
        .writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        .end(JSON.stringify({ ip: STUB_IP }));
      return;
    }
    if (url.pathname === '/echo') {
      const body = waiting.get(url.searchParams.get('id') ?? '');
      waiting.delete(url.searchParams.get('id') ?? '');
      response
        .writeHead(body === undefined ? 404 : 200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        })
        .end(body ?? '');
      return;
    }
    if (url.pathname !== '/exec') {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const answer =
        request.method === 'POST'
          ? script.doPost(Buffer.concat(chunks).toString('utf8'))
          : script.doGet(url.searchParams.get('key') ?? undefined, url.searchParams.get('view') ?? undefined);
      const id = randomUUID();
      waiting.set(id, JSON.stringify(answer.json));
      response.writeHead(302, { Location: `/echo?id=${id}`, 'Access-Control-Allow-Origin': '*' }).end();
    });
  });

  await new Promise<void>((resolveListen) => server.listen(port, '127.0.0.1', resolveListen));
  return {
    url: `http://127.0.0.1:${port}`,
    script,
    preflights: () => preflights,
    photosServed: () => photosServed,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}
