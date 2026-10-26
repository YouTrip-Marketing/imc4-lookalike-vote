import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalEmail, checkEmail } from '../src/domain/email';
import { codeGsConstant, loadAppsScript } from '../scripts/apps-script-harness';
import { votingWindow } from '../event.config';

const ADMIN = 'unit-test-admin-passcode-0123';

/** Inputs the site's own email tests cover, plus edge cases for the copy in Code.gs. */
const EMAILS = [
  'jane.doe@gmail.com',
  'JaneDoe+vote2@Gmail.com',
  'j.a.n.e.d.o.e@googlemail.com',
  '+tag@gmail.com',
  '.jane@gmail.com',
  'jane..doe@example.com',
  '  alice.tan@example.com  ',
  'alice+news@example.com',
  'a.b@example.co.uk',
  'user@sub-domain.example.org',
  'user@-bad.example.com',
  'user@example.c',
  'user@example.123',
  'no-at-sign.example.com',
  'two@@example.com',
  'with space@example.com',
  'quote"@example.com',
  'ünïcode@exämple.com',
  '-leading.dash@example.com',
  '=formula@example.com',
  `${'x'.repeat(65)}@example.com`,
  `x@${'d'.repeat(250)}.com`,
  '',
];

const vote = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    contestantNumber: 7,
    contestantName: 'Contestant 7',
    email: 'test+1@example.com',
    voteId: 'vote-0001-aaaa',
    device: 'iPhone · Instagram',
    ip: '203.0.113.5',
    ...overrides,
  });

describe('Code.gs uses the same email rule as the site', () => {
  const script = loadAppsScript();
  it.each(EMAILS)('agrees on %j', (email) => {
    expect(script.call('canonicalEmail', email)).toBe(canonicalEmail(email));
    expect(JSON.parse(JSON.stringify(script.call('checkEmail', email)))).toEqual(checkEmail(email));
  });
});

