/**
 * TEST ONLY. Stands in for the deployed Apps Script web app in `npm run test:e2e`.
 * Runs the real apps-script/Code.gs (scripts/apps-script-harness.ts) and
 * answers the way script.google.com does:
 *   - /exec answers with a 302 to a one-time address on another path, where the
 *     JSON waits (Apps Script redirects to script.googleusercontent.com);
 *   - every answer carries Access-Control-Allow-Origin: *;
 *   - a CORS preflight (OPTIONS) is refused, as Apps Script cannot answer one,
 *     so a page that triggers a preflight fails here as it would for real.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { loadAppsScript, type AppsScriptRun } from './apps-script-harness';

export interface SheetStubServer {
  url: string;
  script: AppsScriptRun;
  preflights: () => number;
  close: () => Promise<void>;
}

export async function startSheetStubServer(port: number): Promise<SheetStubServer> {
  const script = loadAppsScript();
  const waiting = new Map<string, string>();
  let preflights = 0;

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    if (request.method === 'OPTIONS') {
      preflights += 1;
      response.writeHead(405).end();
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
        request.method === 'POST' ? script.doPost(Buffer.concat(chunks).toString('utf8')) : script.doGet();
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
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}
