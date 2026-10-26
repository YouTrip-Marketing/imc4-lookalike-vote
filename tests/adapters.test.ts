import { createHash } from 'node:crypto';
/**
 * The platform adapters: Supabase Edge Function and Netlify Function.
 *
 * The Supabase test runs the actual bundle that `npm run build:edge` produces,
 * under Node, with a stand-in for the `Deno` global and with database calls
 * routed into an embedded Postgres holding the real schema.sql.
 *
 * What this proves: the adapters' own logic, and that the bundle is
 * self-contained and works end to end.
 * What it cannot prove: how either platform behaves for real (limits, cold
 * starts, its own logging). That needs the real platform.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { contestants, demo, event, keyVisual, promoBanner, votingWindow } from '../event.config';
import { buildEdgeFunction } from '../scripts/build-edge-function';
import { KEY_VISUAL_MAX_BYTES, checkDeploy, checkRepository, readCodeGsFacts, readRepositoryFacts } from '../scripts/check-deploy';
import { createLocalDatabase, createPgliteDatabase } from '../scripts/local-api-server';
import type { RpcName } from '../server/database';
import { CONTESTANT_IDS, ONE_VOTE, requestId } from './fixtures';

const SITE = 'https://youtrip-marketing.github.io';
const PROJECT = 'https://project-ref.supabase.co';
const SERVICE_KEY = 'service-role-key-for-tests';
const ENV = {
  SUPABASE_URL: PROJECT,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  VOTER_HASH_SECRET: 'adapter-test-secret-at-least-32-chars',
  ADMIN_PASSCODE: 'adapter-admin-passcode',
  ALLOWED_ORIGINS: SITE,
};

type Envelope = { ok: boolean; data?: unknown; error?: string };
type Served = (request: Request) => Promise<Response>;

let db: PGlite;
let workDir: string;
let bundlePath: string;
let bundleText: string;
let loads = 0;
const databaseCalls: { url: string; headers: Record<string, string> }[] = [];

/** Stands in for Supabase's REST layer: runs the named function in the embedded Postgres. */
const fakePostgrest: typeof fetch = async (input, init) => {
  const url = String(input);
  databaseCalls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
  const name = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
  if (!url.startsWith(PROJECT) || name === undefined) return new Response('{}', { status: 404 });
  const args = JSON.parse(String(init?.body ?? '{}')) as Record<string, string | null>;
  const answer = await createPgliteDatabase(db).rpc(name as RpcName, args as never);
  return new Response(JSON.stringify(answer), { status: 200 });
};

/** Loads a fresh copy of the bundle, as a cold start would, and returns what it handed to Deno.serve. */
async function loadEdgeFunction(env: Record<string, string>): Promise<Served> {
  let served: Served | null = null;
  vi.stubGlobal('Deno', {
    env: { toObject: () => ({ ...env }) },
    serve: (handler: Served) => {
      served = handler;
    },
  });
  loads += 1;
  await import(/* @vite-ignore */ `${pathToFileURL(bundlePath).href}?load=${loads}`);
  if (served === null) throw new Error('the bundle did not call Deno.serve');
  return served;
}

function edgeRequest(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${PROJECT}/functions/v1/vote-api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: SITE, ...headers },
    body: JSON.stringify(body),
  });
}

const edgeVote = async (
  served: Served,
  contestantId: string,
  email: string,
  headers: Record<string, string> = {},
): Promise<Envelope> => {
  const response = await served(edgeRequest('vote', { contestantId, email, requestId: requestId() }, headers));
  return (await response.json()) as Envelope;
};

const ALICE = 'alice@example.com';
const BEN = 'ben@example.com';