describe('Code.gs doPost', () => {
  it('appends one row per vote, with the header on a new Votes tab', () => {
    const script = loadAppsScript({ now: () => new Date('2026-10-13T06:30:00Z') });
    const answer = script.doPost(vote());
    expect(answer.json).toEqual({
      ok: true,
      data: { duplicate: false, castAt: '2026-10-13T06:30:00.000Z', row: 2 },
    });
    const sheet = script.votes();
    expect(sheet?.frozenRows).toBe(1);
    expect(sheet?.rows).toEqual([
      [
        'Timestamp (SGT)', 'Email (as typed)', 'Canonical email', 'IP (self-reported)', 'Contestant no.',
        'Contestant name', 'Vote ID', 'User agent (short)', 'Duplicate?', 'Organiser test?',
      ],
      [
        '2026-10-13 14:30:00', 'test+1@example.com', 'test+1@example.com', '203.0.113.5', 7,
        'Contestant 7', 'vote-0001-aaaa', 'iPhone · Instagram', false, false,
      ],
    ]);
  });

  it('refuses a second vote from the same Gmail inbox spelled differently, and logs it as Duplicate? TRUE', () => {
    const script = loadAppsScript();
    script.doPost(vote({ email: 'jane.doe@gmail.com', voteId: 'vote-0001-aaaa' }));
    const again = script.doPost(vote({ email: 'JaneDoe+again@googlemail.com', voteId: 'vote-0002-bbbb', contestantNumber: 3 }));
    expect(again.json).toEqual({ ok: true, data: { duplicate: true } });
    const rows = script.votes()?.rows ?? [];
    expect(rows).toHaveLength(3);
    expect(rows[2]?.slice(1, 5)).toEqual(['JaneDoe+again@googlemail.com', 'janedoe@gmail.com', '203.0.113.5', 3]);
    expect(rows[2]?.[8]).toBe(true);
    expect(rows[1]?.[8]).toBe(false);
  });

  it('answers a retried vote id with the first answer and adds no row, for counted and refused attempts', () => {
    const script = loadAppsScript({ now: () => new Date('2026-10-13T06:30:00Z') });
    const first = script.doPost(vote());
    expect(script.doPost(vote()).json).toEqual(first.json);
    const refused = script.doPost(vote({ voteId: 'vote-0002-bbbb' }));
    expect(script.doPost(vote({ voteId: 'vote-0002-bbbb' })).json).toEqual(refused.json);
    expect(script.votes()?.rows).toHaveLength(3);
  });

  it('keeps a well-formed IP, and writes "unavailable" for anything else. Never refuses on IP', () => {
    const script = loadAppsScript();
    const ips = ['2001:db8::1', 'unavailable', '=1+1', '', 42, 'not an ip', '1234'];
    ips.forEach((ip, index) => {
      const answer = script.doPost(vote({ ip, email: `v${index}@example.com`, voteId: `vote-000${index}-ipip` }));
      expect((answer.json as { data: { duplicate: boolean } }).data.duplicate).toBe(false);
    });
    expect(script.votes()?.rows.slice(1).map((row) => row[3])).toEqual([
      '2001:db8::1', 'unavailable', 'unavailable', 'unavailable', 'unavailable', 'unavailable', 'unavailable',
    ]);
    // The same IP from two emails: both counted.
    script.doPost(vote({ email: 'same-wifi-1@example.com', voteId: 'vote-1001-wifi' }));
    script.doPost(vote({ email: 'same-wifi-2@example.com', voteId: 'vote-1002-wifi' }));
    expect(script.votes()?.rows.slice(-2).map((row) => row[8])).toEqual([false, false]);
  });

  it('refuses to write when pasted into a different spreadsheet', () => {
    const script = loadAppsScript({ sheetId: 'some-other-sheet' });
    expect(script.doPost(vote()).json).toEqual({ ok: false, error: 'misconfigured' });
    expect(script.doGet().json).toEqual({ ok: false, error: 'bad_passcode' });
    expect(script.votes()).toBeUndefined();
  });

  it('never writes a typed value as a formula', () => {
    const script = loadAppsScript();
    script.doPost(vote({ email: '=hack@example.com', contestantName: '=IMPORTXML("x")', device: '+1' }));
    const sheet = script.votes();
    expect(sheet?.formulas).toEqual([]);
    expect(sheet?.rows[1]?.[1]).toBe('=hack@example.com');
    // The duplicate check still sees the address through the apostrophe.
    expect(script.doPost(vote({ email: '=HACK@example.com', voteId: 'vote-0002-bbbb' })).json).toEqual({
      ok: true,
      data: { duplicate: true },
    });
  });

  it.each([
    ['not JSON', '{oops'],
    ['contestant 0', vote({ contestantNumber: 0 })],
    ['contestant 21', vote({ contestantNumber: 21 })],
    ['contestant "7"', vote({ contestantNumber: '7' })],
    ['short vote id', vote({ voteId: 'abc' })],
    ['vote id with spaces', vote({ voteId: 'vote 0001 aaaa' })],
  ])('refuses %s as invalid_vote', (_label, body) => {
    const script = loadAppsScript();
    expect(script.doPost(body).json).toEqual({ ok: false, error: 'invalid_vote' });
    expect(script.votes()).toBeUndefined();
  });

  it('refuses a malformed email', () => {
    const script = loadAppsScript();
    expect(script.doPost(vote({ email: 'nope' })).json).toEqual({ ok: false, error: 'invalid_email' });
  });

  it('answers busy when another vote holds the lock, and releases its own lock', () => {
    const script = loadAppsScript();
    script.holdLock(true);
    expect(script.doPost(vote()).json).toEqual({ ok: false, error: 'busy' });
    script.holdLock(false);
    expect((script.doPost(vote()).json as { ok: boolean }).ok).toBe(true);
    expect((script.doPost(vote({ email: 'b@example.com', voteId: 'vote-0002-bbbb' })).json as { ok: boolean }).ok).toBe(true);
  });
});

