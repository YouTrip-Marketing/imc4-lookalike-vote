/**
 * End-to-end smoke test in a real (headless) browser.
 *
 *   npm run test:e2e
 *
 * Part A  builds the DEMO site and clicks through the public vote and the admin view.
 * Layout  the same demo at 360, 390 and 430px phone widths and 1280px desktop:
 *         every voter state plus admin, screenshotted and checked for overflow,
 *         small tap targets and a confirm sheet that fits above a keyboard.
 * Part B  builds the PRODUCTION-adapter site and runs it against the local API
 *         stand-in: the real server handler and the real schema.sql in an
 *         embedded Postgres. Every browser here reaches the API from 127.0.0.1,
 *         which is exactly a shared wifi: one address, many voters.
 *
 * Uses the Chrome already installed on this machine; nothing is downloaded.
 * Everything stays on localhost. Screenshots land in e2e-artifacts/.
 *
 * What this does NOT test: a real phone, a real on-screen keyboard, the real
 * Instagram in-app browser, or a real hosting platform. Headless Chrome with a
 * phone-sized window is a layout and logic check, not a device test.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import puppeteer, { type Browser, type BrowserContext, type Page } from 'puppeteer-core';
import { build, preview, type Plugin, type PreviewServer } from 'vite';
import { burstRule, contestants, demo, event, keyVisual, promoBanner, promoDetails, votingWindow } from '../event.config';
import { formatCalendarDateWithYear, formatSgtDateTime, formatSgtDayMonth } from '../src/domain/time';
import { startLocalApiServer, type LocalApiServer } from './local-api-server';
import { LONG_PITCH, SHORT_PITCH, STUB_IP, dryRunContestants, startSheetStubServer, type SheetStubServer } from './sheet-stub-server';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(ROOT, 'e2e-artifacts');
/**
 * The made-up sample for Kelicia, rewritten on every run, in developer/outbox/.
 * Found by walking up to the `developer` folder, because the project sits at a
 * different depth in live and in _staging. Outside the workspace layout it
 * goes to e2e-artifacts/ instead, never anywhere else.
 */
function sampleAuditPath(): string {
  for (let dir = ROOT; dir !== dirname(dir); dir = dirname(dir)) {
    if (basename(dir) === 'developer' && existsSync(join(dir, 'outbox'))) {
      return join(dir, 'outbox', 'imc4-voting-site-audit-export-sample.csv');
    }
  }
  return join(OUT, 'audit-export-sample.csv');
}
const SAMPLE_AUDIT_CSV = sampleAuditPath();
const BUILDS = join(OUT, '.build');
const SITE_PORT_DEMO = 4179;
const SITE_PORT_PROD = 4180;
const SITE_PORT_KV = 4181;
const SITE_PORT_NO_KV = 4182;
const SITE_PORT_PROD_NO_KV = 4183;
const SITE_PORT_SHEET = 4184;
const SHEET_STUB_PORT = 4190;
const SITE_PORT_SHEET_PROD = 4185;
const SITE_PORT_SHEET_PROD_OPEN = 4186;
const SHEET_STUB_PROD_PORT = 4191;
const SHEET_STUB_PROD_OPEN_PORT = 4192;
/** Made up for the e2e stand-in sheets. Not the real admin passcode. */
const SHEET_ADMIN = 'e2e-sheet-admin-passcode-not-real';
/** GitHub Pages serves the production site under this folder. */
const PAGES_BASE = '/imc4-lookalike-vote/';
const API_PORT = 54329;
const PROD_PASSCODE = 'e2e-admin-passcode-not-a-secret';
const PROD_HASH_SECRET = 'e2e-hash-secret-not-a-secret-0123456789';
type Viewport = { width: number; height: number; deviceScaleFactor: number; isMobile?: boolean; hasTouch?: boolean };
const phone = (width: number, height: number): Viewport => ({
  width,
  height,
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const PHONE = phone(390, 844);
const LAPTOP: Viewport = { width: 1280, height: 900, deviceScaleFactor: 1 };
const LAYOUTS: readonly { name: string; viewport: Viewport }[] = [
  { name: '360', viewport: phone(360, 740) },
  { name: '390', viewport: PHONE },
  { name: '430', viewport: phone(430, 932) },
  { name: '1280', viewport: LAPTOP },
];

// Addresses at domains reserved for documentation. Nothing is ever sent to them.
const EMAIL = {
  alice: 'alice.tan@example.com',
  flatmate: 'ben.lim@example.com',
  colleague: 'chloe.ng@example.org',
  gmail: 'jane.doe@gmail.com',
  train: 'dev.k@example.net',
  instagram: 'ig.visitor@example.com',
  locked: 'locked.down@example.com',
  oldPhone: 'old.phone@example.com',
};

const INSTAGRAM_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
  'Mobile/22F76 Instagram 385.0.0.29.74 (iPhone15,3; iOS 18_5; en_SG; en; scale=3.00; 1290x2796; 748292391)';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const DUPLICATE = 'A vote has already been counted for this email.';
// Revision 10: Kelicia's wording, verbatim.
const OPEN_H1 = `Who makes the final ${event.advancing}?`;
const OPEN_LEDE = 'Vote your favourite lookalike now! Voting closes Thu 12 Nov, 11:59pm SGT.';
const RULE_LINE = 'One vote per person. It cannot be changed once you confirm.';
// Revision 12: the winner line replaces "Top 10 will be announced ...".
const WINNER_LINE = `The winner will be announced on ${formatCalendarDateWithYear(event.winnerAnnouncedOn)}.`;
const ANOTHER_PERSON = 'Someone else voting on this phone? Vote with their email';

let passed = 0;
const requestsSeen = new Set<string>();
const fontFilesSeen = new Set<string>();
const pageErrors: string[] = [];

async function step(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    // An exception inside the page fails the step it happened in.
    assert.deepEqual(pageErrors, [], 'the page threw an uncaught error');
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    console.log(`  FAIL  ${name}`);
    throw error;
  }
}

interface OpenOptions {
  viewport?: Viewport;
  userAgent?: string;
  /**
   * Runs in the page before any of its own scripts. Pass source text for anything
   * with a nested function: this file is compiled before it runs, and compiled
   * functions can refer to helpers that do not exist inside the page.
   */
  before?: (() => void) | string;
}

async function open(context: BrowserContext, url: string, options: OpenOptions = {}): Promise<Page> {
  const page = await context.newPage();
  await page.setViewport(options.viewport ?? PHONE);
  if (options.userAgent !== undefined) await page.setUserAgent(options.userAgent);
  if (options.before !== undefined) await page.evaluateOnNewDocument(options.before);
  page.on('request', (request) => {
    requestsSeen.add(new URL(request.url()).origin);
    if (/\.woff2?$/.test(request.url())) fontFilesSeen.add(request.url());
  });
  page.on('pageerror', (error) => {
    pageErrors.push(`${url}: ${String(error)}`);
  });
  await page.goto(url, { waitUntil: 'load' });
  return page;
}

/**
 * Pages stop polling while their tab is hidden (by design, to spare phone
 * batteries and the backend), so each check first brings its tab to the front,
 * exactly as a person looking at that screen would have it.
 */
/**
 * The page's visible text in its WRITTEN case. Headlines, names and buttons are
 * upper-cased by CSS, and innerText reports what is rendered, so for the
 * instant of the read the upper-casing is switched off. It is added and removed
 * inside one synchronous script, so nothing is ever painted without it.
 */
const READ_TEXT = `(() => {
  const style = document.createElement('style');
  style.textContent = '* { text-transform: none !important; }';
  document.head.append(style);
  const read = document.body.innerText;
  style.remove();
  return read;
})()`;

async function see(page: Page, text: string, timeout = 15_000): Promise<void> {
  await page.bringToFront();
  try {
    await page.waitForFunction(`${READ_TEXT}.includes(${JSON.stringify(text)})`, { timeout });
  } catch {
    const body = await page.evaluate(READ_TEXT);
    throw new Error(`Expected to see "${text}". Page said:\n${String(body)}`);
  }
}

const text = (page: Page): Promise<string> => page.evaluate(READ_TEXT) as Promise<string>;

/**
 * Clicks a button by its visible label, optionally inside a container.
 * Waits for the button to be enabled first, as a person would.
 */
async function press(page: Page, label: string, within = 'body'): Promise<void> {
  await page.bringToFront();
  if (!(label === 'Close' && within.includes('sheet--promo'))) await closePromoPopup(page);
  const find = (wanted: string, scope: string): HTMLButtonElement | null => {
    const root = document.querySelector(scope);
    if (root === null) return null;
    return (
      [...root.querySelectorAll<HTMLButtonElement>('button')].find(
        (candidate) =>
          (candidate.textContent ?? '').replace(/\s+/g, ' ').trim() === wanted && !candidate.disabled,
      ) ?? null
    );
  };
  try {
    await page.waitForFunction(
      (finder: string, wanted: string, scope: string) =>
        (new Function(`return (${finder})`)() as typeof find)(wanted, scope) !== null,
      { timeout: 10_000 },
      find.toString(),
      label,
      within,
    );
  } catch {
    const buttons = await page.$$eval('button', (all) =>
      all.map(
        (b) =>
          `${(b.textContent ?? '').trim().replace(/\s+/g, ' ')}${(b as HTMLButtonElement).disabled ? ' (disabled)' : ''}`,
      ),
    );
    throw new Error(`No enabled button "${label}" in ${within}. Buttons on the page: ${buttons.join(' | ')}`);
  }
  await page.evaluate(
    (finder: string, wanted: string, scope: string) => {
      (new Function(`return (${finder})`)() as typeof find)(wanted, scope)?.click();
    },
    find.toString(),
    label,
    within,
  );
}

/**
 * Revision 10: a counted vote opens the promo pop-up, which is modal. A person
 * closes it before tapping anything else on the page, so the helpers do too.
 */
async function closePromoPopup(page: Page): Promise<void> {
  if ((await page.$('dialog.sheet--promo[open]')) === null) return;
  await page.evaluate(() => {
    const close = [...document.querySelectorAll<HTMLButtonElement>('dialog.sheet--promo[open] button')].find(
      (button) => (button.textContent ?? '').trim() === 'Close',
    );
    close?.click();
  });
  await page.waitForFunction(() => document.querySelector('dialog.sheet--promo[open]') === null, { timeout: 5_000 });
}

/** Before a vote, the promo is nowhere on the page (Revision 10). */
async function noPromoYet(page: Page): Promise<void> {
  assert.equal(await page.$('.promo-banner'), null, 'the promo banner shows before a vote');
}

async function pickCard(page: Page, contestantNumber: number): Promise<void> {
  await closePromoPopup(page);
  await page.bringToFront();
  await page.waitForSelector(`.grid > li:nth-child(${contestantNumber}) .card__face:not(:disabled)`);
  await page.click(`.grid > li:nth-child(${contestantNumber}) .card__face`);
  await page.waitForSelector('dialog.sheet[open]');
}

/** Replaces whatever is in the email field with `email`, by keyboard, as a person would. */
async function typeEmail(page: Page, email: string): Promise<void> {
  await page.waitForSelector('#voter-email');
  await page.click('#voter-email', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  if (email !== '') await page.type('#voter-email', email);
}

async function voteFor(page: Page, contestantNumber: number, email: string): Promise<void> {
  await pickCard(page, contestantNumber);
  await see(page, `Vote for #${contestantNumber} Contestant ${contestantNumber}?`);
  await typeEmail(page, email);
  await press(page, 'Confirm vote', 'dialog.sheet');
}

/**
 * Everything wider than the screen, so a failure says what to fix. Source text,
 * not a function: it has helpers of its own (see OpenOptions.before).
 */
const FIND_OVERFLOW = `(() => {
  const width = document.documentElement.clientWidth;
  const found = [];
  if (document.documentElement.scrollWidth > width) {
    found.push('page scrolls sideways by ' + (document.documentElement.scrollWidth - width) + 'px');
  }
  // Content inside a box that clips it (a card's artwork, say) cannot stick out.
  const clipped = (element) => {
    for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
      if (getComputedStyle(parent).overflowX !== 'visible') return true;
    }
    return false;
  };
  for (const element of document.querySelectorAll('body *')) {
    const box = element.getBoundingClientRect();
    if (box.width === 0 || getComputedStyle(element).position === 'fixed' || clipped(element)) continue;
    if (box.right > width + 0.5 || box.left < -0.5) {
      found.push(element.tagName.toLowerCase() + '.' + element.getAttribute('class') +
        ' (' + Math.round(box.left) + '..' + Math.round(box.right) + ')');
    }
  }
  return found.slice(0, 8);
})()`;

const overflowing = (page: Page): Promise<string[]> => page.evaluate(FIND_OVERFLOW) as Promise<string[]>;

/** Tappable things smaller than 44px in either direction (Apple's and Google's guidance). */
async function smallTargets(page: Page, scope = 'body'): Promise<string[]> {
  return page.evaluate((root: string) => {
    const found: string[] = [];
    const scopeElement = document.querySelector(root);
    if (scopeElement === null) return found;
    for (const element of scopeElement.querySelectorAll<HTMLElement>('button, a, input')) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      // Links inside running text are exempt, as in WCAG 2.5.8.
      if (element.tagName === 'A' && element.closest('p') !== null) continue;
      if (box.height < 44 || box.width < 44) {
        found.push(`"${(element.innerText || element.id).trim().slice(0, 40)}" ${Math.round(box.width)}x${Math.round(box.height)}`);
      }
    }
    return found;
  }, scope);
}

const cardsDisabled = (page: Page): Promise<boolean> =>
  page.$$eval('.card__face', (buttons) =>
    buttons.every((button) => (button as HTMLButtonElement).disabled),
  );

async function unlockAdmin(page: Page, passcode: string): Promise<void> {
  await page.waitForSelector('#passcode');
  await page.type('#passcode', 'definitely-wrong');
  await press(page, 'Unlock');
  await see(page, "That passcode isn't right.");
  await page.$eval('#passcode', (input) => {
    (input as HTMLInputElement).select();
  });
  await page.keyboard.press('Backspace');
  await page.type('#passcode', passcode);
  await press(page, 'Unlock');
  await see(page, 'Tally and ranking');
}

async function votesCounted(page: Page, expected: number): Promise<void> {
  await page.bringToFront();
  try {
    await page.waitForFunction(
      (wanted: string) => document.querySelector('.stats strong')?.textContent === wanted,
      { timeout: 20_000 },
      expected.toLocaleString('en-SG'),
    );
  } catch {
    const shown = await page.$eval('.stats', (node) => (node as HTMLElement).innerText);
    throw new Error(`Expected ${expected} votes counted. Admin view shows: ${shown}`);
  }
}

/** Captures what the admin view hands to the browser as a download. */
/**
 * Captures what the admin view hands to the browser as a download: the file's
 * contents and the name it would be saved under. Source text (see OpenOptions.before).
 */
const captureDownloads = `(() => {
  const captured = [];
  const names = [];
  window.__downloads = captured;
  window.__downloadNames = names;
  const original = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (object) => {
    if (object instanceof Blob) void object.text().then((content) => captured.push(content));
    return original(object);
  };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download) names.push(this.download);
    return click.call(this);
  };
})()`;

const downloadNames = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __downloadNames: string[] }).__downloadNames);

