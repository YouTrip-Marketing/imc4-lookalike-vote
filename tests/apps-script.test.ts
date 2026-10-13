import { describe, expect, it } from 'vitest';
import { canonicalEmail, checkEmail } from '../src/domain/email';
import { loadAppsScript } from '../scripts/apps-script-harness';

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
      ['Time (SGT)', 'No.', 'Contestant', 'Email (as typed)', 'Email (counted as)', 'Device', 'Vote ID'],
      ['2026-10-13 14:30:00', 7, 'Contestant 7', 'test+1@example.com', 'test+1@example.com', 'iPhone · Instagram', 'vote-0001-aaaa'],
    ]);
  });

  it('refuses a second vote from the same Gmail inbox spelled differently', () => {
    const script = loadAppsScript();
    script.doPost(vote({ email: 'jane.doe@gmail.com', voteId: 'vote-0001-aaaa' }));
    const again = script.doPost(vote({ email: 'JaneDoe+again@googlemail.com', voteId: 'vote-0002-bbbb', contestantNumber: 3 }));
    expect(again.json).toEqual({ ok: true, data: { duplicate: true } });
    expect(script.votes()?.rows).toHaveLength(2);
  });

  it('answers a retried vote id with the first answer and adds no row', () => {
    const script = loadAppsScript({ now: () => new Date('2026-10-13T06:30:00Z') });
    const first = script.doPost(vote());
    const retry = script.doPost(vote());
    expect(retry.json).toEqual(first.json);
    expect(script.votes()?.rows).toHaveLength(2);
  });

  it('never writes a typed value as a formula', () => {
    const script = loadAppsScript();
    script.doPost(vote({ email: '=hack@example.com', contestantName: '=IMPORTXML("x")', device: '+1' }));
    const sheet = script.votes();
    expect(sheet?.formulas).toEqual([]);
    expect(sheet?.rows[1]?.[3]).toBe('=hack@example.com');
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
  it('lists votes without any email', () => {
    const script = loadAppsScript({ now: () => new Date('2026-10-13T06:30:00Z') });
    script.doPost(vote({ email: 'alice@example.com', voteId: 'vote-0001-aaaa' }));
    script.doPost(vote({ email: 'bob@example.com', voteId: 'vote-0002-bbbb', contestantNumber: 12 }));
    const answer = script.doGet().json as { ok: boolean; data: { votes: Record<string, unknown>[] } };
    expect(answer.ok).toBe(true);
    expect(answer.data.votes.map(({ n, no, at }) => ({ n, no, at }))).toEqual([
      { n: 1, no: 7, at: '2026-10-13T06:30:00.000Z' },
      { n: 2, no: 12, at: '2026-10-13T06:30:00.000Z' },
    ]);
    for (const row of answer.data.votes) expect(row.ref).toMatch(/^[0-9a-f]{8}$/);
    expect(answer.data.votes[0]?.ref).not.toBe(answer.data.votes[1]?.ref);
    expect(JSON.stringify(answer)).not.toMatch(/@/);
  });

  it('answers an empty list before the first vote', () => {
    const script = loadAppsScript();
    expect((script.doGet().json as { data: { votes: unknown[] } }).data.votes).toEqual([]);
  });
});