describe('Code.gs doGet', () => {
  it('lists counted votes without any email or IP, leaving refused repeats out', () => {
    const script = loadAppsScript({ now: () => new Date('2026-10-13T06:30:00Z'), adminKey: ADMIN });
    script.doPost(vote({ email: 'alice@example.com', voteId: 'vote-0001-aaaa' }));
    script.doPost(vote({ email: 'alice@example.com', voteId: 'vote-0009-dupe', contestantNumber: 5 }));
    script.doPost(vote({ email: 'bob@example.com', voteId: 'vote-0002-bbbb', contestantNumber: 12 }));
    const answer = script.doGet(ADMIN).json as { ok: boolean; data: { votes: Record<string, unknown>[] } };
    expect(answer.ok).toBe(true);
    expect(answer.data.votes.map(({ n, no, at }) => ({ n, no, at }))).toEqual([
      { n: 1, no: 7, at: '2026-10-13T06:30:00.000Z' },
      // n follows the sheet's rows, so the refused repeat in between leaves a gap.
      { n: 3, no: 12, at: '2026-10-13T06:30:00.000Z' },
    ]);
    for (const row of answer.data.votes) expect(row.ref).toMatch(/^[0-9a-f]{8}$/);
    expect(answer.data.votes[0]?.ref).not.toBe(answer.data.votes[1]?.ref);
    expect(JSON.stringify(answer)).not.toMatch(/@|203\.0\.113/);
  });

  it('answers an empty list before the first vote', () => {
    const script = loadAppsScript({ adminKey: ADMIN });
    expect((script.doGet(ADMIN).json as { data: { votes: unknown[] } }).data.votes).toEqual([]);
  });
});

describe('Code.gs production rules (26 Oct 2026)', () => {
  it('writes only to the production "Voting site" spreadsheet', () => {
    expect(codeGsConstant('SHEET_ID')).toBe('1ir3Umrw3Xq_ImhOA08Qcdj4aXD06LRuJSoDvCFLMqKI');
  });

  it('has the same voting window as event.config.ts', () => {
    expect(Date.parse(codeGsConstant('OPENS_AT'))).toBe(Date.parse(votingWindow.opensAt ?? ''));
    expect(Date.parse(codeGsConstant('CLOSES_AT'))).toBe(Date.parse(votingWindow.closesAt ?? ''));
  });

  it('holds a real admin passcode hash, not the demo one', () => {
    const hash = codeGsConstant('ADMIN_KEY_SHA256');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(createHash('sha256').update('demo-admin').digest('hex'));
  });

  const window = { opensAt: '2026-11-02T12:00:00+08:00', closesAt: '2026-11-05T23:59:00+08:00' };
  it.each([
    ['2026-11-02T11:59:59+08:00', { ok: false, error: 'voting_not_open' }],
    ['2026-11-05T23:59:00+08:00', { ok: false, error: 'voting_closed' }],
  ])('refuses a vote at %s, and writes nothing', (at, expected) => {
    const script = loadAppsScript({ now: () => new Date(at), window, adminKey: ADMIN });
    expect(script.doPost(vote()).json).toEqual(expected);
    expect(script.votes()).toBeUndefined();
  });

  it('counts a vote at the opening minute and the last second', () => {
    for (const at of ['2026-11-02T12:00:00+08:00', '2026-11-05T23:58:59+08:00']) {
      const script = loadAppsScript({ now: () => new Date(at), window });
      expect((script.doPost(vote()).json as { ok: boolean }).ok).toBe(true);
    }
  });

  it('accepts an organiser test vote outside the window only with the admin passcode', () => {
    const early = () => loadAppsScript({ now: () => new Date('2026-10-26T10:00:00+08:00'), window, adminKey: ADMIN });
    expect(early().doPost(vote({ adminKey: 'wrong' })).json).toEqual({ ok: false, error: 'voting_not_open' });
    expect(early().doPost(vote({ adminKey: 'demo-admin' })).json).toEqual({ ok: false, error: 'voting_not_open' });
    expect((early().doPost(vote({ adminKey: ADMIN })).json as { ok: boolean }).ok).toBe(true);
  });

  it('keeps the tally behind the admin passcode', () => {
    const script = loadAppsScript({ adminKey: ADMIN });
    for (const key of [undefined, '', 'wrong', 'demo-admin']) {
      expect(script.doGet(key).json).toEqual({ ok: false, error: 'bad_passcode' });
    }
    expect((script.doGet(ADMIN).json as { ok: boolean }).ok).toBe(true);
  });
});