/** Anything on screen that looks like an email or an IPv4 address. */
const PERSONAL_ON_SCREEN = /[^\s@]+@[^\s@]+\.[a-z]{2,}|\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/i;

const AUDIT_HEADER =
  'vote_id,cast_at_sgt,contestant_number,stage_name,status,email_as_typed,email_normalised,ip_address,ip_source,votes_from_this_ip';

/** Splits one CSV line with no quoted commas (true of every row these tests make). */
const cells = (line: string): string[] => line.split(',');

async function lastDownload(page: Page, count: number): Promise<string> {
  await page.waitForFunction(
    (wanted: number) => (window as unknown as { __downloads: string[] }).__downloads.length >= wanted,
    { timeout: 10_000 },
    count,
  );
  return page.evaluate(
    (wanted: number) => (window as unknown as { __downloads: string[] }).__downloads[wanted - 1] ?? '',
    count,
  );
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

async function buildSite(outDir: string, env: Record<string, string>, plugins: Plugin[] = []): Promise<void> {
  for (const key of ['VITE_STORAGE_ADAPTER', 'VITE_API_BASE_URL', 'VITE_SHEET_ENDPOINT', 'VITE_IP_LOOKUP_URL', 'VITE_TEST_DEPLOY']) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  await build({ root: ROOT, logLevel: 'error', plugins, build: { outDir, emptyOutDir: true } });
}

// ---------------------------------------------------------- stand-in content

const REAL_CONFIG = resolve(ROOT, 'event.config.ts');

/**
 * TEST ONLY. Builds the page as if event.config.ts had a key visual, some
 * photos, a 24-character name and a two-word name, without touching the real
 * config: every import of event.config.ts is pointed at a small module that
 * re-exports the real one and overrides two exports.
 */
function standInConfigPlugin(overridePath: string): Plugin {
  return {
    name: 'e2e-stand-in-config',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!/event\.config(\.ts)?$/.test(source) || importer === overridePath) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved?.id === REAL_CONFIG ? overridePath : null;
    },
  };
}

/** A made-up link for the promo banner in the stand-in build. Never visited. */
const STAND_IN_PROMO_LINK = 'https://example.com/fly100kr-stand-in';

/** The 24-character and the two-word name the brief asks to test. */
const LONG_NAME = 'Christopher Tan Wei Ming';
const SHORT_NAME = 'Jun Hao';

function writeStandInConfig(path: string): void {
  writeFileSync(
    path,
    `export * from ${JSON.stringify(REAL_CONFIG)};
import { contestants as real } from ${JSON.stringify(REAL_CONFIG)};
export const promoBanner = {
  image: 'promo/imc4-100-flights-korea-banner-1920x640.jpg',
  phoneImage: 'promo/phone-stand-in.svg',
  alt: 'Stand-in promo for testing',
  href: ${JSON.stringify(STAND_IN_PROMO_LINK)},
};
export const keyVisual = {
  mobile: 'key-visual/mobile.svg',
  desktop: 'key-visual/desktop.svg',
  alt: 'Stand-in key visual for testing',
};
const photos = { c01: 'light', c02: 'dark', c03: 'cast', c04: 'texture' };
export const contestants = real.map((c) => {
  if (c.id in photos) return { ...c, photo: 'contestants/' + photos[c.id] + '.svg' };
  if (c.id === 'c05') return { ...c, stageName: ${JSON.stringify(LONG_NAME)}, tagline: 'East side', handle: '@stand.in.handle' };
  if (c.id === 'c06') return { ...c, stageName: ${JSON.stringify(SHORT_NAME)}, tagline: ${JSON.stringify(LONG_PITCH)} };
  return c;
});
`,
  );
}

/**
 * TEST ONLY. The real config with the key visual slot emptied, so the demo
 * placeholder and the production collapse keep being tested now that the real
 * config has Kelicia's key visual (Revision 8).
 */
function writeNoKeyVisualConfig(path: string): void {
  writeFileSync(
    path,
    `export * from ${JSON.stringify(REAL_CONFIG)};
export const keyVisual = { mobile: null, desktop: null, alt: '' };
`,
  );
}

/**
 * Generated images, no people: an abstract key visual (with text so any
 * cropping shows), and four "difficult lighting" textures to put the photo
 * treatment under stress: blown-out white, near-black with one hot spot, a
 * strong orange colour cast, and fine high-contrast stripes.
 */
function writeStandInImages(outDir: string): void {
  const kv = (w: number, h: number, label: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff5fa2"/><stop offset=".5" stop-color="#7b3fe4"/><stop offset="1" stop-color="#0b0a12"/></linearGradient></defs>
  <rect width="${w}" height="${h}" fill="url(#g)"/>
  <circle cx="${w * 0.78}" cy="${h * 0.3}" r="${h * 0.42}" fill="#ffd54a" opacity=".55"/>
  <rect x="${w * 0.05}" y="${h * 0.1}" width="${w * 0.9}" height="${h * 0.8}" fill="none" stroke="#fff" stroke-width="4" stroke-dasharray="18 12"/>
  <text x="${w / 2}" y="${h / 2}" text-anchor="middle" dominant-baseline="middle" font-family="Arial Black,Arial" font-weight="900" font-size="${h * 0.075}" fill="#fff">${label}</text>
</svg>`;
  const photo = (body: string): string =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 600">${body}</svg>`;
  const files: Record<string, string> = {
    'key-visual/mobile.svg': kv(1600, 900, 'STAND-IN KEY VISUAL 16:9'),
    'key-visual/desktop.svg': kv(1800, 600, 'STAND-IN KEY VISUAL 3:1'),
    'promo/phone-stand-in.svg': kv(1600, 900, 'STAND-IN PROMO, PHONE 16:9'),
    'contestants/light.svg': photo(
      '<defs><radialGradient id="b" cx=".5" cy=".35" r=".7"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#e8e2d6"/></radialGradient></defs>' +
        '<rect width="480" height="600" fill="url(#b)"/><rect x="60" y="380" width="360" height="220" fill="#f7f4ee"/><circle cx="240" cy="230" r="120" fill="#fbf9f5"/>',
    ),
    'contestants/dark.svg': photo(
      '<rect width="480" height="600" fill="#050505"/><defs><radialGradient id="h" cx=".2" cy=".15" r=".35"><stop offset="0" stop-color="#fff6d0"/><stop offset="1" stop-color="#050505" stop-opacity="0"/></radialGradient></defs><rect width="480" height="600" fill="url(#h)"/>',
    ),
    'contestants/cast.svg': photo(
      '<defs><linearGradient id="c" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb347"/><stop offset="1" stop-color="#7a2a00"/></linearGradient></defs><rect width="480" height="600" fill="url(#c)"/><ellipse cx="240" cy="260" rx="150" ry="190" fill="#ff8a2a"/><rect x="0" y="470" width="480" height="130" fill="#c45a10"/>',
    ),
    'contestants/texture.svg': photo(
      '<defs><pattern id="p" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(30)"><rect width="6" height="12" fill="#fff"/><rect x="6" width="6" height="12" fill="#111"/></pattern></defs><rect width="480" height="600" fill="url(#p)"/>',
    ),
  };
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(outDir, name, '..'), { recursive: true });
    writeFileSync(join(outDir, name), content);
  }
}

/**
 * How much of the contestant grid a phone visitor sees on first load, with the
 * demo banner optionally hidden to show what the public (production) page gives.
 */
interface FirstScreen {
  viewport: string;
  gridTopPx: number;
  gridVisiblePx: number;
  cardHeightPx: number;
  cardsFullyVisible: number;
  cardsPartlyVisible: number;
  firstRowVisiblePercent: number;
}

async function measureFirstScreen(page: Page, hideDemoBanner: boolean): Promise<FirstScreen> {
  await page.evaluate(() => window.scrollTo(0, 0));
  return page.evaluate((hide: boolean) => {
    const style = document.createElement('style');
    style.textContent = '.demo-banner { display: none !important; }';
    if (hide) document.head.append(style);
    const height = window.innerHeight;
    const cards = [...document.querySelectorAll('.grid > li')].map((card) => card.getBoundingClientRect());
    const first = cards[0];
    const result = {
      viewport: `${window.innerWidth}x${height}`,
      gridTopPx: Math.round(first?.top ?? 0),
      gridVisiblePx: Math.max(0, Math.round(height - (first?.top ?? height))),
      cardHeightPx: Math.round(first?.height ?? 0),
      cardsFullyVisible: cards.filter((box) => box.bottom <= height).length,
      cardsPartlyVisible: cards.filter((box) => box.top < height).length,
      firstRowVisiblePercent: first
        ? Math.max(0, Math.min(100, Math.round(((height - first.top) / first.height) * 100)))
        : 0,
    };
    style.remove();
    return result;
  }, hideDemoBanner);
}

const firstScreens: Record<string, FirstScreen> = {};

/** The voted state at 390 x 844: does the "vote counted" message, and any of the grid, stay on the first screen? */
interface VotedScreen {
  messageBottomPx: number;
  messageFullyVisible: boolean;
  promoTopPx: number;
  promoBottomPx: number;
  gridTopPx: number;
  gridVisiblePx: number;
}

async function measureVotedScreen(page: Page, hideDemoBanner: boolean): Promise<VotedScreen> {
  await page.evaluate(() => window.scrollTo(0, 0));
  return page.evaluate((hide: boolean) => {
    const style = document.createElement('style');
    style.textContent = '.demo-banner { display: none !important; }';
    if (hide) document.head.append(style);
    const height = window.innerHeight;
    const message = document.querySelector('.voter__save:not(:empty)')?.getBoundingClientRect();
    const promo = document.querySelector('.promo-banner[data-placement="bottom"]')?.getBoundingClientRect();
    const grid = document.querySelector('.grid')?.getBoundingClientRect();
    const result = {
      messageBottomPx: Math.round(message?.bottom ?? -1),
      messageFullyVisible: message !== undefined && message.bottom <= height,
      promoTopPx: Math.round(promo?.top ?? -1),
      promoBottomPx: Math.round(promo?.bottom ?? -1),
      gridTopPx: Math.round(grid?.top ?? height),
      gridVisiblePx: Math.max(0, Math.round(height - (grid?.top ?? height))),
    };
    style.remove();
    return result;
  }, hideDemoBanner);
}

const votedScreens: Record<string, VotedScreen> = {};

async function serve(outDir: string, port: number, base = '/'): Promise<PreviewServer> {
  return preview({
    root: ROOT,
    base,
    logLevel: 'error',
    build: { outDir },
    preview: { port, strictPort: true, host: '127.0.0.1' },
  });
}

async function shot(page: Page, name: string, fullPage = false): Promise<void> {
  if (fullPage) {
    // A full-page capture stitches several screens together, and would paint the
    // sticky banner across the middle of the picture. Pin it to the top for the photo.
    await page.addStyleTag({ content: '.demo-banner { position: static !important; }' });
    await page.mouse.move(0, 0);
    await page.evaluate(() => (document.activeElement as HTMLElement | SVGElement | null)?.blur());
  }
  await page.screenshot({ path: join(OUT, `${name}.png`) as `${string}.png`, fullPage });
}

// ------------------------------------------------------------------ Part C