beforeAll(async () => {
  db = await createLocalDatabase({
    contestants: CONTESTANT_IDS.map((id, index) => ({
      id,
      number: index + 1,
      stageName: `Contestant ${index + 1}`,
    })),
    window: { opensAt: null, closesAt: null, autoOpen: false },
    rules: ONE_VOTE,
  });
  workDir = mkdtempSync(join(tmpdir(), 'imc4-edge-'));
  bundlePath = await buildEdgeFunction(join(workDir, 'index.js'));
  bundleText = readFileSync(bundlePath, 'utf8');
});

afterAll(async () => {
  await db.close();
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.exec(`
    delete from public.vote_audit;
    delete from public.votes;
    delete from public.rate_buckets;
    update public.event_settings set admin_status = 'open' where id = 1;
  `);
  databaseCalls.length = 0;
  vi.stubGlobal('fetch', fakePostgrest);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('the Supabase Edge Function bundle', () => {
  it('is one self-contained file: nothing to resolve at deploy time', () => {
    expect(bundleText).not.toMatch(/^\s*import\s/m);
    expect(bundleText).not.toMatch(/\bfrom\s+["'][./]/);
    expect(bundleText).not.toMatch(/\brequire\(/);
    expect(bundleText).toContain('Deno.serve');
  });

  it('carries no demo passcode, no Node-only code and no secrets', () => {
    expect(bundleText).not.toContain(demo.passcode);
    expect(bundleText).not.toMatch(/\bprocess\.env\b/);
    expect(bundleText).not.toMatch(/node:/);
    for (const secret of [ENV.VOTER_HASH_SECRET, ENV.ADMIN_PASSCODE, SERVICE_KEY]) {
      expect(bundleText).not.toContain(secret);
    }
  });

  it('is small enough to read', () => {
    expect(bundleText.length).toBeLessThan(40_000);
  });
});

describe('Supabase Edge Function: voting', () => {
  it('accepts a vote and rejects a second from the same email', async () => {
    const served = await loadEdgeFunction(ENV);
    expect((await edgeVote(served, 'c01', ALICE)).ok).toBe(true);
    expect((await edgeVote(served, 'c02', ALICE)).error).toBe('duplicate_vote');
    expect((await edgeVote(served, 'c02', BEN)).ok).toBe(true);
  });

  it('talks to the database with the service key, in headers, at the project’s own address', async () => {
    const served = await loadEdgeFunction(ENV);
    await edgeVote(served, 'c01', ALICE);
    expect(databaseCalls).toHaveLength(1);
    expect(databaseCalls[0]?.url).toBe(`${PROJECT}/rest/v1/rpc/cast_vote`);
    expect(databaseCalls[0]?.headers).toMatchObject({
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    });
  });

  it('prefers DB_SERVICE_KEY when one is set', async () => {
    const served = await loadEdgeFunction({ ...ENV, DB_SERVICE_KEY: 'newer-secret-key' });
    await edgeVote(served, 'c01', ALICE);
    expect(databaseCalls[0]?.headers).toMatchObject({ apikey: 'newer-secret-key' });
  });

  it('stores a hash, never the address, and sends no address to the database', async () => {
    const served = await loadEdgeFunction(ENV);
    await edgeVote(served, 'c01', ALICE);
    const rows = await db.query<{ voter_key: string }>('select voter_key from public.votes');
    expect(rows.rows[0]?.voter_key).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows.rows)).not.toContain('alice');
    expect(JSON.stringify(databaseCalls)).not.toContain('alice');
  });
});

describe('Supabase Edge Function: the IP address is recorded, never enforced', () => {
  const recordedIps = async (): Promise<string[]> =>
    (await db.query<{ ip: string }>('select ip from public.vote_audit order by vote_id')).rows.map((r) => r.ip);

  it('counts different people behind one address as different voters', async () => {
    const served = await loadEdgeFunction(ENV);
    const sameWifi = { 'X-Forwarded-For': '203.0.113.7' };
    expect((await edgeVote(served, 'c01', ALICE, sameWifi)).ok).toBe(true);
    expect((await edgeVote(served, 'c01', BEN, sameWifi)).ok).toBe(true);
    expect(await recordedIps()).toEqual(['203.0.113.7', '203.0.113.7']);
  });

  it('a made-up X-Forwarded-For buys nothing', async () => {
    const served = await loadEdgeFunction(ENV);
    await edgeVote(served, 'c01', ALICE, { 'X-Forwarded-For': '203.0.113.7' });
    const forged = await edgeVote(served, 'c02', ALICE, { 'X-Forwarded-For': '192.0.2.1' });
    expect(forged.error).toBe('duplicate_vote');
  });

  it('records the entry the platform added (the right end), not the one a caller can write', async () => {
    const served = await loadEdgeFunction(ENV);
    await edgeVote(served, 'c01', ALICE, { 'X-Forwarded-For': '192.0.2.1, 203.0.113.7' });
    expect(await recordedIps()).toEqual(['203.0.113.7']);
  });

  it('counts back further when TRUSTED_PROXY_HOPS says the platform adds two entries', async () => {
    const served = await loadEdgeFunction({ ...ENV, TRUSTED_PROXY_HOPS: '2' });
    await edgeVote(served, 'c01', ALICE, { 'X-Forwarded-For': '192.0.2.1, 203.0.113.7, 10.0.0.1' });
    expect(await recordedIps()).toEqual(['203.0.113.7']);
  });

  it('a bad TRUSTED_PROXY_HOPS never stops a vote: it falls back to 1', async () => {
    const served = await loadEdgeFunction({ ...ENV, TRUSTED_PROXY_HOPS: 'many' });
    expect((await edgeVote(served, 'c01', ALICE, { 'X-Forwarded-For': '203.0.113.7' })).ok).toBe(true);
    expect(await recordedIps()).toEqual(['203.0.113.7']);
  });

  it.each([
    ['no header at all', {}],
    ['an empty header', { 'X-Forwarded-For': '' }],
    ['something that is not an address', { 'X-Forwarded-For': 'unknown' }],
  ])('counts the vote with %s, and records an empty IP', async (_name, headers) => {
    const served = await loadEdgeFunction(ENV);
    expect((await edgeVote(served, 'c01', ALICE, headers)).ok).toBe(true);
    expect(await recordedIps()).toEqual(['']);
  });
});

describe('Supabase Edge Function: cross-origin', () => {
  it('answers the preflight from the GitHub Pages site', async () => {
    const served = await loadEdgeFunction(ENV);
    const response = await served(
      new Request(`${PROJECT}/functions/v1/vote-api/vote`, {
        method: 'OPTIONS',
        headers: { Origin: SITE, 'Access-Control-Request-Method': 'POST' },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(SITE);
  });

  it('refuses any other site', async () => {
    const served = await loadEdgeFunction(ENV);
    const response = await served(
      edgeRequest('vote', { contestantId: 'c01', email: ALICE, requestId: requestId() }, {
        Origin: 'https://evil.example',
      }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(databaseCalls).toHaveLength(0);
  });

  it('with ALLOWED_ORIGINS unset, the GitHub Pages site cannot call it either', async () => {
    const { ALLOWED_ORIGINS: _unset, ...withoutOrigins } = ENV;
    const served = await loadEdgeFunction(withoutOrigins);
    const response = await served(edgeRequest('session', {}));
    expect(response.status).toBe(403);
  });
});

describe('Supabase Edge Function: refuses to run half-configured', () => {
  it.each([
    ['no hashing secret', { VOTER_HASH_SECRET: '' }],
    ['a short hashing secret', { VOTER_HASH_SECRET: 'too-short' }],
    ['only the old IP-era secret name', { VOTER_HASH_SECRET: '', IP_HASH_SECRET: ENV.VOTER_HASH_SECRET }],
    ['no service key', { SUPABASE_SERVICE_ROLE_KEY: '' }],
    ['no project address', { SUPABASE_URL: '' }],
    ['a wildcard origin', { ALLOWED_ORIGINS: '*' }],
    ['an origin with a path', { ALLOWED_ORIGINS: `${SITE}/imc4-vote` }],
  ])('%s', async (_name, override) => {
    const served = await loadEdgeFunction({ ...ENV, ...override });
    expect(await edgeVote(served, 'c01', ALICE)).toEqual({
      ok: false,
      error: 'misconfigured',
    });
    expect(databaseCalls).toHaveLength(0);
  });

  it('a missing admin passcode switches off admin, and leaves voting on', async () => {
    const served = await loadEdgeFunction({ ...ENV, ADMIN_PASSCODE: '' });
    expect((await edgeVote(served, 'c01', ALICE)).ok).toBe(true);
    const response = await served(edgeRequest('admin/snapshot', { passcode: '' }));
    expect(await response.json()).toEqual({ ok: false, error: 'misconfigured' });
  });
});

describe('Netlify Function', () => {
  async function loadNetlify(env: Record<string, string>) {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const { netlifyFunction } = await import('../server/adapters/netlify');
    return netlifyFunction;
  }

  const netlifyVote = (
    contestantId: string,
    email: string,
    headers: Record<string, string> = {},
  ): Request =>
    new Request('https://vote.example.com/api/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://vote.example.com', ...headers },
      body: JSON.stringify({ contestantId, email, requestId: requestId() }),
    });

  const answer = async (response: Response): Promise<Envelope> => (await response.json()) as Envelope;

  it('counts votes against the email', async () => {
    const run = await loadNetlify(ENV);
    const first = await answer(await run(netlifyVote('c01', ALICE)));
    const second = await answer(await run(netlifyVote('c02', ALICE)));
    const third = await answer(await run(netlifyVote('c02', BEN)));
    expect([first.ok, second.error, third.ok]).toEqual([true, 'duplicate_vote', true]);
  });

  const recordedIps = async (): Promise<string[]> =>
    (await db.query<{ ip: string }>('select ip from public.vote_audit order by vote_id')).rows.map((r) => r.ip);

  it('records context.ip and ignores address headers, and a shared address blocks nobody', async () => {
    const run = await loadNetlify(ENV);
    const forged = { 'X-Forwarded-For': '192.0.2.99', 'X-Nf-Client-Connection-Ip': '192.0.2.99' };
    expect((await answer(await run(netlifyVote('c01', ALICE, forged), { ip: '203.0.113.7' }))).ok).toBe(true);
    expect((await answer(await run(netlifyVote('c01', BEN, forged), { ip: '203.0.113.7' }))).ok).toBe(true);
    expect(await recordedIps()).toEqual(['203.0.113.7', '203.0.113.7']);
  });

  it('counts the vote when context.ip is missing, and records an empty IP', async () => {
    const run = await loadNetlify(ENV);
    expect((await answer(await run(netlifyVote('c01', ALICE), {}))).ok).toBe(true);
    expect(await recordedIps()).toEqual(['']);
  });

  it('refuses to run half-configured', async () => {
    const run = await loadNetlify({ ...ENV, VOTER_HASH_SECRET: '' });
    expect(await answer(await run(netlifyVote('c01', ALICE)))).toEqual({
      ok: false,
      error: 'misconfigured',
    });
  });
});

describe('the deploy check', () => {
  const ready = {
    VITE_STORAGE_ADAPTER: 'api',
    VITE_API_BASE_URL: 'https://project-ref.supabase.co/functions/v1/vote-api',
    ALLOW_PENDING_LEGAL: '1',
  };

  it('passes a build that points at a real API', () => {
    expect(checkDeploy(ready).ok).toBe(true);
  });

  it('refuses to publish the demo', () => {
    for (const adapter of [undefined, '', 'local']) {
      const result = checkDeploy({ ...ready, VITE_STORAGE_ADAPTER: adapter });
      expect(result.ok).toBe(false);
      expect(result.problems.join(' ')).toMatch(/DEMO/);
    }
  });

  describe('Google Sheet store (production from 26 Oct 2026)', () => {
    const sheetEnv = {
      VITE_STORAGE_ADAPTER: 'sheet',
      VITE_SHEET_ENDPOINT: 'https://script.google.com/macros/s/AKfycbAbc_123-x/exec',
    };
    const goodCodeGs = {
      adminKeySha256: 'a'.repeat(64),
      opensAt: votingWindow.opensAt ?? '',
      closesAt: votingWindow.closesAt ?? '',
      sheetId: 'sheet-id',
    };
    const cfg = (overrides: Record<string, unknown> = {}) => ({
      contestants,
      event: { ...event, legalReviewPending: false },
      votingWindow,
      keyVisual,
      promoBanner: { ...promoBanner, href: 'https://www.you.co/sg/blog/100-flights-to-korea/' },
      ...overrides,
    });
    const problems = (env: Record<string, string | undefined>, config = cfg(), codeGs: unknown = goodCodeGs): string =>
      checkDeploy(env, config as Parameters<typeof checkDeploy>[1], undefined, undefined, codeGs as never).problems.join(' ');

    it('passes when every production condition holds', () => {
      expect(problems(sheetEnv)).toBe('');
    });

    it('refuses the TEST SITE build', () => {
      expect(problems({ ...sheetEnv, VITE_TEST_DEPLOY: '1' })).toMatch(/TEST SITE build/);
    });

    it.each(['', 'https://example.com/exec', 'https://script.google.com/macros/s/abc/dev', 'http://script.google.com/macros/s/abc/exec'])(
      'refuses a sheet address of "%s"',
      (endpoint) => {
        expect(problems({ ...sheetEnv, VITE_SHEET_ENDPOINT: endpoint })).toMatch(/VITE_SHEET_ENDPOINT/);
      },
    );

    it('refuses while legal review is pending', () => {
      expect(problems(sheetEnv, cfg({ event: { ...event, legalReviewPending: true } }))).toMatch(/legalReviewPending/);
    });

    it('refuses without the blog link on the promo', () => {
      expect(problems(sheetEnv, cfg({ promoBanner: { ...promoBanner, href: '' } }))).toMatch(/promoBanner\.href/);
    });

    it('refuses without a real admin passcode in Code.gs', () => {
      expect(problems(sheetEnv, cfg(), { ...goodCodeGs, adminKeySha256: 'NOT-SET' })).toMatch(/admin passcode hash/);
      const demoHash = createHash('sha256').update('demo-admin').digest('hex');
      expect(problems(sheetEnv, cfg(), { ...goodCodeGs, adminKeySha256: demoHash })).toMatch(/DEMO admin passcode/);
    });

    it('refuses when Code.gs and event.config.ts disagree on the window, or Code.gs is missing', () => {
      expect(problems(sheetEnv, cfg(), { ...goodCodeGs, closesAt: '2026-11-06T23:59:00+08:00' })).toMatch(/does not match/);
      expect(problems(sheetEnv, cfg(), null)).toMatch(/Code\.gs is missing/);
    });

    it('the real Code.gs and config pass the sheet checks today (the address aside)', () => {
      const real = readCodeGsFacts(resolve(import.meta.dirname, '..', 'apps-script', 'Code.gs'));
      expect(problems(sheetEnv, cfg({ event, promoBanner }), real)).toBe('');
    });

    it('an api build carrying a sheet address is refused', () => {
      expect(checkDeploy({ ...ready, VITE_SHEET_ENDPOINT: sheetEnv.VITE_SHEET_ENDPOINT }).problems.join(' ')).toMatch(/VITE_SHEET_ENDPOINT/);
    });
  });

  it.each([undefined, '', '/api', 'http://project-ref.supabase.co/functions/v1/vote-api', 'https://host'])(
    'refuses an API address of "%s": GitHub Pages has no server of its own',
    (base) => {
      const result = checkDeploy({ ...ready, VITE_API_BASE_URL: base });
      expect(result.ok).toBe(false);
      expect(result.problems.join(' ')).toMatch(/VITE_API_BASE_URL/);
    },
  );

  it('refuses while the wording is pending legal review', () => {
    const result = checkDeploy(
      { ...ready, ALLOW_PENDING_LEGAL: undefined },
      { contestants, event: { ...event, legalReviewPending: true }, votingWindow, keyVisual, promoBanner },
    );
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/legalReviewPending/);
    // Revision 5: the legal gate now covers the T&Cs on collecting email and IP.
    expect(result.problems.join(' ')).toMatch(/email address and IP/);
  });

  it('warns about placeholder contestants without blocking', () => {
    const result = checkDeploy(ready);
    expect(result.warnings.join(' ')).toMatch(/placeholder/);
  });

  describe('key visual', () => {
    const base = { contestants, event, votingWindow, promoBanner };
    const kv = (mobile: string | null, alt = 'Key visual', desktop: string | null = null) => ({
      ...base,
      keyVisual: { mobile, desktop, alt },
    });
    let publicDir: string;
    beforeEach(() => {
      publicDir = mkdtempSync(join(tmpdir(), 'imc4-public-'));
      mkdirSync(join(publicDir, 'key-visual'));
      writeFileSync(join(publicDir, 'key-visual', 'mobile.jpg'), 'x');
    });
    afterEach(() => rmSync(publicDir, { recursive: true, force: true }));

    it('warns, but does not block, when no key visual is set', () => {
      const result = checkDeploy(ready, kv(null));
      expect(result.ok).toBe(true);
      expect(result.warnings.join(' ')).toMatch(/No key visual is set/);
    });

    it('is quiet about it once an image with alt text is set and the file exists', () => {
      const result = checkDeploy(ready, kv('key-visual/mobile.jpg'), undefined, publicDir);
      expect(result.warnings.join(' ')).not.toMatch(/key visual/i);
    });

    it('warns when a key visual file is over the 250 KB the spec asks for, without blocking', () => {
      writeFileSync(join(publicDir, 'key-visual', 'big.png'), Buffer.alloc(KEY_VISUAL_MAX_BYTES + 1));
      writeFileSync(join(publicDir, 'key-visual', 'small.png'), Buffer.alloc(KEY_VISUAL_MAX_BYTES));
      const result = checkDeploy(ready, kv('key-visual/small.png', 'Key visual', 'key-visual/big.png'), undefined, publicDir);
      const text = result.warnings.join(' ');
      expect(text).toMatch(/Key visual file is 250 KB: public\/key-visual\/big\.png/);
      expect(text).not.toMatch(/small\.png/);
      expect(result.ok).toBe(true);
    });

    it('as configured today: no longer says the key visual is missing, and the two WebPs are within 250 KB', () => {
      const project = resolve(import.meta.dirname, '..', 'public');
      const text = checkDeploy(ready, { ...base, keyVisual }, undefined, project).warnings.join(' ');
      expect(text).not.toMatch(/No key visual is set/);
      expect(text).not.toMatch(/key visual has no alt text/i);
      expect(text).not.toMatch(/Key visual file not found/);
      expect(text).not.toMatch(/Key visual file is \d+ KB/);
    });

    it('warns about missing alt text and missing files', () => {
      const result = checkDeploy(ready, kv('key-visual/mobile.jpg', ' ', 'key-visual/desktop.jpg'), undefined, publicDir);
      const text = result.warnings.join(' ');
      expect(text).toMatch(/no alt text/);
      expect(text).toMatch(/not found: public\/key-visual\/desktop\.jpg/);
      expect(text).not.toMatch(/not found: public\/key-visual\/mobile\.jpg/);
      expect(result.ok).toBe(true);
    });
  });

  describe('promo banner', () => {
    const withPromo = (promo: Partial<typeof promoBanner>) => ({
      contestants,
      event,
      votingWindow,
      keyVisual,
      promoBanner: { ...promoBanner, ...promo },
    });
    const text = (promo: Partial<typeof promoBanner>, publicDir?: string): string =>
      checkDeploy(ready, withPromo(promo), undefined, publicDir).warnings.join(' ');

    it('as configured today: links to the blog, so no promo warning, and never blocks', () => {
      const result = checkDeploy(ready, withPromo({}));
      expect(result.ok).toBe(true);
      expect(result.warnings.join(' ')).not.toMatch(/promo banner has no link/);
      expect(result.warnings.join(' ')).not.toMatch(/no phone version/);
    });

    it('warns when there is no link', () => {
      expect(text({ href: '' })).toMatch(/promo banner has no link/);
    });

    it('warns when there is no phone version', () => {
      expect(text({ phoneImage: null })).toMatch(/no phone version/);
    });

    it('warns that a non-https link will be ignored', () => {
      expect(text({ href: 'javascript:alert(1)' })).toMatch(/not an https:\/\/ address/);
      expect(text({ href: 'http://example.com' })).toMatch(/not an https:\/\/ address/);
    });

    it('is quiet once a link and a phone image are set and the files exist', () => {
      const project = resolve(import.meta.dirname, '..', 'public');
      const quiet = text({ href: 'https://example.com/fly100kr', phoneImage: promoBanner.image }, project);
      expect(quiet).not.toMatch(/promo/i);
    });

    it('warns about a file that is not in public/', () => {
      const project = resolve(import.meta.dirname, '..', 'public');
      expect(text({ image: 'promo/missing.jpg' }, project)).toMatch(/Promo banner file not found: public\/promo\/missing\.jpg/);
    });

    it('says nothing when no promo image is configured', () => {
      expect(text({ image: null })).not.toMatch(/promo/i);
    });
  });

  it('as the project stands today, it does not pass', () => {
    expect(checkDeploy({}).ok).toBe(false);
  });

  describe('which repository would it publish to', () => {
    const own = {
      projectRoot: '/work/imc4-vote',
      repositoryRoot: '/work/imc4-vote',
      originUrl: 'https://github.com/YouTrip-Marketing/imc4-vote.git',
    };

    it('passes a project with its own repository and remote', () => {
      expect(checkRepository(own)).toEqual([]);
      expect(checkDeploy(ready, undefined, own).ok).toBe(true);
    });

    it('refuses when the project sits inside somebody else’s repository', () => {
      const nested = { ...own, projectRoot: '/work/workspace/developer/builds/imc4-vote', repositoryRoot: '/work/workspace' };
      expect(checkRepository(nested).join(' ')).toMatch(/inside another git repository/);
      expect(checkDeploy(ready, undefined, nested).ok).toBe(false);
    });

    it('refuses when there is no repository, or nowhere to publish to', () => {
      expect(checkRepository({ ...own, repositoryRoot: null }).join(' ')).toMatch(/not a git repository/);
      expect(checkRepository({ ...own, originUrl: null }).join(' ')).toMatch(/no `origin` remote/);
    });

    it('reads this project’s real situation from git, and judges it by the same rule', () => {
      // Written so it holds wherever the project lives: inside the workspace's
      // repository (refused) or, later, in a repository of its own (allowed).
      const facts = readRepositoryFacts(resolve(import.meta.dirname, '..'));
      const ownRepository =
        facts.repositoryRoot === facts.projectRoot && facts.originUrl !== null;
      expect(checkRepository(facts).length === 0).toBe(ownRepository);
      expect(checkDeploy(ready, undefined, facts).ok).toBe(ownRepository);
    });
  });
});