describe('Code.gs Contestants tab (runtime Top 20, 26 Oct 2026)', () => {
  const window = { opensAt: '2026-11-02T12:00:00+08:00', closesAt: '2026-11-05T23:59:00+08:00' };
  const DRIVE_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
  const rows: (string | number)[][] = [
    [1, '  Kim  Lookalike ', 'kim.lookalike', 'Jurong West', `https://drive.google.com/file/d/${DRIVE_ID}/view?usp=sharing`],
    [2, 'Ahmad', '@ahmad_sg', '', `https://drive.google.com/open?id=${DRIVE_ID}`],
    [3, 'Bad bits', 'not a handle!', 'x'.repeat(80), 'javascript:alert(1)'],
    [3, 'Second row for 3 is ignored', '', '', ''],
    [21, 'Out of range', '', '', ''],
    ['', '', '', '', ''],
    [4, 'Direct', '', '', 'https://example.com/photos/04.jpg'],
  ];
  const at = (iso: string) => loadAppsScript({ now: () => new Date(iso), window, adminKey: ADMIN, contestants: rows });
  const list = (json: unknown) => (json as { data: { revealed: boolean; contestants: Record<string, unknown>[] } }).data;

  it('answers an empty list before the reveal, even with the tab filled in', () => {
    expect(list(at('2026-11-02T11:59:59+08:00').doGet(undefined, 'contestants').json)).toEqual({ revealed: false, contestants: [] });
    expect(list(at('2026-11-02T11:59:59+08:00').doGet('wrong', 'contestants').json).contestants).toEqual([]);
  });

  it('lets the organisers preview it early with the passcode', () => {
    const early = list(at('2026-11-01T20:00:00+08:00').doGet(ADMIN, 'contestants').json);
    expect(early.revealed).toBe(false);
    expect(early.contestants).toHaveLength(4);
  });

  it('from the reveal: cleaned rows, Drive links turned into resized image addresses, bad values dropped', () => {
    const after = list(at('2026-11-02T12:00:00+08:00').doGet(undefined, 'contestants').json);
    expect(after.revealed).toBe(true);
    expect(after.contestants).toEqual([
      { no: 1, name: 'Kim Lookalike', handle: '@kim.lookalike', tagline: 'Jurong West', photo: `https://lh3.googleusercontent.com/d/${DRIVE_ID}=w960` },
      { no: 2, name: 'Ahmad', handle: '@ahmad_sg', tagline: '', photo: `https://lh3.googleusercontent.com/d/${DRIVE_ID}=w960` },
      { no: 3, name: 'Bad bits', handle: '', tagline: 'x'.repeat(40), photo: '' },
      { no: 4, name: 'Direct', handle: '', tagline: '', photo: 'https://example.com/photos/04.jpg' },
    ]);
  });

  it('holds no voter data and needs no passcode after the reveal', () => {
    const script = at('2026-11-03T09:00:00+08:00');
    script.doPost(vote({ email: 'someone@example.com' }));
    expect(JSON.stringify(script.doGet(undefined, 'contestants').json)).not.toMatch(/@example\.com|203\.0\.113/);
  });

  it('caches the list for a minute; the passcode preview always reads the tab fresh', () => {
    const script = at('2026-11-02T12:30:00+08:00');
    expect(list(script.doGet(undefined, 'contestants').json).contestants[0]?.name).toBe('Kim Lookalike');
    const tab = script.tab('Contestants');
    if (tab?.rows[1] !== undefined) tab.rows[1][1] = 'Renamed';
    expect(list(script.doGet(undefined, 'contestants').json).contestants[0]?.name).toBe('Kim Lookalike');
    expect(list(script.doGet(ADMIN, 'contestants').json).contestants[0]?.name).toBe('Renamed');
    script.clearCache();
    expect(list(script.doGet(undefined, 'contestants').json).contestants[0]?.name).toBe('Renamed');
  });

  it('answers an empty list when there is no Contestants tab', () => {
    const script = loadAppsScript({ now: () => new Date('2026-11-03T09:00:00+08:00'), window });
    expect(list(script.doGet(undefined, 'contestants').json)).toEqual({ revealed: true, contestants: [] });
  });
});