/** The Google Sheet test build against a stand-in that runs the real Code.gs. */
async function partC(
  browser: Browser,
  site: string,
  stub: SheetStubServer,
  outDir: string,
  prodDir: string,
): Promise<void> {
  const context = await browser.createBrowserContext();
  const voter = await open(context, `${site}/`, { userAgent: INSTAGRAM_UA });
  const rows = (): (string | number | Date)[][] => stub.script.votes()?.rows.slice(1) ?? [];

  await step('sheet build: TEST SITE banner, voting open today, configured close time shown', async () => {
    await see(voter, 'TEST SITE');
    await see(voter, 'Votes are not real.');
    assert.equal(await cardsDisabled(voter), false);
    await see(voter, `Voting closes ${formatSgtDateTime(votingWindow.closesAt)}.`);
  });

  await step('sheet build: a vote becomes one row (time, email typed and canonical, self-reported IP, contestant, device)', async () => {
    await voteFor(voter, 7, 'Test+1@Example.com');
    await see(voter, 'Done. Your vote is counted.');
    const all = rows();
    assert.equal(all.length, 1);
    const [time, typed, counted, ip, number, name, voteId, device, duplicate] = all[0] ?? [];
    assert.match(String(time), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    assert.deepEqual(
      [typed, counted, ip, number, name, device, duplicate],
      ['Test+1@Example.com', 'test+1@example.com', STUB_IP, 7, 'Contestant 7', 'iPhone · Instagram', false],
    );
    assert.match(String(voteId), /^[A-Za-z0-9-]{8,64}$/);
    assert.equal(stub.preflights(), 0, 'the page triggered a CORS preflight, which Apps Script cannot answer');
    await shot(voter, 'sheet-01-vote-counted');
  });

  await step('sheet build: the same email from another phone is refused, and logged as Duplicate? TRUE', async () => {
    const other = await open(await browser.createBrowserContext(), `${site}/`);
    await voteFor(other, 9, '  test+1@example.com');
    await see(other, DUPLICATE);
    assert.equal(rows().length, 2);
    assert.deepEqual([rows()[1]?.[4], rows()[1]?.[8]], [9, true]);
    await other.close();
  });

  await step('sheet build: Gmail spellings of one inbox count once', async () => {
    const first = await open(await browser.createBrowserContext(), `${site}/`);
    await voteFor(first, 3, 'jane.doe@gmail.com');
    await see(first, 'Done. Your vote is counted.');
    const second = await open(await browser.createBrowserContext(), `${site}/`);
    await voteFor(second, 4, 'JaneDoe+again@googlemail.com');
    await see(second, DUPLICATE);
    assert.deepEqual(rows().map((row) => row[8]), [false, true, false, true]);
    await first.close();
    await second.close();
  });

  await step('sheet build: #/admin counts only the 2 counted votes, with no emails or IPs on screen', async () => {
    const admin = await open(await browser.createBrowserContext(), `${site}/#/admin`, { viewport: LAPTOP });
    await unlockAdmin(admin, SHEET_ADMIN);
    await votesCounted(admin, 2);
    const body = await text(admin);
    assert.equal(/@example\.com|@gmail\.com/i.test(body), false, 'an email address is on the admin screen');
    assert.equal(body.includes(STUB_IP), false, 'an IP address is on the admin screen');
    await shot(admin, 'sheet-02-admin', true);
    await admin.close();
  });

  await step('sheet build: the bundle carries the sheet address and no production API code', async () => {
    const bundle = filesUnder(outDir)
      .filter((file) => file.endsWith('.js'))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    assert.ok(bundle.includes(`${stub.url}/exec`));
    assert.equal(bundle.includes('VITE_API_BASE_URL must be'), false, 'the api store is in the sheet bundle');
    const production = filesUnder(prodDir)
      .filter((file) => file.endsWith('.js'))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    assert.equal(/ipify|VITE_SHEET_ENDPOINT|script\.google\.com/.test(production), false, 'sheet code is in the production bundle');
  });

  await context.close();
}


// ------------------------------------------------------------------ Part D

async function bundleOf(dir: string): Promise<string> {
  return filesUnder(dir)
    .filter((file) => file.endsWith('.js') || file.endsWith('.html'))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
}

/**
 * PRODUCTION Google Sheet build (26 Oct 2026), served under /imc4-lookalike-vote/
 * as GitHub Pages will. First with the real config (before the window: nothing
 * can be cast), then with a stand-in config whose window is open now.
 */
async function partD(
  browser: Browser,
  closedSite: string,
  closedStub: SheetStubServer,
  closedDir: string,
  openSite: string,
  openStub: SheetStubServer,
): Promise<void> {
  await step('production sheet build, real config: open now (26 Oct), no banner, no "Voting opens" text, placeholders while the tab is empty', async () => {
    const page = await open(await browser.createBrowserContext(), `${closedSite}${PAGES_BASE}`);
    await see(page, OPEN_H1);
    await see(page, `Vote your favourite lookalike now! Voting closes ${formatSgtDateTime(votingWindow.closesAt)}.`);
    const body = await text(page);
    assert.equal(/TEST SITE|DEMO DATA|Demo controls|ORGANISER TEST/.test(body), false, 'a test/demo banner is on the production page');
    assert.equal(/Voting opens|not open yet/i.test(body), false, 'closed-state text is showing');
    assert.equal(await page.$('.demo-banner'), null);
    assert.equal(await cardsDisabled(page), false);
    await see(page, 'Contestant 7');
    await noPromoYet(page);
    await shot(page, 'prod-sheet-390-1-open-now');
    await page.close();
  });

  await step('production sheet build, real config: a vote today is counted and lands as a real row', async () => {
    const page = await open(await browser.createBrowserContext(), `${closedSite}${PAGES_BASE}`);
    await voteFor(page, 7, 'Today.Voter@Example.com');
    await see(page, 'Done. Your vote is counted.');
    const rows = closedStub.script.votes()?.rows.slice(1) ?? [];
    assert.deepEqual([rows.length, rows[0]?.[4], rows[0]?.[8], rows[0]?.[9]], [1, 7, false, false]);
    await page.close();
  });

  await step('production sheet build: no demo passcode, demo panels, demo store or placeholder in the bundle', async () => {
    const bundle = await bundleOf(closedDir);
    // The banner wording lives in shared page code and is checked on screen above;
    // these are the things that must not ship at all.
    // 'imc4-voting-demo-v3' is the demo store's storage key: present only if the demo store shipped.
    assert.equal(filesUnder(closedDir).some((file) => /demoStore|Demo(Voter|Admin)Panel/.test(file)), false, 'a demo chunk shipped');
    for (const leak of ['demo-admin', 'Demo controls', 'Key visual goes here', 'imc4-voting-demo-v3', SHEET_ADMIN]) {
      assert.equal(bundle.includes(leak), false, `"${leak}" is in the production sheet bundle`);
    }
    assert.ok(bundle.includes(`${closedStub.url}/exec`));
  });

  await step('production sheet build: admin refuses the demo passcode and unlocks with the real one', async () => {
    const admin = await open(await browser.createBrowserContext(), `${closedSite}${PAGES_BASE}#/admin`, { viewport: LAPTOP });
    await admin.waitForSelector('#passcode');
    await admin.type('#passcode', 'demo-admin');
    await press(admin, 'Unlock');
    await see(admin, "That passcode isn't right.");
    await admin.$eval('#passcode', (input) => (input as HTMLInputElement).select());
    await admin.keyboard.press('Backspace');
    await admin.type('#passcode', SHEET_ADMIN);
    await press(admin, 'Unlock');
    await see(admin, 'Tally and ranking');
    await votesCounted(admin, 1);
    await admin.close();
  });

  const context = await browser.createBrowserContext();
  const voter = await open(context, `${openSite}${PAGES_BASE}`);

  await step('runtime Top 10 dry run: names, handles and 10 photos from the Contestants tab, shown as supplied (Revision 13c)', async () => {
    await see(voter, 'Dry Run 07');
    const cards = await voter.$$eval('.grid > li', (items) =>
      items.map((item) => ({
        name: item.querySelector('.card__stage')?.textContent ?? '',
        pitch: item.querySelector('.card__pitch')?.textContent ?? '',
        label: item.querySelector('.card__label')?.textContent ?? '',
      })),
    );
    assert.equal(cards.length, 10);
    // Revision 13b: the pitch has its own line, in full (the CSS clips it); the label is number and handle.
    assert.deepEqual(cards[6], { name: 'Dry Run 07', pitch: SHORT_PITCH, label: 'No. 07 · @dryrun_07' });
    assert.deepEqual(cards[1], { name: 'Dry Run 02', pitch: LONG_PITCH, label: 'No. 02 · @dryrun_02' });
    assert.deepEqual(cards[2], { name: 'Dry Run 03', pitch: SHORT_PITCH, label: 'No. 03' });
    assert.equal(LONG_PITCH.length, 300);
    assert.equal(SHORT_PITCH.length, 28);
    const pitchLayout = await voter.$$eval('.grid > li', (items) =>
      items.map((item) => {
        const pitch = item.querySelector<HTMLElement>('.card__pitch');
        const card = item.getBoundingClientRect();
        const caption = item.querySelector('.card__caption')?.getBoundingClientRect();
        const lineHeight = pitch ? parseFloat(getComputedStyle(pitch).lineHeight) : 0;
        return {
          lines: pitch ? Math.round(pitch.getBoundingClientRect().height / lineHeight) : 0,
          clipped: pitch ? pitch.scrollHeight > pitch.clientHeight + 1 : false,
          inside: caption !== undefined && caption.top >= card.top && caption.bottom <= card.bottom + 0.5,
        };
      }),
    );
    const phoneWidth = await voter.evaluate(() => window.innerWidth < 600);
    const maxLines = phoneWidth ? 2 : 3;
    for (const [index, layout] of pitchLayout.entries()) {
      assert.ok(layout.lines >= 1 && layout.lines <= maxLines, `card ${index + 1}: pitch on ${layout.lines} lines, max ${maxLines}`);
      assert.ok(layout.inside, `card ${index + 1}: caption runs outside the card`);
    }
    assert.equal(pitchLayout[1]?.clipped, true, 'the 300-character pitch should end in an ellipsis');
    assert.equal(pitchLayout[0]?.clipped, false, 'the 28-character pitch should show in full');
    await voter.evaluate(async () => {
      for (const img of document.querySelectorAll<HTMLImageElement>('.grid .art--photo')) {
        img.loading = 'eager';
      }
      window.scrollTo(0, document.body.scrollHeight);
    });
    await voter.waitForFunction(
      () => {
        const photos = [...document.querySelectorAll<HTMLImageElement>('.grid .art--photo')];
        return photos.length === 10 && photos.every((img) => img.complete && img.naturalWidth > 0);
      },
      { timeout: 20_000 },
    );
    // Revision 13c: photos as supplied. No filter, no tint layers; the scrim behind the caption stays.
    const look = await voter.$eval('.grid > li:first-child', (card) => {
      const wrap = card.querySelector('.card__art') as HTMLElement;
      const img = card.querySelector('.art--photo') as HTMLElement;
      const face = card.querySelector('.card__face') as HTMLElement;
      return {
        filter: getComputedStyle(img).filter,
        tintBefore: getComputedStyle(wrap, '::before').content,
        tintAfter: getComputedStyle(wrap, '::after').content,
        scrim: getComputedStyle(face, '::after').backgroundImage,
      };
    });
    assert.equal(look.filter, 'none', 'a filter still reaches the contestant photo');
    assert.equal(look.tintBefore, 'none', 'the lilac tint layer still covers the photo');
    assert.equal(look.tintAfter, 'none', 'the purple tint layer still covers the photo');
    assert.match(look.scrim, /linear-gradient/, 'the scrim behind the caption is gone');
    // Placeholders keep their look.
    assert.equal(await voter.$('.grid .card__art--photo .art--placeholder'), null);
    const alt = await voter.$eval('.grid > li:nth-child(7) .art--photo', (img) => (img as HTMLImageElement).alt);
    assert.equal(alt, 'Dry Run 07, contestant 7');
    await voter.evaluate(() => window.scrollTo(0, 0));
    await shot(voter, 'prod-sheet-390-0-runtime-top20');
  });

  await step('production sheet build, window open: vote, pop-up links to the YouTrip OneLink, row written', async () => {
    await see(voter, OPEN_H1);
    assert.equal(await voter.$('.demo-banner'), null);
    await pickCard(voter, 7);
    await see(voter, 'Vote for #7 Dry Run 07?');
    await typeEmail(voter, 'Prod.Voter@Example.com');
    await press(voter, 'Confirm vote', 'dialog.sheet');
    await see(voter, 'Done. Your vote is counted.');
    await checkPromo(voter, 'pop-up');
    await checkVoteIsInPanel(voter, '#7 Dry Run 07');
    const href = await voter.$eval('dialog.sheet--promo .promo-banner', (node) => node.getAttribute('href'));
    assert.equal(href, 'https://youtrip.onelink.me/P5AL/voting-site');
    await shot(voter, 'prod-sheet-390-2-popup');
    const rows = openStub.script.votes()?.rows.slice(1) ?? [];
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0]?.[2], rows[0]?.[4], rows[0]?.[5], rows[0]?.[8]], ['prod.voter@example.com', 7, 'Dry Run 07', false]);
    await press(voter, 'Close', 'dialog.sheet--promo');
    await shot(voter, 'prod-sheet-390-3-voted');
  });

  await step('production sheet build, window open: the same email again is refused and logged as a repeat', async () => {
    const other = await open(await browser.createBrowserContext(), `${openSite}${PAGES_BASE}`);
    await pickCard(other, 3);
    await see(other, 'Vote for #3 Dry Run 03?');
    await typeEmail(other, 'prod.voter@example.com');
    await press(other, 'Confirm vote', 'dialog.sheet');
    await see(other, DUPLICATE);
    const rows = openStub.script.votes()?.rows.slice(1) ?? [];
    assert.deepEqual(rows.map((row) => row[8]), [false, true]);
    await other.close();
  });

  await context.close();
}

// ------------------------------------------------------------------ Part A

