/**
 * A local stand-in for the production backend, for tests and rehearsals.
 *
 * It runs the REAL server handler (server/handler.ts) against the REAL
 * supabase/schema.sql loaded into an embedded Postgres (PGlite). Database calls
 * run as the `service_role` role, as the service key would.
 *
 * It is NOT the hosting platform. It proves the page, the handler and the SQL
 * work together. It says nothing about a real platform's limits or behaviour. Data lives in memory and is gone when
 * the process stops. Never expose it to the internet.
 *
 *   npm run api:local            (port 54329, passcode printed)
 *
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { RPC_SIGNATURES, type Database, type RpcName } from '../server/database';
import { createApiHandler } from '../server/handler';
import { createEmailIdentityResolver } from '../server/identity';
import type { Contestant, VotingRules, VotingWindow } from '../src/domain/types';
import { randomSecret, sqlString } from './lib';

export const SCHEMA_PATH = fileURLToPath(new URL('../supabase/schema.sql', import.meta.url));

export interface LocalEvent {
  contestants: readonly Pick<Contestant, 'id' | 'number' | 'stageName'>[];
  window: VotingWindow;
  rules: VotingRules;
}

/** An embedded Postgres with schema.sql applied and the event loaded. */
export async function createLocalDatabase(event: LocalEvent): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(
    'create role anon nologin; create role authenticated nologin; create role service_role nologin;',
  );
  await db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  await db.exec(`
    insert into public.contestants (id, number, stage_name, sort_order) values
      ${event.contestants
        .map((c, i) => `(${sqlString(c.id)}, ${c.number}, ${sqlString(c.stageName)}, ${i + 1})`)
        .join(',')};
    update public.event_settings
       set opens_at = ${event.window.opensAt === null ? 'null' : sqlString(event.window.opensAt)},
           closes_at = ${event.window.closesAt === null ? 'null' : sqlString(event.window.closesAt)},
           auto_open = ${event.window.autoOpen},
           allow_vote_change = ${event.rules.allowVoteChange},
           public_counts = ${event.rules.publicCounts}
     where id = 1;
  `);
  return db;
}

/** The Database seam, backed by PGlite. Calls run as `service_role`. */
export function createPgliteDatabase(db: PGlite): Database {
  return {
    async rpc<N extends RpcName>(name: N, args: Record<string, string | null>): Promise<unknown> {
      // Names come from a fixed list, never from the request, so they are safe to splice in.
      const signature: readonly string[] = RPC_SIGNATURES[name];
      const placeholders = signature.map((arg, index) => `${arg} => $${index + 1}::text`);
      const params = signature.map((arg) => args[arg] ?? null);
      // One transaction per call keeps `set local role` from leaking between requests.
      const result = await db.transaction(async (tx) => {
        await tx.exec('set local role service_role');
        return tx.query<{ result: unknown }>(
          `select public.${name}(${placeholders.join(', ')}) as result`,
          params,
        );
      });
      return result.rows[0]?.result ?? null;
    },
  };
}

export interface LocalApiOptions extends LocalEvent {
  port: number;
  passcode: string;
  hashSecret?: string;
  eventId?: string;
  /** The sites allowed to call this API from a browser. Same rule as production: no wildcard. */
  allowedOrigins?: readonly string[];
}

export interface LocalApiServer {
  url: string;
  db: PGlite;
  /** Stops accepting connections but keeps the data, to simulate the connection dropping. */
  pause(): Promise<void>;
  resume(): Promise<void>;
  close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error('body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

export async function startLocalApiServer(options: LocalApiOptions): Promise<LocalApiServer> {
  const db = await createLocalDatabase(options);
  const handler = createApiHandler({
    database: createPgliteDatabase(db),
    identity: createEmailIdentityResolver({
      secret: options.hashSecret ?? randomSecret(32),
      eventId: options.eventId ?? 'local-rehearsal',
    }),
    adminPasscode: options.passcode,
    allowedOrigins: options.allowedOrigins ?? [],
  });

  const handle = async (incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (typeof value === 'string') headers.set(name, value);
    }
    const hasBody = incoming.method !== 'GET' && incoming.method !== 'HEAD';
    const request = new Request(`http://localhost:${options.port}${incoming.url ?? '/'}`, {
      method: incoming.method,
      headers,
      body: hasBody ? (await readBody(incoming)).toString('utf8') : undefined,
    });

    // CORS is answered by the handler itself, exactly as it would be in production.
    // The local stand-in reports the socket address, as a platform would report the caller's.
    const response = await handler(request, { clientIp: incoming.socket.remoteAddress });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    outgoing.end(await response.text());
  };

  let server: Server | null = null;
  const listen = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const created = createServer((incoming, outgoing) => {
        handle(incoming, outgoing).catch(() => {
          outgoing.writeHead(500, { 'Content-Type': 'application/json' });
          outgoing.end(JSON.stringify({ message: 'Server error' }));
        });
      });
      created.once('error', reject);
      created.listen(options.port, '127.0.0.1', () => {
        server = created;
        resolve();
      });
    });
  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      const current = server;
      server = null;
      if (current === null) {
        resolve();
        return;
      }
      current.close(() => resolve());
      current.closeAllConnections();
    });

  await listen();
  return {
    url: `http://localhost:${options.port}`,
    db,
    pause: stop,
    resume: listen,
    close: async () => {
      await stop();
      await db.close();
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { contestants, votingWindow, votingRules, event } = await import('../event.config');
  const passcode = process.env.ADMIN_PASSCODE ?? 'local-rehearsal-passcode';
  // The configured window is weeks away, so a rehearsal would only ever show "not open yet".
  // OPEN_NOW=1 swaps in a window that is open for the next 24 hours.
  const window =
    process.env.OPEN_NOW === '1'
      ? {
          opensAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          closesAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          autoOpen: true,
        }
      : votingWindow;
  const server = await startLocalApiServer({
    port: Number(process.env.PORT ?? 54329),
    passcode,
    eventId: event.id,
    contestants,
    window,
    rules: votingRules,
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
      .split(',')
      .map((origin) => origin.trim()),
  });
  console.log(`Local API stand-in listening on ${server.url}/api`);
  console.log(`Admin passcode: ${passcode}`);
  console.log(`Voting window: ${window.opensAt ?? 'no start'} to ${window.closesAt ?? 'no end'}`);
  console.log('Browsers may call it from: http://localhost:5173 (set ALLOWED_ORIGINS to change)');
  console.log('Data is in memory only and is lost when this stops.');
  console.log('\nRun the site against it, in a second terminal, with:');
  console.log(`  VITE_STORAGE_ADAPTER=api VITE_API_BASE_URL=${server.url}/api npm run dev`);
}