describe('Code.gs organiser test votes (26 Oct 2026)', () => {
  const window = { opensAt: '2026-11-02T12:00:00+08:00', closesAt: '2026-11-05T23:59:00+08:00' };
  const today = () => loadAppsScript({ now: () => new Date('2026-10-26T15:00:00+08:00'), window, adminKey: ADMIN });
  const ok = (json: unknown) => json as { ok: boolean; data?: { duplicate: boolean }; error?: string };

  it('accepts a passcode vote before the window and marks its row Organiser test? = TRUE', () => {
    const script = today();
    expect(ok(script.doPost(vote({ adminKey: ADMIN })).json).data?.duplicate).toBe(false);
    const row = script.votes()?.rows[1];
    expect([row?.[8], row?.[9]]).toEqual([false, true]);
  });

  it('refuses the same vote without the passcode, and with a wrong or demo one', () => {
    for (const adminKey of [undefined, 'wrong', 'demo-admin']) {
      expect(ok(today().doPost(vote({ adminKey })).json).error).toBe('voting_not_open');
    }
  });

  it('keeps test rows out of the tally', () => {
    const script = loadAppsScript({ now: () => new Date('2026-11-03T09:00:00+08:00'), window, adminKey: ADMIN });
    script.doPost(vote({ email: 'real@example.com', voteId: 'vote-0001-real', contestantNumber: 3 }));
    script.doPost(vote({ email: 'test@example.com', voteId: 'vote-0002-test', contestantNumber: 7, adminKey: ADMIN }));
    const votes = (script.doGet(ADMIN).json as { data: { votes: { no: number }[] } }).data.votes;
    expect(votes.map((v) => v.no)).toEqual([3]);
  });

  it("a test vote never blocks that email's real vote; tests repeat-check among tests only", () => {
    const script = loadAppsScript({ now: () => new Date('2026-11-03T09:00:00+08:00'), window, adminKey: ADMIN });
    expect(ok(script.doPost(vote({ email: 'kel@example.com', voteId: 'vote-0001-test', adminKey: ADMIN })).json).data?.duplicate).toBe(false);
    expect(ok(script.doPost(vote({ email: 'kel@example.com', voteId: 'vote-0002-test', adminKey: ADMIN })).json).data?.duplicate).toBe(true);
    expect(ok(script.doPost(vote({ email: 'kel@example.com', voteId: 'vote-0003-real' })).json).data?.duplicate).toBe(false);
    expect(ok(script.doPost(vote({ email: 'kel@example.com', voteId: 'vote-0004-real' })).json).data?.duplicate).toBe(true);
    expect(script.votes()?.rows.slice(1).map((r) => [r[8], r[9]])).toEqual([
      [false, true],
      [true, true],
      [false, false],
      [true, false],
    ]);
  });
});