async function partA(browser: Browser, site: string): Promise<void> {
  const context = await browser.createBrowserContext();
  const voter = await open(context, `${site}/`);

  await step('the link from Instagram lands straight on the voting page, inside the window', async () => {
    await see(voter, OPEN_H1);
    await see(voter, 'DEMO DATA');
    assert.equal((await voter.$$('.grid > li')).length, 10);
    assert.equal(await cardsDisabled(voter), false);
    await see(voter, `Voting closes ${formatSgtDateTime(votingWindow.closesAt)}.`);
    await shot(voter, 'demo-01-vote-open');
  });

  await step('Rev 10: no promo before a vote; no brand line; green dot; her two lines, verbatim', async () => {
    await noPromoYet(voter);
    assert.equal(await voter.$('main .brand'), null, 'the brand line under the banner is back');
    assert.equal(/jung\s*kook|lookalike contest/i.test(await text(voter)), false, 'the page text names the contest/artist');
    const dot = await voter.$eval('.pill--open .pill__dot', (node) => getComputedStyle(node).backgroundColor);
    assert.equal(dot, 'rgb(61, 220, 132)', 'the open dot is not green');
    assert.equal(
      await voter.$eval('.voter__top .pill--closes', (node) => node.textContent),
      `voting closes ${formatSgtDayMonth(votingWindow.closesAt)}`,
    );
    assert.equal(formatSgtDayMonth(votingWindow.closesAt), '12 Nov');
    const pills = await voter.$$eval('.voter__top .pill', (nodes) =>
      nodes.map((node) => { const r = node.getBoundingClientRect(); return { h: r.height, bottom: r.bottom }; }),
    );
    const heading = await voter.$eval('.voter__intro h1', (node) => node.getBoundingClientRect().top);
    for (const pill of pills) {
      assert.ok(pill.h < 40, 'a status pill wrapped onto two lines');
      assert.ok(pill.bottom <= heading, 'a status pill overlaps the heading');
    }
    assert.equal(await voter.$eval('.voter__intro h1', (node) => node.textContent), OPEN_H1);
    assert.equal(OPEN_H1, 'Who makes the final 3?');
    assert.equal(await voter.$eval('.voter__lede', (node) => node.textContent), OPEN_LEDE);
    assert.equal(OPEN_LEDE, `Vote your favourite lookalike now! Voting closes ${formatSgtDateTime(votingWindow.closesAt)}.`);
    assert.equal(await voter.$eval('.voter__rule', (node) => node.textContent), RULE_LINE);
  });

  await step('all 10 contestants are numbered 1 to 10 and use generated placeholders, not photos', async () => {
    const labels = await voter.$$eval('.card__label', (nodes) => nodes.map((n) => n.textContent));
    assert.deepEqual(labels, contestants.map((c) => `No. ${String(c.number).padStart(2, '0')}`));
    // The giant outlined numeral is decoration: hidden from screen readers.
    const numerals = await voter.$$eval('.card__numeral', (nodes) =>
      nodes.map((n) => [n.getAttribute('aria-hidden'), n.textContent]),
    );
    assert.deepEqual(numerals, contestants.map((c) => ['true', String(c.number).padStart(2, '0')]));
    // Each card's accessible name carries the name and the number, once.
    const names = await voter.$$eval('.card__face', (nodes) =>
      nodes.map((n) =>
        [...n.querySelectorAll('.card__stage, .card__label')].map((part) => part.textContent).join(' '),
      ),
    );
    assert.equal(names[6], 'Contestant 7 No. 07');
    assert.equal((await voter.$$('.grid img')).length, 0);
    assert.equal((await voter.$$('.grid svg.art--placeholder')).length, 10);
  });

  await step('public counts are hidden by default', async () => {
    assert.equal(await voter.$('.card__count'), null);
    assert.equal(/\d+\s+votes?\b/.test(await voter.$eval('.grid', (g) => (g as HTMLElement).innerText)), false);
  });

  await step('the two removed paragraphs are gone, and the page promises nothing', async () => {
    const body = await text(voter);
    for (const removed of [
      'network address',
      'IP address',
      'Wording pending legal review',
      'Your vote helps decide',
      'We use your email',
      'make sure each person votes once',
      'eligibility check',
    ]) {
      assert.equal(body.includes(removed), false, `page still says "${removed}"`);
    }
    assert.equal(await voter.$('.voter__footer'), null);
    for (const banned of [/people.s choice/i, /flights?/i, /\bdraw\b/i, /\bcash\b/i, /prize/i, /\bQR\b/]) {
      assert.equal(banned.test(body), false, `page mentions ${String(banned)}`);
    }
  });

  await step('the demo says plainly that it is simulated and uses made-up addresses', async () => {
    await see(voter, 'Demo controls');
    await see(voter, 'Simulated. Not part of the real site.');
    await see(voter, 'Made-up addresses at example.com');
  });

  await step('before the window: shows when voting opens, and nobody can vote', async () => {
    await press(voter, 'Before voting opens');
    await see(voter, 'Voting opens soon');
    await see(voter, `Voting opens ${formatSgtDateTime(votingWindow.opensAt)}.`);
    assert.equal(await voter.$('.pill--closes'), null, 'the closes pill shows before voting opens');
    assert.equal(await cardsDisabled(voter), true);
    await shot(voter, 'demo-02-vote-not-open');
    await checkPromo(voter, 'bottom');
  });

  await step('tap a contestant: the confirm step asks for an email, set up for phone keyboards', async () => {
    await press(voter, 'During voting');
    await see(voter, OPEN_H1);
    await pickCard(voter, 7);
    await see(voter, 'Vote for #7 Contestant 7?');
    const field = await voter.$eval('#voter-email', (input) => {
      const element = input as HTMLInputElement;
      return {
        type: element.type,
        inputMode: element.inputMode,
        autocomplete: element.autocomplete,
        autocapitalize: element.getAttribute('autocapitalize'),
        spellcheck: element.spellcheck,
        fontSize: parseFloat(getComputedStyle(element).fontSize),
        focused: document.activeElement === element,
        label: element.labels?.[0]?.innerText ?? '',
        describedBy: element.getAttribute('aria-describedby') ?? '',
      };
    });
    assert.deepEqual(
      { ...field, fontSize: field.fontSize >= 16 },
      {
        type: 'email',
        inputMode: 'email',
        autocomplete: 'email',
        autocapitalize: 'none',
        spellcheck: false,
        fontSize: true,
        focused: true,
        label: 'Your email',
        describedBy: '',
      },
    );
    const sheetText = await voter.$eval('dialog.sheet', (node) => (node as HTMLElement).innerText);
    assert.equal(/We use your email|make sure each person/i.test(sheetText), false, 'the purpose line is back');
    assert.equal(await voter.$('#voter-email-note'), null);
    await shot(voter, 'demo-03-vote-confirm');
  });

  await step('a missing or mistyped email is explained in the sheet, and nothing is sent', async () => {
    await press(voter, 'Confirm vote', 'dialog.sheet');
    await see(voter, 'Enter your email address to vote.');
    await typeEmail(voter, 'alice.tan@example');
    await press(voter, 'Confirm vote', 'dialog.sheet');
    await see(voter, "That email address doesn't look right. Check it and try again.");
    assert.equal(
      await voter.$eval('#voter-email', (input) => input.getAttribute('aria-invalid')),
      'true',
    );
    assert.ok(await voter.$('dialog.sheet[open]'), 'the sheet must stay open to fix the address');
    // Every id the field points at for its description must exist on the page.
    const dangling = await voter.$eval('#voter-email', (input) =>
      (input.getAttribute('aria-describedby') ?? '')
        .split(/\s+/)
        .filter((id) => id !== '' && document.getElementById(id) === null),
    );
    assert.deepEqual(dangling, [], 'aria-describedby points at a missing element');
    assert.equal(
      await voter.$eval('#voter-email', (input) => input.getAttribute('aria-describedby')),
      'voter-email-error',
    );
    await shot(voter, 'demo-03b-vote-confirm-error');
  });

  await step('confirm: voted, and the promo pops up', async () => {
    await typeEmail(voter, EMAIL.alice);
    await press(voter, 'Confirm vote', 'dialog.sheet');
    await see(voter, 'Vote in!');
    await see(voter, `You voted for #7 Contestant 7. ${WINNER_LINE}`);
    await see(voter, 'Done. Your vote is counted.');
    assert.equal(await cardsDisabled(voter), true, 'a voted browser shows its vote, not a fresh ballot');
    await checkPromo(voter, 'pop-up');
    await checkVoteIsInPanel(voter, '#7 Contestant 7');
    await shot(voter, 'demo-04a-promo-popup');
  });

  await step("Rev 10: the phone's Back closes the pop-up and stays on the page, message in view", async () => {
    const before = voter.url();
    await voter.goBack();
    await voter.waitForFunction(() => document.querySelector('dialog.sheet--promo[open]') === null, { timeout: 5_000 });
    assert.equal(voter.url(), before, 'Back left the voting page');
    const top = await voter.$eval('.voter__intro h1', (node) => node.getBoundingClientRect().top);
    assert.ok(top >= 0 && top < 300, `the "Vote in!" message is not on screen after the vote (top ${top})`);
    await checkLedePromo(voter);
    await shot(voter, 'demo-04-vote-counted');
    await checkPromo(voter, 'bottom');
  });

  await step('Rev 10: "See all contestants" brings back every contestant, still locked', async () => {
    await press(voter, 'See all contestants');
    await voter.waitForFunction(() => {
      const grid = document.querySelector('.grid')?.getBoundingClientRect();
      return grid !== undefined && grid.top >= 0 && grid.top < 120;
    }, { timeout: 5_000 });
    assert.equal((await voter.$$('.grid > li')).length, 10);
    assert.equal(await cardsDisabled(voter), true);
    await shot(voter, 'demo-04b-see-all-contestants');
    await voter.evaluate(() => window.scrollTo(0, 0));
  });

  await step('backing out of the confirm sheet casts nothing', async () => {
    const other = await browser.createBrowserContext();
    const page = await open(other, `${site}/`);
    await pickCard(page, 2);
    await press(page, 'Back', 'dialog.sheet');
    await see(page, OPEN_H1);
    assert.equal(await page.$('.card--chosen'), null);
    await other.close();
  });

  await step('the voted state survives a reload, and the email is not kept in the browser', async () => {
    await voter.reload({ waitUntil: 'load' });
    await see(voter, 'You voted for #7 Contestant 7.');
    assert.equal((await voter.$$('.card--chosen')).length, 1);
    const stored = await voter.evaluate(() =>
      JSON.stringify([
        Object.entries(localStorage),
        Object.entries(sessionStorage),
        document.cookie,
      ]),
    );
    assert.equal(stored.includes('alice'), false, 'the readable email was kept in the browser');
  });

  await step('the same email again, from the same phone, is refused with the plain message', async () => {
    await press(voter, ANOTHER_PERSON);
    await see(voter, OPEN_H1);
    await voteFor(voter, 3, EMAIL.alice);
    await see(voter, DUPLICATE);
    assert.equal((await text(voter)).includes('Vote in!'), false);
    assert.equal(await voter.$('.card--chosen'), null);
    await shot(voter, 'demo-05-vote-duplicate-email');
  });

  await step('a second person on the same phone votes with their own email', async () => {
    await press(voter, 'New visitor, new email');
    await see(voter, 'visitor1@example.com is filled in');
    await pickCard(voter, 3);
    assert.equal(await voter.$eval('#voter-email', (input) => (input as HTMLInputElement).value), 'visitor1@example.com');
    await press(voter, 'Confirm vote', 'dialog.sheet');
    await see(voter, 'You voted for #3 Contestant 3.');
    await shot(voter, 'demo-06-vote-second-person');
  });

  await step('demo control: "same email" shows the duplicate rejection', async () => {
    await press(voter, 'New visitor, same email');
    await pickCard(voter, 9);
    await press(voter, 'Confirm vote', 'dialog.sheet');
    await see(voter, DUPLICATE);
    // Put this browser back as visitor1's, for the closed-state check below.
    await press(voter, 'New visitor, same email');
  });

  await step('after the window: closed, with the winner date', async () => {
    await press(voter, 'After voting closes');
    await see(voter, 'Voting has closed');
    assert.equal(await voter.$('.pill--closes'), null, 'the closes pill shows after voting closed');
    await see(voter, WINNER_LINE);
    assert.ok(WINNER_LINE === 'The winner will be announced on Thu 12 Nov 2026.', WINNER_LINE);
    assert.equal((await text(voter)).includes('Top 10 will be announced'), false, 'the old Top 10 line is still on the page');
    // This browser's vote was just forgotten ("New visitor, same email"): no promo under the lede.
    assert.equal(await voter.$('.promo-banner[data-placement="lede"]'), null, 'promo under the lede without a vote');
    assert.equal(await cardsDisabled(voter), true);
    await shot(voter, 'demo-07-vote-closed');
    await checkPromo(voter, 'bottom');
    await press(voter, 'During voting');
    await see(voter, OPEN_H1);
  });

  await step('works from a sub-folder, as it will be served on GitHub Pages', async () => {
    const html = readFileSync(join(BUILDS, 'demo', 'index.html'), 'utf8');
    const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((found) => found[1] ?? '');
    const local = references.filter((reference) => !reference.startsWith('data:'));
    assert.ok(local.length >= 2, 'expected the page to reference its script and stylesheet');
    for (const reference of local) {
      assert.ok(reference.startsWith('./'), `"${reference}" would break under /<repo-name>/`);
    }
  });

  await step('refuses to render inside another site’s frame', async () => {
    const other = await browser.createBrowserContext();
    const page = await other.newPage();
    await page.setContent(
      `<iframe src="${site}/" style="width:390px;height:700px"></iframe>`,
      { waitUntil: 'load' },
    );
    const frame = page.frames().find((candidate) => candidate.url().startsWith(site));
    assert.ok(frame !== undefined, 'frame did not load');
    await frame.waitForSelector('a[target="_top"]');
    assert.equal(await frame.$('.card__face'), null, 'voting cards rendered inside a frame');
    await other.close();
  });


  const admin = await open(context, `${site}/#/admin`, { viewport: LAPTOP, before: captureDownloads });
  admin.on('dialog', (dialog) => void dialog.accept());

  await step('admin: wrong passcode is refused, right passcode unlocks', async () => {
    await unlockAdmin(admin, demo.passcode);
  });

  await step('admin: tally counts exactly the two votes cast, ranked', async () => {
    await votesCounted(admin, 2);
    const rows = await admin.$$eval('.ranking tbody tr', (trs) =>
      trs.slice(0, 3).map((tr) => (tr as HTMLElement).innerText.replace(/\s+/g, ' ').trim()),
    );
    assert.deepEqual(rows, [
      '1 (tie) #3 Contestant 3 1',
      '1 (tie) #7 Contestant 7 1',
      '3 #1 Contestant 1 0',
    ]);
    await see(admin, 'Only 2 of 10 contestants have a vote so far');
    // textContent, not innerText: the labels are upper-cased by CSS.
    const facts = await admin.$eval('.facts', (node) => node.textContent ?? '');
    assert.ok(facts.includes('Votes per email1'), facts);
    assert.ok(facts.includes('Changing a voteNot allowed'), facts);
    assert.ok(facts.includes('Counts on the public pageHidden'), facts);
  });

  await step('admin: simulated votes fill the ranking and the volume chart', async () => {
    await press(admin, 'Simulate 60 votes');
    await see(admin, 'Simulated 60 votes from 60 made-up email addresses.');
    await votesCounted(admin, 62);
    await admin.waitForSelector('.chart__column');
    assert.ok((await admin.$$('.chart__column')).length >= 2, 'expected several columns');
    const total = await admin.$$eval('.chart__table tbody td.preview__num', (cells) =>
      cells.reduce((sum, cell) => sum + Number(cell.textContent), 0),
    );
    assert.equal(total, 62, 'the chart’s table must add up to the votes received');
  });

  await step('admin: chart columns answer to hover and to the keyboard', async () => {
    const lastHit = (await admin.$$('.chart__hit')).at(-1);
    assert.ok(lastHit !== undefined);
    await lastHit.hover();
    await admin.waitForSelector('.chart__tooltip');
    const hovered = await admin.$eval('.chart__tooltip', (node) => (node as HTMLElement).innerText);
    assert.match(hovered, /\d+ votes?\s+from \d+ (Oct|Nov), \d+:\d{2}(am|pm)/);
    await admin.mouse.move(0, 0);
    await admin.$eval('.chart svg', (svg) => (svg as SVGSVGElement).focus());
    await admin.waitForSelector('.chart__tooltip');
    await admin.keyboard.press('ArrowLeft');
    const focused = await admin.$eval('.chart__tooltip', (node) => (node as HTMLElement).innerText);
    assert.match(focused, /\d+ votes?\s+from/);
  });

  await step('admin: a burst of votes for one contestant is flagged, and nothing is removed', async () => {
    await see(admin, 'Nothing flagged.');
    await press(admin, 'Simulate a burst');
    await see(admin, 'Simulated a burst: 15 votes for one contestant inside 3 minutes.');
    await admin.waitForSelector('.flags .flag');
    const flag = await admin.$eval('.flags .flag', (node) => (node as HTMLElement).innerText);
    // 15 simulated, plus any earlier vote for the same contestant that fell in the same minutes.
    const flagged = /#\d+ Contestant \d+ received (\d+) votes between/.exec(flag);
    assert.ok(flagged !== null && Number(flagged[1]) >= 15, flag);
    assert.ok(15 >= burstRule.votes, 'the simulated burst must reach the configured threshold');
    await votesCounted(admin, 77);
    await see(admin, 'Nothing is removed or discounted automatically.');
    await shot(admin, 'demo-08-admin', true);
  });

  await step('admin: exports the tally and the per-vote log as CSV', async () => {
    await press(admin, 'Tally per contestant (CSV)');
    await see(admin, 'Downloaded the tally.');
    const tally = (await lastDownload(admin, 1)).trim().split('\r\n');
    assert.equal(
      tally[0],
      `rank,tied,in_top_${event.advancing}_on_votes,contestant_number,contestant_id,stage_name,votes`,
    );
    assert.equal(tally.length, contestants.length + 1, 'one row per contestant');
    const sum = tally.slice(1).reduce((total, line) => total + Number(line.split(',').at(-1)), 0);
    assert.equal(sum, 77);

    await press(admin, 'Every vote, with timestamps (CSV)');
    await see(admin, 'Downloaded 77 vote rows.');
    const log = (await lastDownload(admin, 2)).trim().split('\r\n');
    assert.equal(
      log[0],
      'vote_id,cast_at_sgt,cast_at_utc,contestant_number,contestant_id,stage_name,status,replaced_at_sgt,voter_ref',
    );
    assert.equal(log.length, 78);
    const everything = `${tally.join('\n')}\n${log.join('\n')}`;
    assert.equal(everything.includes('@'), false, 'an email address is in the CSV');
    assert.equal(/alice|visitor|example/i.test(everything), false, 'part of an email is in the CSV');
    assert.match(log[1] ?? '', /^\d+,2026-1[01]-\d\d \d\d:\d\d:\d\d,2026-1[01]-\d\dT[\d:.]+Z,\d+,c\d\d,Contestant \d+,counted,,/);
  });

  await step('admin: many votes from one network are flagged with a count, never the address', async () => {
    await see(admin, 'Many votes from one network');
    await press(admin, 'Simulate 12 votes from one network');
    await see(admin, 'Simulated 12 votes from 12 made-up voters on one simulated network.');
    await votesCounted(admin, 89);
    const panel = await admin.$eval('[aria-labelledby="shared-heading"]', (node) => node.textContent ?? '');
    assert.match(panel, /12 votes came from one network: #\d+ Contestant \d+ \(\d+\)/);
    assert.match(panel, /often entirely genuine/);
    assert.equal(PERSONAL_ON_SCREEN.test(panel), false, 'an address is shown in the flag');
  });

  await step('admin: the CONFIDENTIAL audit export has emails and IPs; nothing personal is on screen', async () => {
    await press(admin, 'Audit export: emails and IP addresses (CSV)');
    await see(admin, 'Downloaded the confidential audit export (89 rows).');
    const lines = (await lastDownload(admin, 3)).replace(/^\uFEFF/, '').trim().split('\r\n');
    assert.equal(lines[0], AUDIT_HEADER);
    assert.equal(lines.length, 90);
    const rows = lines.slice(1).map(cells);
    // The two votes cast on the voting page were in another tab: the demo keeps
    // audit records in memory only, so those two come through blank.
    assert.equal(rows.filter((row) => row[8] === 'not kept').length, 2);
    const simulated = rows.filter((row) => row[8] === 'simulated (demo)');
    assert.equal(simulated.length, 87);
    for (const row of simulated) {
      assert.match(row[5] ?? '', /^crowd\d+@simulated\.example\.com$/);
      assert.match(row[7] ?? '', /^(198\.51\.100|192\.0\.2)\.\d+$/);
    }
    assert.equal(rows.filter((row) => row[7] === '192.0.2.77' && row[9] === '12').length, 12);

    const names = await downloadNames(admin);
    assert.equal(names.length, 3);
    assert.match(names[2] ?? '', /^vote-audit-CONFIDENTIAL-.+\.csv$/);
    assert.equal(/CONFIDENTIAL|audit/i.test(`${names[0]} ${names[1]}`), false, 'publishable files named like the audit file');

    const onScreen = await text(admin);
    assert.equal(PERSONAL_ON_SCREEN.test(onScreen), false, 'an email or IP address is on the admin screen');
  });

  await step('admin closes voting: the voting page follows; reopening brings it back', async () => {
    await press(admin, 'Close voting');
    await see(admin, 'Voting is closed.');
    await see(voter, 'Voting has closed');
    assert.equal(await cardsDisabled(voter), true);
    await press(admin, 'Reopen voting');
    await see(admin, 'Voting is set to open.');
    await see(voter, OPEN_H1);
  });

  await step('admin: reset clears the demo', async () => {
    await press(admin, 'Reset demo');
    await see(admin, 'Demo data reset.');
    await votesCounted(admin, 0);
    await see(voter, OPEN_H1);
    assert.equal((await text(voter)).includes('Last sample address'), false);
  });

  await context.close();

  await step('demo: writes the sample audit CSV for Kelicia (made-up data only)', async () => {
    const sampleContext = await browser.createBrowserContext();
    const page = await open(sampleContext, `${site}/`, { viewport: LAPTOP, before: captureDownloads });
    page.on('dialog', (dialog) => void dialog.accept());
    await see(page, OPEN_H1);
    // Typed the way people type: odd capitals and spaces, a Gmail alias, and one
    // address a spreadsheet would try to run as a formula.
    await voteFor(page, 3, '  Alice.Tan@Example.com ');
    await press(page, 'New visitor, new email');
    await voteFor(page, 7, 'Jane.Doe+ig@gmail.com');
    await press(page, 'New visitor, same wifi');
    await pickCard(page, 7);
    await press(page, 'Confirm vote', 'dialog.sheet');
    await press(page, 'New visitor, same wifi');
    await voteFor(page, 9, '=1+2@example.com');
    await press(page, 'New visitor, same email');
    await voteFor(page, 9, 'JANEDOE@gmail.com');
    await see(page, DUPLICATE);

    await page.evaluate(() => {
      window.location.hash = '#/admin';
    });
    await page.waitForSelector('#passcode');
    await page.type('#passcode', demo.passcode);
    await press(page, 'Unlock');
    await see(page, 'Tally and ranking');
    await press(page, 'Simulate 12 votes from one network');
    await see(page, 'Simulated 12 votes');
    await press(page, 'Audit export: emails and IP addresses (CSV)');
    await see(page, 'Downloaded the confidential audit export (16 rows).');
    const csv = (await lastDownload(page, 1)).replace(/^\uFEFF/, '');
    const lines = csv.trim().split('\r\n');
    assert.equal(lines[0], AUDIT_HEADER);
    const mine = lines.slice(1).filter((line) => !line.includes('crowd'));
    assert.deepEqual(
      mine.map((line) => cells(line).slice(5, 10)),
      [
        ['Alice.Tan@Example.com', 'alice.tan@example.com', '203.0.113.10', 'simulated (demo)', '1'],
        ['Jane.Doe+ig@gmail.com', 'janedoe@gmail.com', '203.0.113.11', 'simulated (demo)', '3'],
        ['visitor2@example.com', 'visitor2@example.com', '203.0.113.11', 'simulated (demo)', '3'],
        ["'=1+2@example.com", "'=1+2@example.com", '203.0.113.11', 'simulated (demo)', '3'],
      ],
    );
    assert.ok(lines.slice(1).every((line) => /(203\.0\.113|198\.51\.100|192\.0\.2)\.\d+/.test(line)), 'a non-documentation IP');
    assert.ok(lines.slice(1).every((line) => /@(example\.com|gmail\.com|simulated\.example\.com),/.test(line)), 'a non-made-up email');
    writeFileSync(SAMPLE_AUDIT_CSV, csv);
    await sampleContext.close();
  });
}

// ------------------------------------------------------------------ Layout

/** The key visual slot: a marked placeholder in the demo, the image when one is set. */
/**
 * The campaign promo banner (Revision 7): exactly one, in the right place for
 * the state, full column width, the right shape, lazy, untreated, never in the
 * confirm sheet, and a safe link only when one is configured.
 */
async function checkPromo(
  page: Page,
  expected: 'bottom' | 'pop-up',
  options: { link?: string; phone?: boolean } = {},
): Promise<void> {
  const selector =
    expected === 'pop-up' ? 'dialog.sheet--promo[open] .promo-banner' : 'main .promo-banner[data-placement="bottom"]';
  await page.waitForSelector(selector, { timeout: 10_000 });
  if (expected === 'bottom') {
    await page.evaluate((sel: string) => document.querySelector(sel)?.scrollIntoView({ block: 'center' }), selector);
  }
  await page.waitForFunction((sel: string) => {
    const image = document.querySelector<HTMLImageElement>(`${sel} img`);
    return image !== null && image.complete && image.naturalWidth > 0;
  }, {}, selector);
  const promo = await page.evaluate((sel: string) => {
    const node = document.querySelector<HTMLElement>(sel);
    const image = node?.querySelector('img');
    const grid = document.querySelector('.grid')?.getBoundingClientRect();
    const box = node?.getBoundingClientRect();
    const column = (node?.closest('.sheet__body') ?? document.querySelector('main'))?.getBoundingClientRect();
    return {
      count: document.querySelectorAll(sel).length,
      inConfirmSheet: document.querySelector('dialog.sheet:not(.sheet--promo) .promo-banner') !== null,
      placement: node?.dataset.placement ?? '',
      tag: node?.tagName.toLowerCase() ?? '',
      href: node?.getAttribute('href'),
      target: node?.getAttribute('target'),
      rel: node?.getAttribute('rel'),
      ratio: box ? box.width / box.height : 0,
      widthMatchesColumn: box && column ? Math.abs(box.width - (column.width - 32)) <= 1 : false,
      afterGrid: box && grid ? box.top >= grid.bottom : false,
      radius: node ? getComputedStyle(node).borderTopLeftRadius : '',
      loading: image?.loading ?? '',
      filter: image ? getComputedStyle(image).filter : '',
      alt: image?.alt ?? '',
      src: image?.currentSrc ?? '',
      text: (node?.textContent ?? '').trim(),
      closeButton:
        [...(node?.closest('dialog')?.querySelectorAll('button') ?? [])].map((b) => (b.textContent ?? '').trim()),
    };
  }, selector);
  assert.equal(promo.count, 1, `expected exactly one promo banner (${expected})`);
  assert.equal(promo.inConfirmSheet, false, 'the promo banner is inside the confirm sheet');
  assert.equal(promo.placement, expected);
  if (expected === 'bottom') assert.ok(promo.afterGrid, 'the promo banner should come after the contestants');
  else assert.deepEqual(promo.closeButton, ['Close'], 'the panel should hold one button, Close (the promo button is a link)');
  assert.ok(promo.widthMatchesColumn, 'the promo banner is not the width of its column');
  // The real config has a 16:9 phone image, used below 640px: so does the stand-in build.
  const phone = options.phone ?? (await page.evaluate(() => window.innerWidth < 640));
  const wantRatio = phone ? 16 / 9 : 3;
  assert.ok(Math.abs(promo.ratio - wantRatio) < 0.02, `promo ratio ${promo.ratio}, expected ${wantRatio}`);
  const standIn = options.link !== undefined;
  const link = options.link ?? promoBanner.href ?? '';
  if (!standIn) {
    const wantFile = phone ? promoBanner.phoneImage ?? '' : promoBanner.image ?? '';
    assert.ok(promo.src.endsWith(wantFile), `promo shows ${promo.src}, expected ${wantFile}`);
  } else {
    assert.ok(promo.src.endsWith(phone ? 'phone-stand-in.svg' : '1920x640.jpg'), `promo shows ${promo.src}`);
  }
  assert.equal(promo.radius, '4px');
  assert.equal(promo.loading, expected === 'pop-up' ? 'eager' : 'lazy');
  assert.equal(promo.filter, 'none', 'the photo treatment must not reach the promo banner');
  assert.equal(promo.text, '', 'the promo banner must carry no text of its own');
  if (link === '') {
    assert.equal(promo.tag, 'div', 'no link configured, so the banner must not be a link');
    assert.equal(promo.alt, promoBanner.alt);
  } else {
    assert.equal(promo.tag, 'a');
    assert.equal(promo.href, link);
    assert.equal(promo.target, '_blank');
    assert.equal(promo.rel, 'noopener noreferrer');
  }
  if (expected === 'bottom') await page.evaluate(() => window.scrollTo(0, 0));
}

/**
 * Revision 12: once voted, the promo also sits straight under the "You voted
 * for" line, before See all contestants: one copy there, eager, full column
 * width, the right shape, and the bottom copy still in place.
 */
async function checkLedePromo(page: Page): Promise<void> {
  const selector = '.voter__intro .promo-banner[data-placement="lede"]';
  await page.waitForSelector(selector, { timeout: 10_000 });
  await page.waitForFunction((sel: string) => {
    const image = document.querySelector<HTMLImageElement>(`${sel} img`);
    return image !== null && image.complete && image.naturalWidth > 0;
  }, {}, selector);
  const lede = await page.evaluate((sel: string) => {
    const node = document.querySelector<HTMLElement>(sel);
    const box = node?.getBoundingClientRect();
    const intro = document.querySelector('.voter__intro')?.getBoundingClientRect();
    const seeAll = document.querySelector('.voter__see-all');
    return {
      count: document.querySelectorAll(sel).length,
      afterLede: node?.previousElementSibling?.classList.contains('voter__lede') ?? false,
      beforeSeeAll: seeAll === null || (node !== null && node !== undefined && (node.compareDocumentPosition(seeAll) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0),
      loading: node?.querySelector('img')?.loading ?? '',
      href: node?.getAttribute('href'),
      ratio: box ? box.width / box.height : 0,
      fullWidth: box && intro ? Math.abs(box.width - intro.width) <= 1 : false,
      bottomCopies: document.querySelectorAll('main .promo-banner[data-placement="bottom"]').length,
    };
  }, selector);
  assert.equal(lede.count, 1, 'expected one promo under the lede');
  assert.ok(lede.afterLede, 'the promo is not straight under the "You voted for" line');
  assert.ok(lede.beforeSeeAll, 'the promo is not above See all contestants');
  assert.equal(lede.loading, 'eager');
  assert.equal(lede.href, promoBanner.href);
  assert.ok(lede.fullWidth, 'the promo under the lede is not the width of the column');
  const phone = await page.evaluate(() => window.innerWidth < 640);
  assert.ok(Math.abs(lede.ratio - (phone ? 16 / 9 : 3)) < 0.02, `promo under the lede ratio ${lede.ratio}`);
  assert.equal(lede.bottomCopies, 1, 'the bottom promo is gone');
}

/**
 * Revision 11: the post-vote "Your vote is in" panel. Heading (with the name),
 * the promo image (checked by checkPromo), the configured lines in order, a
 * safe new-tab link to the promo, then Close; and the panel never runs off
 * the screen (it fits, or scrolls inside itself).
 */
async function checkVoteIsInPanel(page: Page, votedForName: string, link = promoBanner.href ?? ''): Promise<void> {
  const panel = await page.$eval('dialog.sheet--promo[open]', (dialog) => {
    const heading = dialog.querySelector('h2');
    const cta = dialog.querySelector<HTMLAnchorElement>('.sheet__actions a');
    const box = dialog.getBoundingClientRect();
    return {
      heading: (heading?.textContent ?? '').trim(),
      labelledByHeading: heading !== null && dialog.getAttribute('aria-labelledby') === heading.id,
      order: [...dialog.querySelectorAll('h2, .promo-banner, .promo-details, .sheet__actions')].map((n) => n.className || n.tagName),
      lines: [...dialog.querySelectorAll('.promo-details li')].map((li) => (li.textContent ?? '').trim()),
      cta: cta === null ? null : { text: (cta.textContent ?? '').trim(), href: cta.getAttribute('href'), target: cta.target, rel: cta.rel },
      actions: [...dialog.querySelectorAll('.sheet__actions > *')].map((n) => (n.textContent ?? '').trim()),
      top: box.top,
      bottom: box.bottom,
      fitsOrScrolls: box.bottom <= window.innerHeight + 1 || dialog.scrollHeight > dialog.clientHeight,
      withinScreen: box.top >= -1 && box.bottom <= window.innerHeight + 1,
    };
  });
  assert.equal(panel.heading, promoDetails.headingWithName.replace('{name}', votedForName));
  assert.ok(panel.labelledByHeading, 'the panel is not named by its heading');
  assert.deepEqual(panel.order, ['H2', 'promo-banner promo-banner--has-phone', 'promo-details', 'sheet__actions']);
  assert.deepEqual(panel.lines, [...promoDetails.lines]);
  assert.deepEqual(panel.cta, { text: promoDetails.cta, href: link, target: '_blank', rel: 'noopener noreferrer' });
  assert.deepEqual(panel.actions, [promoDetails.cta, 'Close']);
  assert.ok(panel.withinScreen, `the panel runs off the screen (top ${panel.top}, bottom ${panel.bottom})`);
  assert.ok(panel.fitsOrScrolls, 'the panel neither fits nor scrolls');
}

type BannerVariant = 'placeholder' | 'real' | 'kv';

async function checkBanner(page: Page, variant: BannerVariant, viewport: Viewport): Promise<void> {
  const banner = await page.$eval('.key-visual', (node) => {
    const box = node.getBoundingClientRect();
    const image = node.querySelector('img');
    const main = document.querySelector('main')?.getBoundingClientRect();
    const band = node.parentElement?.classList.contains('kv-band') ? node.parentElement : null;
    return {
      band: band
        ? {
            desktop: band.classList.contains('kv-band--desktop'),
            painted: getComputedStyle(band, '::before').borderImageSource.startsWith('linear-gradient'),
            fade: getComputedStyle(band, '::after').borderImageSource.startsWith('linear-gradient'),
          }
        : null,
      placeholder: node.classList.contains('key-visual--placeholder'),
      text: node.textContent ?? '',
      ratio: box.width / box.height,
      // Revision 10: edge to edge, up to the desktop creative's own 1920px.
      fullBleed: Math.abs(box.width - Math.min(document.documentElement.clientWidth, 1920)) <= 1,
      flushTop: Math.abs(box.top + window.scrollY - (document.querySelector('.demo-banner')?.getBoundingClientRect().bottom ?? 0)) <= 1,
      mainBelow: main ? main.top >= box.bottom - 1 : false,
      aboveHeader: (document.querySelector('.voter__top')?.getBoundingClientRect().top ?? 0) >= box.bottom,
      radius: getComputedStyle(node).borderTopLeftRadius,
      image: image
        ? {
            src: image.currentSrc,
            loading: image.loading,
            complete: image.complete && image.naturalWidth > 0,
            filter: getComputedStyle(image).filter,
            alt: image.alt,
          }
        : null,
    };
  });
  assert.ok(banner.fullBleed, 'banner does not run edge to edge');
  assert.ok(banner.flushTop, 'banner has a gap above it');
  assert.ok(banner.mainBelow, 'banner is not above the page column');
  assert.ok(banner.aboveHeader, 'banner is not above the header');
  assert.equal(banner.radius, '0px');
  if (variant === 'placeholder') {
    assert.equal(banner.placeholder, true);
    assert.match(banner.text, /Key visual goes here/);
    assert.match(banner.text, /1080 × 608/);
    // Same shapes as the spec sheet: 16:9 on phones, 3:1 from 900px.
    const expected = viewport.width >= 900 ? 3 : 16 / 9;
    assert.ok(Math.abs(banner.ratio - expected) < 0.02, `placeholder ratio ${banner.ratio}, expected ${expected}`);
    return;
  }
  assert.ok(banner.image, 'no image in the banner');
  await page.waitForFunction(() => {
    const image = document.querySelector<HTMLImageElement>('.key-visual img');
    return image !== null && image.complete && image.naturalWidth > 0;
  });
  const desktop = viewport.width >= 900;
  // The page background around a real image is the key visual band (Revision 8).
  assert.ok(banner.band, 'the key visual is not inside its colour band');
  assert.ok(banner.band.painted && banner.band.fade, 'the key visual band is not painted');
  assert.equal(banner.band.desktop, true, 'both images are set, so the band should carry both sets of colour stops');
  if (variant === 'real') {
    // Kelicia's creative, 2026-10-05: 16:9 below 900px, 3:1 from 900px.
    const file = desktop ? keyVisual.desktop ?? '' : keyVisual.mobile ?? '';
    assert.ok(file !== '' && banner.image.src.endsWith(file), `banner shows ${banner.image.src}, expected ${file}`);
    assert.ok(Math.abs(banner.ratio - (desktop ? 3 : 16 / 9)) < 0.02, `banner ratio ${banner.ratio}`);
    assert.equal(banner.image.loading, 'eager');
    assert.equal(banner.image.filter, 'none', 'the key visual must not get the photo treatment');
    assert.equal(banner.image.alt, keyVisual.alt);
    assert.doesNotMatch(banner.image.alt, /jung\s*kook|jkook|jeon|bts/i, 'the alt text names the artist');
    return;
  }
  assert.ok(banner.image.src.endsWith(desktop ? 'desktop.svg' : 'mobile.svg'), banner.image.src);
  assert.ok(Math.abs(banner.ratio - (desktop ? 3 : 16 / 9)) < 0.02, `banner ratio ${banner.ratio}`);
  assert.equal(banner.image.loading, 'eager');
  assert.equal(banner.image.filter, 'none', 'the key visual must not get the photo treatment');
  assert.equal(banner.image.alt, 'Stand-in key visual for testing');
}

async function layouts(browser: Browser, site: string, variant: 'real' | 'kv'): Promise<void> {
  const prefix = variant === 'kv' ? 'layout-kv' : 'layout';
  for (const { name: width, viewport } of LAYOUTS) {
    const name = variant === 'kv' ? `${width} (key visual)` : width;
    // The stand-in build sets a made-up https link and a 16:9 phone image for the promo.
    const promoOptions =
      variant === 'kv' ? { link: STAND_IN_PROMO_LINK, phone: viewport.width < 640 } : {};
    const isPhone = viewport.isMobile === true;
    const context = await browser.createBrowserContext();
    const page = await open(context, `${site}/`, { viewport });
    const fits = async (state: string): Promise<void> => {
      const wide = await overflowing(page);
      assert.deepEqual(wide, [], `${name}px, ${state}: wider than the screen`);
    };

    await step(`${name}px: open grid`, async () => {
      await see(page, OPEN_H1);
      await fits('open grid');
      assert.deepEqual(await smallTargets(page, '.grid'), [], `${name}px: small contestant cards`);
      const columns = await page.$eval('.grid', (grid) => getComputedStyle(grid).gridTemplateColumns.split(' ').length);
      assert.equal(columns, isPhone ? 2 : 4, `${name}px: ${columns} columns`);
      await checkBanner(page, variant, viewport);
      if (width === '1280') {
        firstScreens[`${variant} at 1280 x 900, as the public sees it (no demo banner)`] = await measureFirstScreen(page, true);
      }
      if (width === '390') {
        firstScreens[`${variant}, demo banner showing`] = await measureFirstScreen(page, false);
        firstScreens[`${variant}, as the public sees it (no demo banner)`] = await measureFirstScreen(page, true);
        const publicView = firstScreens[`${variant}, as the public sees it (no demo banner)`];
        assert.ok(publicView && publicView.cardsPartlyVisible >= 2, `${name}: no contestants on the first screen`);
      }
      await shot(page, `${prefix}-${width}-1-open`);
      if (variant === 'real' && (width === '390' || width === '1280')) {
        // Revision 8, for Kelicia to compare: the same screen with the page heading
        // hidden visually (still read by screen readers). Not the shipped design.
        const hide = await page.addStyleTag({
          content:
            '.voter__intro h1 { position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }',
        });
        await shot(page, `option-h1-hidden-${width}-1-open`);
        if (width === '390') firstScreens['real, H1 visually hidden (option, not shipped), public view'] = await measureFirstScreen(page, true);
        await hide.evaluate((node) => node.remove());
      }
      await noPromoYet(page);
      if (variant === 'kv') {
        await page.evaluate(() => document.querySelector('.grid')?.scrollIntoView());
        await shot(page, `${prefix}-${width}-1b-grid-photos`);
        await page.evaluate(() => window.scrollTo(0, 0));
      }
    });

    if (variant === 'kv') {
      await step(`${name}px: long and short names fit their cards, nothing clipped`, async () => {
        const problems = await page.$$eval('.grid > li', (cards) =>
          cards.flatMap((card) => {
            const box = card.getBoundingClientRect();
            const caption = card.querySelector('.card__caption')?.getBoundingClientRect();
            const stage = card.querySelector('.card__stage') as HTMLElement | null;
            const label = card.querySelector('.card__label') as HTMLElement | null;
            const out: string[] = [];
            const who = stage?.textContent ?? '?';
            if (caption && (caption.top < box.top || caption.bottom > box.bottom + 0.5 || caption.right > box.right + 0.5)) {
              out.push(`${who}: caption outside the card`);
            }
            for (const part of [stage, label]) {
              if (part && part.scrollWidth > part.clientWidth + 1) out.push(`${who}: text clipped sideways`);
            }
            return out;
          }),
        );
        assert.deepEqual(problems, []);
        const label = await page.$eval('.grid > li:nth-child(5) .card__label', (node) => node.textContent);
        assert.equal(label, 'No. 05 · @stand.in.handle');
      });
    }

    await step(`${name}px: confirm step with the email field`, async () => {
      await pickCard(page, 1);
      await typeEmail(page, `${prefix}-${width}@example.com`);
      await fits('confirm');
      assert.deepEqual(await smallTargets(page, 'dialog.sheet'), [], `${name}px: small targets in the sheet`);
      const sheet = await (await page.$('dialog.sheet'))?.boundingBox();
      assert.ok(sheet, 'no sheet');
      assert.ok(sheet.y >= 0 && sheet.y + sheet.height <= viewport.height + 1, `${name}px: sheet off screen`);
      if (isPhone) {
        assert.ok(Math.abs(sheet.y + sheet.height - viewport.height) <= 1, `${name}px: sheet not docked to the bottom`);
      }
      await shot(page, `${prefix}-${width}-2-confirm`);
    });

    if (isPhone) {
      await step(`${name}px: confirm step still usable with a keyboard taking half the screen (simulated)`, async () => {
        // Headless Chrome has no on-screen keyboard. Shrinking the window is the
        // nearest stand-in: like the keyboard, it shrinks window.visualViewport,
        // which is what the sheet is laid out against. A real phone must confirm it.
        const withKeyboard = { ...viewport, height: Math.round(viewport.height * 0.5) };
        await page.setViewport(withKeyboard);
        await page.waitForFunction(() => document.documentElement.hasAttribute('data-vv-short'));
        const layout = await page.evaluate(() => {
          const button = [...document.querySelectorAll<HTMLButtonElement>('dialog.sheet button')].find(
            (candidate) => (candidate.textContent ?? '').trim() === 'Confirm vote',
          );
          const back = [...document.querySelectorAll<HTMLButtonElement>('dialog.sheet button')].find(
            (candidate) => (candidate.textContent ?? '').trim() === 'Back',
          );
          return {
            back: back?.getBoundingClientRect().toJSON() as DOMRect | undefined,
            input: document.querySelector('#voter-email')?.getBoundingClientRect().toJSON() as DOMRect | undefined,
            button: button?.getBoundingClientRect().toJSON() as DOMRect | undefined,
            art: document.querySelector('.sheet__art')?.getBoundingClientRect().toJSON() as DOMRect | undefined,
          };
        });
        assert.ok(layout.input && layout.input.top >= 0, 'email field scrolled out of view');
        assert.ok(
          layout.button && layout.button.bottom <= withKeyboard.height + 1,
          `Confirm button is under the keyboard (bottom ${layout.button?.bottom}, visible ${withKeyboard.height})`,
        );
        assert.equal(layout.art?.height ?? 0, 0, 'the picture should give way to the field');
        assert.ok(
          layout.back && layout.back.bottom <= withKeyboard.height + 1,
          `Back button is under the keyboard (bottom ${layout.back?.bottom}, visible ${withKeyboard.height})`,
        );
        await shot(page, `${prefix}-${width}-2b-confirm-keyboard`);
        await page.setViewport(viewport);
      });
    }

    await step(`${name}px: voted`, async () => {
      await press(page, 'Confirm vote', 'dialog.sheet');
      await see(page, 'You voted for #1 Contestant 1.');
      await see(page, 'Done. Your vote is counted.');
      await checkPromo(page, 'pop-up', promoOptions);
      await fits('promo pop-up');
      await shot(page, `${prefix}-${width}-3a-promo-popup`);
      await press(page, 'Close', 'dialog.sheet--promo');
      await page.waitForFunction(() => document.querySelector('dialog.sheet--promo[open]') === null);
      await fits('voted');
      if (width === '390') {
        votedScreens[`${variant}, demo notice showing`] = await measureVotedScreen(page, false);
        votedScreens[`${variant}, as the public sees it (no demo notice)`] = await measureVotedScreen(page, true);
        const publicView = votedScreens[`${variant}, as the public sees it (no demo notice)`];
        assert.ok(publicView && publicView.messageFullyVisible, `${name}: the vote-counted message is pushed off the first screen`);
        assert.ok(publicView && publicView.gridTopPx < 844, `${name}: the grid is pushed off the first screen`);
      }
      assert.deepEqual(await smallTargets(page, '.voter__intro'), [], `${name}px: small targets in the intro`);
      await shot(page, `${prefix}-${width}-3-voted`);
      await checkPromo(page, 'bottom', promoOptions);
      await page.evaluate(() => window.scrollTo(0, 0));
    });

    await step(`${name}px: duplicate email refused`, async () => {
      await press(page, ANOTHER_PERSON);
      await voteFor(page, 2, `${prefix}-${width}@example.com`);
      await see(page, DUPLICATE);
      await fits('duplicate');
      await shot(page, `${prefix}-${width}-4-duplicate`);
    });

    await step(`${name}px: closed`, async () => {
      await press(page, 'After voting closes');
      await see(page, 'Voting has closed');
      assert.equal((await text(page)).includes(DUPLICATE), false, 'a stale refusal is still shown');
      await page.evaluate(() => window.scrollTo(0, 0));
      await fits('closed');
      await shot(page, `${prefix}-${width}-5-closed`);
      await checkPromo(page, 'bottom', promoOptions);
    });

    await step(`${name}px: admin`, async () => {
      const admin = await open(context, `${site}/#/admin`, { viewport });
      admin.on('dialog', (dialog) => void dialog.accept());
      await admin.waitForSelector('#passcode');
      await admin.type('#passcode', demo.passcode);
      await press(admin, 'Unlock');
      await see(admin, 'Tally and ranking');
      const wide = await overflowing(admin);
      assert.deepEqual(wide, [], `${name}px admin: wider than the screen`);
      await shot(admin, `${prefix}-${width}-6-admin`, true);
    });

    await context.close();
  }
}

// ------------------------------------------------------------------ Part B

async function partB(
  browser: Browser,
  site: string,
  api: LocalApiServer,
  prodDir: string,
  demoSiteOrigin: string,
): Promise<void> {
  const callApi = async (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<unknown> => {
    const response = await fetch(`${api.url}/api/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return response.json();
  };
  const voteCount = async (): Promise<number> =>
    (await api.db.query('select 1 from public.votes where replaced_at is null')).rows.length;

  // The API runs in this process: whatever it logs is seen here, and checked at the end.
  const serverLog: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]): void => {
    serverLog.push(args.map(String).join(' '));
    originalError(...args);
  };

  await step('production bundle contains no demo store, demo controls or secrets', async () => {
    const bundle = filesUnder(prodDir)
      .filter((file) => /\.(js|html|css)$/.test(file))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    assert.ok(bundle.length > 10_000, 'bundle looks empty');
    for (const leak of [
      demo.passcode,
      'Simulate a burst',
      'New visitor, same email',
      'Made-up addresses',
      'Key visual goes here',
      PROD_PASSCODE,
      PROD_HASH_SECRET,
    ]) {
      assert.equal(bundle.includes(leak), false, `"${leak}" leaked into the production bundle`);
    }
  });

  const first = await browser.createBrowserContext();
  const home = await open(first, `${site}/`);

  await step('no DEMO banner and no demo controls on the production build', async () => {
    await see(home, OPEN_H1);
    const body = await text(home);
    assert.equal(body.includes('DEMO DATA'), false);
    assert.equal(body.includes('Demo controls'), false);
    assert.equal(await home.$('.panel--demo'), null);
  });

  await step('production build shows the real key visual, in its colour band, at every width', async () => {
    const context = await browser.createBrowserContext();
    for (const { name, viewport } of LAYOUTS) {
      const page = await open(context, `${site}/`, { viewport });
      await see(page, OPEN_H1);
      await checkBanner(page, 'real', viewport);
      assert.deepEqual(await overflowing(page), [], `${name}px: wider than the screen`);
      const firstChild = await page.$eval('.app', (app) => app.firstElementChild?.className);
      assert.equal(firstChild, 'kv-band kv-band--desktop', 'the key visual should be the first thing on the page');
      await noPromoYet(page);
      if (name === '390') firstScreens['production build, real key visual'] = await measureFirstScreen(page, false);
      await shot(page, `layout-prod-${name}-1-open`);
      await page.close();
    }
    await context.close();
  });

  await step('vote accepted', async () => {
    await voteFor(home, 5, EMAIL.alice);
    await see(home, 'You voted for #5 Contestant 5.');
    assert.equal(await voteCount(), 1);
    await shot(home, 'prod-01-vote-counted');
  });

  await step('a second person on the same network (same IP) votes with their own email', async () => {
    const context = await browser.createBrowserContext();
    const flatmate = await open(context, `${site}/`);
    await see(flatmate, OPEN_H1);
    assert.equal(await cardsDisabled(flatmate), false, 'a shared network must not block anyone');
    await voteFor(flatmate, 5, EMAIL.flatmate);
    await see(flatmate, 'You voted for #5 Contestant 5.');
    assert.equal(await voteCount(), 2);
    await shot(flatmate, 'prod-02-same-network-second-voter');
    await context.close();
  });

  await step('an email that has already voted is refused by the server, with the plain message', async () => {
    const context = await browser.createBrowserContext();
    const colleague = await open(context, `${site}/`);
    await see(colleague, OPEN_H1);
    // The same person already voted from another device while this page sat open.
    const other = await callApi('vote', {
      contestantId: 'c09',
      email: EMAIL.colleague,
      requestId: 'e2e-colleague-first-vote',
    });
    assert.equal((other as { ok: boolean }).ok, true);

    await voteFor(colleague, 8, `  ${EMAIL.colleague.toUpperCase()} `);
    await see(colleague, DUPLICATE);
    assert.equal((await text(colleague)).includes('Vote in!'), false);
    assert.equal(await colleague.$('.card--chosen'), null);
    assert.equal(await voteCount(), 3);
    await shot(colleague, 'prod-03-duplicate-email');
    await context.close();
  });

  await step('Gmail dots and "+tags" do not make a new voter', async () => {
    const firstVote = await callApi('vote', { contestantId: 'c02', email: EMAIL.gmail, requestId: 'e2e-variant-0001' });
    assert.equal((firstVote as { ok: boolean }).ok, true);
    for (const [index, variant] of ['janedoe@gmail.com', 'Jane.Doe+vote2@gmail.com', 'j.a.n.e.doe@googlemail.com'].entries()) {
      const again = await callApi('vote', { contestantId: 'c03', email: variant, requestId: `e2e-variant-100${index}` });
      assert.deepEqual(again, { ok: false, error: 'duplicate_vote' }, variant);
    }
    assert.equal(await voteCount(), 4);
  });

  await step('address headers buy nothing: a new "network" does not give an email a second vote', async () => {
    const forged = await callApi(
      'vote',
      { contestantId: 'c01', email: EMAIL.alice, requestId: 'e2e-forged-headers-01' },
      { 'X-Forwarded-For': '192.0.2.200', 'X-Real-IP': '192.0.2.200', 'Client-IP': '192.0.2.200' },
    );
    assert.deepEqual(forged, { ok: false, error: 'duplicate_vote' });
    assert.equal(await voteCount(), 4);
  });

  await step('a malformed email is refused by the server, not only by the page', async () => {
    const answer = await callApi('vote', { contestantId: 'c01', email: 'alice.tan@', requestId: 'e2e-bad-email-01' });
    assert.deepEqual(answer, { ok: false, error: 'invalid_email' });
    assert.equal(await voteCount(), 4);
  });

  await step('readable emails and IPs are only in the audit table; the votes table holds hashes', async () => {
    const audit = await api.db.query<{ email_typed: string; ip: string }>(
      'select email_typed, ip from public.vote_audit order by vote_id',
    );
    assert.equal(audit.rows.length, 4);
    assert.ok(audit.rows.every((row) => row.email_typed.includes('@')));
    // Every browser here reaches the API from this machine: loopback, as the socket reports it.
    assert.ok(audit.rows.every((row) => /^(127\.0\.0\.1|::1)$/.test(row.ip)), JSON.stringify(audit.rows));
    const dump = JSON.stringify([
      (await api.db.query('select * from public.votes')).rows,
      (await api.db.query('select * from public.rate_buckets')).rows,
    ]).toLowerCase();
    assert.equal(dump.includes('@'), false, 'an email address is stored in the database');
    assert.equal(/127\.0\.0\.1|::1/.test(dump), false, 'an IP address is stored outside the audit table');
    for (const fragment of ['alice', 'ben.lim', 'chloe', 'jane', 'example', 'gmail']) {
      assert.equal(dump.includes(fragment), false, `"${fragment}" is stored in the database`);
    }
    const keys = await api.db.query<{ voter_key: string }>('select voter_key from public.votes');
    assert.equal(keys.rows.length, 4);
    for (const row of keys.rows) assert.match(row.voter_key, /^[0-9a-f]{64}$/);
    assert.equal(new Set(keys.rows.map((row) => row.voter_key)).size, 4);
  });

  await step('connection drops mid-vote: retry, honest failure message, then recovery', async () => {
    const context = await browser.createBrowserContext();
    const train = await open(context, `${site}/`);
    await see(train, OPEN_H1);

    await api.pause();
    await voteFor(train, 6, EMAIL.train);
    await see(train, 'Connection is slow. Trying again');
    await shot(train, 'prod-04-vote-retrying');
    await see(train, "Not sent: we couldn't reach the voting server.", 30_000);
    await see(train, 'Your vote has not been counted yet.');
    assert.equal((await text(train)).includes('Vote in!'), false);
    await shot(train, 'prod-05-vote-not-sent');
    assert.equal(await voteCount(), 4, 'nothing may be recorded while unreachable');

    await api.resume();
    await press(train, 'Try sending again');
    await see(train, 'You voted for #6 Contestant 6.', 30_000);
    assert.equal(await voteCount(), 5, 'the retried vote is counted exactly once');
    await context.close();
  });

  await step('server down on first load: a clear message, then recovery', async () => {
    await api.pause();
    const context = await browser.createBrowserContext();
    const page = await open(context, `${site}/`);
    await see(page, "Can't reach the voting server");
    await shot(page, 'prod-06-unreachable');
    await api.resume();
    await press(page, 'Try again');
    await see(page, OPEN_H1);
    await context.close();
  });

  await step('arriving with Instagram tracking parameters still lands on the voting page', async () => {
    const context = await browser.createBrowserContext();
    const page = await open(
      context,
      `${site}/?fbclid=IwZXh0bgNhZW0CMTEAAR3&igsh=MWZ4dGVzdA%3D%3D&utm_source=ig`,
      { userAgent: INSTAGRAM_UA },
    );
    await see(page, OPEN_H1);
    await voteFor(page, 10, EMAIL.instagram);
    await see(page, 'You voted for #10 Contestant 10.');
    assert.equal(await voteCount(), 6);
    await context.close();
  });

  await step('a browser that blocks storage can still vote, and its email is still limited to one', async () => {
    const context = await browser.createBrowserContext();
    const blockStorage = `
      for (const name of ['localStorage', 'sessionStorage']) {
        Object.defineProperty(window, name, {
          get() { throw new DOMException('The operation is insecure.', 'SecurityError'); },
        });
      }
    `;
    const page = await open(context, `${site}/`, { before: blockStorage });
    await voteFor(page, 8, EMAIL.locked);
    await see(page, 'You voted for #8 Contestant 8.');
    assert.equal(await voteCount(), 7);
    // With nowhere to keep the marker the page forgets, but the server does not.
    await page.reload({ waitUntil: 'load' });
    await see(page, OPEN_H1);
    await voteFor(page, 9, EMAIL.locked);
    await see(page, DUPLICATE);
    assert.equal(await voteCount(), 7);
    await context.close();
  });

  await step('a browser without <dialog>.showModal (iOS before 15.4) can still confirm a vote', async () => {
    const context = await browser.createBrowserContext();
    const removeShowModal = `
      delete HTMLDialogElement.prototype.showModal;
      delete HTMLDialogElement.prototype.close;
      delete Crypto.prototype.randomUUID;
    `;
    const page = await open(context, `${site}/`, { before: removeShowModal });
    await pickCard(page, 7);
    assert.ok(await page.$('dialog.sheet.sheet--fallback[open]'), 'fallback sheet did not open');
    const box = await (await page.$('dialog.sheet'))?.boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= PHONE.height + 1, 'sheet is off screen');
    await typeEmail(page, EMAIL.oldPhone);
    await shot(page, 'prod-07-sheet-fallback');
    await press(page, 'Confirm vote', 'dialog.sheet');
    await see(page, 'You voted for #7 Contestant 7.');
    assert.equal(await voteCount(), 8);
    await context.close();
  });

  const adminContext = await browser.createBrowserContext();
  const admin = await open(adminContext, `${site}/#/admin`, { viewport: LAPTOP, before: captureDownloads });
  admin.on('dialog', (dialog) => void dialog.accept());

  await step('admin: passcode gate, then the live tally from the database', async () => {
    assert.equal((await text(admin)).includes('Demo passcode'), false);
    await unlockAdmin(admin, PROD_PASSCODE);
    await votesCounted(admin, 8);
    const top = await admin.$eval('.ranking tbody tr', (tr) =>
      (tr as HTMLElement).innerText.replace(/\s+/g, ' ').trim(),
    );
    assert.equal(top, '1 #5 Contestant 5 2');
    assert.equal(await admin.$('.panel--demo'), null);
    await shot(admin, 'prod-08-admin', true);
  });

  await step('admin: the CSV exports from the real database carry no email address', async () => {
    await press(admin, 'Tally per contestant (CSV)');
    await press(admin, 'Every vote, with timestamps (CSV)');
    const log = await lastDownload(admin, 2);
    const everything = `${await lastDownload(admin, 1)}\n${log}`;
    assert.equal(log.trim().split('\r\n').length, 9, 'header plus 8 votes');
    assert.equal(everything.includes('@'), false, 'an email address is in the CSV');
    assert.equal(/alice|ben\.lim|chloe|jane|example|gmail/i.test(everything), false, 'part of an email is in the CSV');
    const refs = log.trim().split('\r\n').slice(1).map((line) => line.split(',').at(-1) ?? '');
    for (const ref of refs) assert.match(ref, /^[0-9a-f]{12}$/);
  });

  await step('admin: the confidential audit export from the real database has the emails and IPs', async () => {
    await press(admin, 'Audit export: emails and IP addresses (CSV)');
    await see(admin, 'Downloaded the confidential audit export (8 rows).');
    const lines = (await lastDownload(admin, 3)).replace(/^\uFEFF/, '').trim().split('\r\n');
    assert.equal(lines[0], AUDIT_HEADER);
    assert.equal(lines.length, 9);
    const rows = lines.slice(1).map(cells);
    assert.ok(rows.every((row) => /^(127\.0\.0\.1|::1)$/.test(row[7] ?? '') && row[8] === 'platform' && row[9] === '8'));
    assert.ok(rows.some((row) => row[5] === EMAIL.alice && row[6] === EMAIL.alice));
    assert.ok(rows.some((row) => row[5] === EMAIL.gmail && row[6] === 'janedoe@gmail.com'));
    assert.match((await downloadNames(admin))[2] ?? '', /^vote-audit-CONFIDENTIAL-.+\.csv$/);
    assert.equal(PERSONAL_ON_SCREEN.test(await text(admin)), false, 'an email or IP address is on the admin screen');
  });

  await step('admin closes voting: votes are refused by the server, not just hidden by the page', async () => {
    await press(admin, 'Close voting');
    await see(admin, 'Voting is closed.');
    const late = await callApi('vote', {
      contestantId: 'c01',
      email: 'late@example.com',
      requestId: 'e2e-after-close-0001',
    });
    assert.deepEqual(late, { ok: false, error: 'voting_closed' });

    await home.reload({ waitUntil: 'load' });
    await see(home, 'Voting has closed');
    await see(home, 'Your vote for #5 Contestant 5 is in.');
    await see(home, WINNER_LINE);
    await checkLedePromo(home);
    await shot(home, 'prod-09-vote-closed');
    await press(admin, 'Reopen voting');
    await see(admin, 'Voting is set to open.');
  });

  await step('before the window opens, the server refuses votes and the page shows the opening time', async () => {
    const opensAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    await api.db.exec(`update public.event_settings set opens_at = '${opensAt}' where id = 1`);
    const early = await callApi('vote', {
      contestantId: 'c01',
      email: 'early@example.com',
      requestId: 'e2e-before-open-0001',
    });
    assert.deepEqual(early, { ok: false, error: 'voting_not_open' });

    const context = await browser.createBrowserContext();
    const page = await open(context, `${site}/`);
    await see(page, 'Voting opens soon');
    await see(page, `Voting opens ${formatSgtDateTime(opensAt)}.`);
    assert.equal(await cardsDisabled(page), true);
    await context.close();
    assert.equal(await voteCount(), 8);
  });

  await step('cross-origin: the API names the one allowed site, never a wildcard', async () => {
    const preflight = await fetch(`${api.url}/api/vote`, {
      method: 'OPTIONS',
      headers: {
        Origin: site,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), site);
    assert.equal(preflight.headers.get('vary'), 'Origin');

    const answer = await fetch(`${api.url}/api/session`, {
      method: 'POST',
      headers: { Origin: site, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(answer.headers.get('access-control-allow-origin'), site);
  });

  await step('cross-origin: a page on any other site is refused, by the API and by the browser', async () => {
    for (const origin of ['https://evil.example', demoSiteOrigin, 'null']) {
      const preflight = await fetch(`${api.url}/api/vote`, {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
      });
      assert.equal(preflight.status, 403, `preflight from ${origin}`);
      assert.equal(preflight.headers.get('access-control-allow-origin'), null);

      const direct = await fetch(`${api.url}/api/vote`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contestantId: 'c01', email: 'foreign@example.com', requestId: 'e2e-foreign-origin-01' }),
      });
      assert.equal(direct.status, 403, `vote from ${origin}`);
    }
    assert.equal(await voteCount(), 8);

    // And from inside a real browser, on a real page served from another origin.
    const context = await browser.createBrowserContext();
    const foreign = await open(context, `${demoSiteOrigin}/`);
    const outcome = await foreign.evaluate(async (target: string) => {
      try {
        const response = await fetch(target, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contestantId: 'c01',
            email: 'foreign@example.com',
            requestId: 'e2e-foreign-browser-01',
          }),
        });
        return `answered ${response.status}`;
      } catch (error) {
        return `blocked: ${String(error)}`;
      }
    }, `${api.url}/api/vote`);
    assert.match(outcome, /^blocked: TypeError/, outcome);
    assert.equal(await voteCount(), 8);
    await context.close();
  });

  await step('the IP-era diagnose route no longer exists', async () => {
    const response = await fetch(`${api.url}/api/admin/diagnose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: PROD_PASSCODE }),
    });
    assert.equal(response.status, 404);
  });

  await step('the admin passcode is never accepted from a guess over the API', async () => {
    for (const passcode of ['', 'guess', demo.passcode, PROD_PASSCODE.slice(0, -1)]) {
      const answer = await callApi('admin/snapshot', { passcode });
      assert.deepEqual(answer, { ok: false, error: 'bad_passcode' });
    }
  });

  await step('the voting page and browser storage hold no email or IP; the server log holds neither', async () => {
    await home.bringToFront();
    assert.equal(PERSONAL_ON_SCREEN.test(await text(home)), false, 'an email or IP address is on the voting page');
    const stored = await home.evaluate(() =>
      JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), document.cookie]),
    );
    assert.equal(PERSONAL_ON_SCREEN.test(stored), false, 'an email or IP address is in browser storage');
    const log = serverLog.join('\n');
    assert.equal(/@|127\.0\.0\.1|::1\b/.test(log), false, `the server log holds personal data:\n${log}`);
  });

  console.error = originalError;
  await adminContext.close();
  await first.close();
}

/** Demo build with the key visual slot emptied: the marked placeholder, at every width. */
async function placeholderLayouts(browser: Browser, site: string): Promise<void> {
  await step('no key visual set: the demo shows the marked placeholder (16:9, 3:1 from 900px), at every width', async () => {
    const context = await browser.createBrowserContext();
    for (const { name, viewport } of LAYOUTS) {
      const page = await open(context, `${site}/`, { viewport });
      await see(page, OPEN_H1);
      await checkBanner(page, 'placeholder', viewport);
      assert.equal(await page.$('.kv-band'), null, `${name}px: the colour band belongs to a real image only`);
      assert.deepEqual(await overflowing(page), [], `${name}px: wider than the screen`);
      await shot(page, `layout-placeholder-${name}-1-open`);
      await page.close();
    }
    await context.close();
  });
}

/** Production build with the key visual slot emptied: the slot collapses completely. */
async function productionWithoutKeyVisual(browser: Browser, site: string): Promise<void> {
  await step('no key visual set: in production the slot collapses completely, at every width', async () => {
    const context = await browser.createBrowserContext();
    for (const { name, viewport } of LAYOUTS) {
      const page = await open(context, `${site}/`, { viewport });
      await see(page, OPEN_H1);
      assert.equal(await page.$('.key-visual'), null, `${name}px: a banner slot is showing`);
      assert.equal(await page.$('.kv-band'), null, `${name}px: a colour band is showing`);
      assert.equal((await text(page)).includes('Key visual'), false);
      const firstChild = await page.$eval('main.voter', (main) => main.firstElementChild?.className);
      assert.equal(firstChild, 'voter__top', 'the header should be first when there is no key visual');
      await noPromoYet(page);
      if (name === '390') firstScreens['production build, no key visual'] = await measureFirstScreen(page, false);
      await shot(page, `layout-prod-no-kv-${name}-1-open`);
      await page.close();
    }
    await context.close();
  });
}

async function main(): Promise<void> {
  const chrome = CHROME_CANDIDATES.find((path) => path !== undefined && existsSync(path));
  if (chrome === undefined) {
    throw new Error('No Chrome found. Set CHROME_PATH to a Chrome or Chromium binary.');
  }
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
  const servers: PreviewServer[] = [];
  let api: LocalApiServer | null = null;
  let sheetStub: SheetStubServer | null = null;
  let sheetProdStub: SheetStubServer | null = null;
  let sheetProdOpenStub: SheetStubServer | null = null;

  try {
    console.log('\nPart A: demo build, local adapter');
    const demoDir = join(BUILDS, 'demo');
    await buildSite(demoDir, { VITE_STORAGE_ADAPTER: 'local' });
    servers.push(await serve(demoDir, SITE_PORT_DEMO));
    const demoSite = `http://127.0.0.1:${SITE_PORT_DEMO}`;
    await partA(browser, demoSite);

    console.log('\nLayout, real key visual (Revision 8): 360, 390, 430, 1280px');
    await layouts(browser, demoSite, 'real');

    console.log('\nNo key visual set (stand-in config): the demo placeholder');
    const noKvDir = join(BUILDS, 'no-kv');
    const noKvConfig = join(BUILDS, 'no-key-visual-config.ts');
    mkdirSync(BUILDS, { recursive: true });
    writeNoKeyVisualConfig(noKvConfig);
    await buildSite(noKvDir, { VITE_STORAGE_ADAPTER: 'local' }, [standInConfigPlugin(noKvConfig)]);
    servers.push(await serve(noKvDir, SITE_PORT_NO_KV));
    const noKvSite = `http://127.0.0.1:${SITE_PORT_NO_KV}`;
    await placeholderLayouts(browser, noKvSite);

    console.log('\nLayout, stand-in key visual and stand-in photos: 360, 390, 430, 1280px');
    const kvDir = join(BUILDS, 'kv');
    const overridePath = join(BUILDS, 'stand-in-config.ts');
    mkdirSync(BUILDS, { recursive: true });
    writeStandInConfig(overridePath);
    await buildSite(kvDir, { VITE_STORAGE_ADAPTER: 'local' }, [standInConfigPlugin(overridePath)]);
    writeStandInImages(kvDir);
    servers.push(await serve(kvDir, SITE_PORT_KV));
    const kvSite = `http://127.0.0.1:${SITE_PORT_KV}`;
    await layouts(browser, kvSite, 'kv');

    console.log('\nPart B: production adapter against the local API stand-in (real handler, real schema.sql)');
    api = await startLocalApiServer({
      port: API_PORT,
      passcode: PROD_PASSCODE,
      hashSecret: PROD_HASH_SECRET,
      eventId: event.id,
      contestants,
      // Open now, whatever today's date is. The configured window is weeks away.
      window: {
        opensAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        closesAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        autoOpen: true,
      },
      rules: { allowVoteChange: false, publicCounts: false },
      // The page and the API are on different origins here, as they will be on
      // GitHub Pages + Supabase. Only the production-adapter site is allowed in.
      allowedOrigins: [`http://127.0.0.1:${SITE_PORT_PROD}`, `http://127.0.0.1:${SITE_PORT_PROD_NO_KV}`],
    });
    const prodDir = join(BUILDS, 'api');
    await buildSite(prodDir, {
      VITE_STORAGE_ADAPTER: 'api',
      VITE_API_BASE_URL: `${api.url}/api`,
    });
    servers.push(await serve(prodDir, SITE_PORT_PROD));
    const prodSite = `http://127.0.0.1:${SITE_PORT_PROD}`;
    console.log('\nProduction build with no key visual set (stand-in config). Runs before Part B, which moves the voting window');
    const prodNoKvDir = join(BUILDS, 'api-no-kv');
    await buildSite(
      prodNoKvDir,
      { VITE_STORAGE_ADAPTER: 'api', VITE_API_BASE_URL: `${api.url}/api` },
      [standInConfigPlugin(noKvConfig)],
    );
    servers.push(await serve(prodNoKvDir, SITE_PORT_PROD_NO_KV));
    const prodNoKvSite = `http://127.0.0.1:${SITE_PORT_PROD_NO_KV}`;
    await productionWithoutKeyVisual(browser, prodNoKvSite);

    await partB(browser, prodSite, api, prodDir, demoSite);

    console.log('\nPart C: Google Sheet test build against a stand-in running apps-script/Code.gs');
    sheetStub = await startSheetStubServer(SHEET_STUB_PORT, { adminKey: SHEET_ADMIN });
    const sheetDir = join(BUILDS, 'sheet');
    await buildSite(sheetDir, {
      VITE_STORAGE_ADAPTER: 'sheet',
      VITE_SHEET_ENDPOINT: `${sheetStub.url}/exec`,
      VITE_IP_LOOKUP_URL: `${sheetStub.url}/ip`,
      VITE_TEST_DEPLOY: '1',
    });
    servers.push(await serve(sheetDir, SITE_PORT_SHEET));
    const sheetSite = `http://127.0.0.1:${SITE_PORT_SHEET}`;
    await partC(browser, sheetSite, sheetStub, sheetDir, prodDir);

    console.log('\nPart D: PRODUCTION Google Sheet build under /imc4-lookalike-vote/ (real config, open from 26 Oct; then a filled Contestants tab)');
    sheetProdStub = await startSheetStubServer(SHEET_STUB_PROD_PORT, {
      adminKey: SHEET_ADMIN,
      window: { opensAt: votingWindow.opensAt ?? '', closesAt: votingWindow.closesAt ?? '' },
    });
    const sheetProdDir = join(BUILDS, 'sheet-prod');
    await buildSite(sheetProdDir, {
      VITE_STORAGE_ADAPTER: 'sheet',
      VITE_SHEET_ENDPOINT: `${sheetProdStub.url}/exec`,
      VITE_IP_LOOKUP_URL: `${sheetProdStub.url}/ip`,
    });
    servers.push(await serve(sheetProdDir, SITE_PORT_SHEET_PROD, PAGES_BASE));
    const sheetProdSite = `http://127.0.0.1:${SITE_PORT_SHEET_PROD}`;

    sheetProdOpenStub = await startSheetStubServer(SHEET_STUB_PROD_OPEN_PORT, {
      adminKey: SHEET_ADMIN,
      contestants: dryRunContestants(SHEET_STUB_PROD_OPEN_PORT),
      localPhotos: true,
    });
    const openWindowConfig = join(BUILDS, 'open-window-config.ts');
    writeFileSync(
      openWindowConfig,
      `export * from ${JSON.stringify(REAL_CONFIG)};
export const votingWindow = { opensAt: ${JSON.stringify(new Date(Date.now() - 3600_000).toISOString())}, closesAt: ${JSON.stringify(new Date(Date.now() + 3600_000).toISOString())}, autoOpen: true };
`,
    );
    const sheetProdOpenDir = join(BUILDS, 'sheet-prod-open');
    await buildSite(
      sheetProdOpenDir,
      {
        VITE_STORAGE_ADAPTER: 'sheet',
        VITE_SHEET_ENDPOINT: `${sheetProdOpenStub.url}/exec`,
        VITE_IP_LOOKUP_URL: `${sheetProdOpenStub.url}/ip`,
      },
      [standInConfigPlugin(openWindowConfig)],
    );
    servers.push(await serve(sheetProdOpenDir, SITE_PORT_SHEET_PROD_OPEN, PAGES_BASE));
    const sheetProdOpenSite = `http://127.0.0.1:${SITE_PORT_SHEET_PROD_OPEN}`;
    await partD(browser, sheetProdSite, sheetProdStub, sheetProdDir, sheetProdOpenSite, sheetProdOpenStub);

    await step('no request left localhost: no trackers, fonts or third parties', async () => {
      const allowed = new Set([
        demoSite, prodSite, kvSite, noKvSite, prodNoKvSite, sheetSite, sheetStub?.url,
        sheetProdSite, sheetProdStub?.url, sheetProdOpenSite, sheetProdOpenStub?.url, api?.url, 'null',
      ]);
      const foreign = [...requestsSeen].filter((origin) => !allowed.has(origin));
      assert.deepEqual(foreign, []);
      assert.equal(
        [...requestsSeen].some((origin) => /google|gstatic/i.test(origin)),
        false,
        'a request went to a Google domain',
      );
      assert.ok(
        [...fontFilesSeen].some((url) => url.includes('poppins-latin-800')),
        'Poppins was not loaded from the site itself',
      );
      assert.equal(
        [...fontFilesSeen].some((url) => /anton|inter-latin/i.test(url)),
        false,
        'Anton or Inter is still being loaded',
      );
    });

    writeFileSync(
      join(OUT, 'first-screen.json'),
      `${JSON.stringify({ unvoted: firstScreens, votedAt390x844: votedScreens }, null, 2)}\n`,
    );
    console.log('\nVoted state at 390 x 844:');
    for (const [label, m] of Object.entries(votedScreens)) {
      console.log(
        `  ${label}: vote message ends at ${m.messageBottomPx}px, promo ${m.promoTopPx}-${m.promoBottomPx}px, ` +
          `grid starts at ${m.gridTopPx}px (${m.gridVisiblePx}px of grid visible)`,
      );
    }
    console.log('\nFirst screen (390 x 844 unless stated):');
    for (const [label, m] of Object.entries(firstScreens)) {
      console.log(
        `  ${label}: grid starts at ${m.gridTopPx}px, ${m.gridVisiblePx}px of grid visible, ` +
          `first row ${m.firstRowVisiblePercent}% visible (card ${m.cardHeightPx}px tall), ` +
          `${m.cardsFullyVisible} cards fully and ${m.cardsPartlyVisible} at least partly visible`,
      );
    }

    console.log(`\n${passed} steps passed. Screenshots: ${OUT}`);
  } finally {
    await browser.close();
    for (const server of servers) {
      await new Promise<void>((resolveClose) => server.httpServer.close(() => resolveClose()));
    }
    await api?.close();
    await sheetStub?.close();
    await sheetProdStub?.close();
    await sheetProdOpenStub?.close();
    rmSync(BUILDS, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error('\nE2E FAILED\n');
    console.error(error);
    process.exit(1);
  },
);
