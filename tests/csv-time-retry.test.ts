import { describe, expect, it, vi } from 'vitest';
import { auditCsv, tallyCsv, toCsv, votesCsv } from '../src/domain/csv';
import { VoteError } from '../src/domain/errors';
import { newRequestId } from '../src/domain/requestId';
import {
  formatCalendarDate,
  formatSgtAxis,
  formatSgtDateTime,
  formatSgtDayMonth,
  formatSgtShort,
  formatSgtStamp,
} from '../src/domain/time';
import type { AdminSnapshot, AuditRow, Contestant, EventState } from '../src/domain/types';
import { isWellFormedRequestId } from '../src/domain/voting';
import { withRetry } from '../src/storage/retry';

const noSleep = { sleep: async (): Promise<void> => undefined, random: () => 0.5 };

describe('withRetry', () => {
  it('retries a dropped connection and then succeeds', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new VoteError('unreachable'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue('counted');
    await expect(withRetry(operation, noSleep)).resolves.toBe('counted');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it.each([
    'voting_closed',
    'voting_not_open',
    'duplicate_vote',
    'invalid_vote',
    'rate_limited',
    'bad_passcode',
    'misconfigured',
  ] as const)('does not retry %s: the server already answered', async (code) => {
    const operation = vi.fn<() => Promise<string>>().mockRejectedValue(new VoteError(code));
    await expect(withRetry(operation, noSleep)).rejects.toMatchObject({ code });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('gives up after the configured attempts with an unreachable error', async () => {
    const operation = vi.fn<() => Promise<string>>().mockRejectedValue(new VoteError('unreachable'));
    await expect(withRetry(operation, { ...noSleep, attempts: 3 })).rejects.toMatchObject({
      code: 'unreachable',
    });
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('backs off exponentially, with jitter, up to the ceiling', async () => {
    const delays: number[] = [];
    const operation = vi.fn<() => Promise<string>>().mockRejectedValue(new VoteError('unreachable'));
    await withRetry(operation, {
      attempts: 5,
      baseDelayMs: 400,
      maxDelayMs: 1000,
      random: () => 1,
      sleep: async (ms) => {
        delays.push(ms);
      },
    }).catch(() => undefined);
    expect(delays).toEqual([400, 800, 1000, 1000]);
  });

  it('reports each retry so the page can say what is happening', async () => {
    const onRetry = vi.fn();
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new VoteError('unreachable'))
      .mockResolvedValue('counted');
    await withRetry(operation, { ...noSleep, onRetry });
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ code: 'unreachable' }), 2);
  });
});

describe('newRequestId', () => {
  it('makes ids the server will accept, and does not repeat itself', () => {
    const ids = Array.from({ length: 200 }, () => newRequestId());
    expect(ids.every((id) => isWellFormedRequestId(id))).toBe(true);
    expect(new Set(ids).size).toBe(200);
  });
});

describe('Singapore time', () => {
  it('formats an instant in SGT whatever zone it was written in', () => {
    expect(formatSgtDateTime('2026-11-03T12:00:00+08:00')).toBe('Tue 3 Nov, 12:00pm SGT');
    expect(formatSgtDateTime('2026-11-03T04:00:00Z')).toBe('Tue 3 Nov, 12:00pm SGT');
    expect(formatSgtDateTime('2026-11-04T23:59:00+08:00')).toBe('Wed 4 Nov, 11:59pm SGT');
  });

  it('rolls over to the next Singapore day when UTC has not yet', () => {
    expect(formatSgtDateTime('2026-11-03T16:30:00Z')).toBe('Wed 4 Nov, 12:30am SGT');
  });

  it('handles midnight, noon and single-digit minutes', () => {
    expect(formatSgtShort('2026-11-08T00:05:00+08:00')).toBe('8 Nov, 12:05am');
    expect(formatSgtDayMonth('2026-11-05T23:59:00+08:00')).toBe('5 Nov');
    expect(formatSgtDayMonth('2026-11-05T16:30:00Z')).toBe('6 Nov');
    expect(formatSgtDayMonth(null)).toBe('');
    expect(formatSgtDayMonth('not a date')).toBe('');
    expect(formatSgtShort('2026-11-08T12:00:00+08:00')).toBe('8 Nov, 12:00pm');
    expect(formatSgtShort('2026-11-08T09:07:00+08:00')).toBe('8 Nov, 9:07am');
  });

  it('keeps chart axis labels short, with the date only where asked', () => {
    expect(formatSgtAxis('2026-11-03T12:00:00+08:00', true)).toBe('3 Nov 12pm');
    expect(formatSgtAxis('2026-11-03T15:00:00+08:00', false)).toBe('3pm');
    expect(formatSgtAxis('2026-11-04T00:00:00+08:00', true)).toBe('4 Nov 12am');
    expect(formatSgtAxis('2026-11-04T09:30:00+08:00', false)).toBe('9:30am');
  });

  it('formats a sortable stamp for spreadsheets', () => {
    expect(formatSgtStamp('2026-11-03T04:00:09Z')).toBe('2026-11-03 12:00:09');
    expect(formatSgtStamp(null)).toBe('');
  });

  it('formats a calendar date without shifting it across a time zone', () => {
    expect(formatCalendarDate('2026-11-05')).toBe('Thu 5 Nov');
    expect(formatCalendarDate('2026-11-10')).toBe('Tue 10 Nov');
  });

  it('gives back something harmless for values it cannot read', () => {
    expect(formatSgtDateTime(null)).toBe('');
    expect(formatSgtDateTime('not a date')).toBe('');
    expect(formatCalendarDate('soon')).toBe('soon');
  });
});

describe('CSV export', () => {
  const contestants: Contestant[] = [
    { id: 'c01', number: 1, stageName: 'Plain Name', photo: null },
    { id: 'c02', number: 2, stageName: 'Comma, "Quoted"', photo: null },
    { id: 'c03', number: 3, stageName: '=HYPERLINK("http://evil.example","click")', photo: null },
    { id: 'c04', number: 4, stageName: 'No Votes', photo: null },
  ];

  const state: EventState = {
    status: 'closed',
    adminStatus: 'pending',
    opensAt: '2026-11-03T12:00:00+08:00',
    closesAt: '2026-11-04T23:59:00+08:00',
    allowVoteChange: true,
    publicCounts: false,
    serverTime: '2026-11-05T00:00:00.000Z',
  };

  const snapshot: AdminSnapshot = {
    state,
    takenAt: '2026-11-05T00:00:00.000Z',
    votes: [
      { id: 1, contestantId: 'c02', castAt: '2026-11-03T04:00:00.000Z', replacedAt: null, voterRef: 'aaaaaaaaaaaa' },
      { id: 2, contestantId: 'c01', castAt: '2026-11-03T04:05:00.000Z', replacedAt: '2026-11-03T05:00:00.000Z', voterRef: 'bbbbbbbbbbbb' },
      { id: 3, contestantId: 'c03', castAt: '2026-11-03T05:00:00.000Z', replacedAt: null, voterRef: 'bbbbbbbbbbbb' },
      { id: 4, contestantId: 'c02', castAt: '2026-11-03T16:30:00.000Z', replacedAt: null, voterRef: 'cccccccccccc' },
    ],
    sharedAddresses: [{ votes: 2, contestants: [{ contestantId: 'c02', votes: 2 }] }],
  };

  it('escapes commas, quotes and line breaks', () => {
    expect(toCsv(['a', 'b'], [['x,y', 'say "hi"'], ['line\nbreak', 3]])).toBe(
      'a,b\r\n"x,y","say ""hi"""\r\n"line\nbreak",3\r\n',
    );
  });

  it('neutralises cells a spreadsheet would run as a formula', () => {
    const csv = toCsv(['name'], [['=1+1'], ['+1'], ['-1'], ['@cmd'], ['safe']]);
    expect(csv).toBe("name\r\n'=1+1\r\n'+1\r\n'-1\r\n'@cmd\r\nsafe\r\n");
  });

  it('writes the tally ranked, with replaced votes left out and the cut marked', () => {
    expect(tallyCsv(snapshot, contestants, 2).split('\r\n')).toEqual([
      'rank,tied,in_top_2_on_votes,contestant_number,contestant_id,stage_name,votes',
      '1,no,yes,2,c02,"Comma, ""Quoted""",2',
      `2,no,yes,3,c03,"'=HYPERLINK(""http://evil.example"",""click"")",1`,
      '3,yes,no,1,c01,Plain Name,0',
      '3,yes,no,4,c04,No Votes,0',
      '',
    ]);
  });

  it('marks a tie at the cut in the tally', () => {
    const lines = tallyCsv(snapshot, contestants, 3).split('\r\n');
    expect(lines[3]).toBe('3,yes,tie at the cut,1,c01,Plain Name,0');
    expect(lines[4]).toBe('3,yes,tie at the cut,4,c04,No Votes,0');
  });

  it('writes one row per vote with Singapore and UTC timestamps', () => {
    expect(votesCsv(snapshot, contestants).split('\r\n')).toEqual([
      'vote_id,cast_at_sgt,cast_at_utc,contestant_number,contestant_id,stage_name,status,replaced_at_sgt,voter_ref',
      '1,2026-11-03 12:00:00,2026-11-03T04:00:00.000Z,2,c02,"Comma, ""Quoted""",counted,,aaaaaaaaaaaa',
      '2,2026-11-03 12:05:00,2026-11-03T04:05:00.000Z,1,c01,Plain Name,replaced,2026-11-03 13:00:00,bbbbbbbbbbbb',
      `3,2026-11-03 13:00:00,2026-11-03T05:00:00.000Z,3,c03,"'=HYPERLINK(""http://evil.example"",""click"")",counted,,bbbbbbbbbbbb`,
      '4,2026-11-04 00:30:00,2026-11-03T16:30:00.000Z,2,c02,"Comma, ""Quoted""",counted,,cccccccccccc',
      '',
    ]);
  });

  it('the publishable exports carry no email or IP address, whatever the snapshot holds', () => {
    const both = `${tallyCsv(snapshot, contestants, 2)}${votesCsv(snapshot, contestants)}`;
    expect(both).not.toMatch(/@|\d+\.\d+\.\d+\.\d+/);
  });

  describe('the CONFIDENTIAL audit export', () => {
    const row = (overrides: Partial<AuditRow>): AuditRow => ({
      voteId: 1,
      contestantId: 'c01',
      castAt: '2026-11-03T04:00:00.000Z',
      replacedAt: null,
      emailTyped: 'Alice.Tan@Example.com',
      emailNormalised: 'alice.tan@example.com',
      ip: '203.0.113.7',
      ipSource: 'platform',
      votesFromIp: 2,
      ...overrides,
    });

    it('has the brief\'s columns, one row per vote, in Singapore time', () => {
      expect(auditCsv([row({}), row({ voteId: 2, replacedAt: '2026-11-03T05:00:00.000Z', ip: '', ipSource: 'not reported', votesFromIp: 0 })], contestants).split('\r\n')).toEqual([
        'vote_id,cast_at_sgt,contestant_number,stage_name,status,email_as_typed,email_normalised,ip_address,ip_source,votes_from_this_ip',
        '1,2026-11-03 12:00:00,1,Plain Name,counted,Alice.Tan@Example.com,alice.tan@example.com,203.0.113.7,platform,2',
        '2,2026-11-03 12:00:00,1,Plain Name,replaced,Alice.Tan@Example.com,alice.tan@example.com,,not reported,0',
        '',
      ]);
    });

    // Every one of these passes the page's email check or could be sent straight
    // to the API, and the file is opened in Excel or Google Sheets.
    it.each([
      ['=1+2@example.com', "'=1+2@example.com"],
      ['+sum@example.com', "'+sum@example.com"],
      ['-2+3@example.com', "'-2+3@example.com"],
      ['@SUM(A1)@example.com', `"'@SUM(A1)@example.com"`.replace(/"/g, '')],
      ['=HYPERLINK("http://evil.example","x")@example.com', `"'=HYPERLINK(""http://evil.example"",""x"")@example.com"`],
      ['\t=1+2@example.com', "'\t=1+2@example.com"],
      ['\r=1+2@example.com', `"'\r=1+2@example.com"`],
      ['a,b@example.com', '"a,b@example.com"'],
      ['line\nbreak@example.com', '"line\nbreak@example.com"'],
      ['o"quote@example.com', '"o""quote@example.com"'],
    ])('neutralises and quotes a hostile email: %j', (typed, cell) => {
      const csv = auditCsv([row({ emailTyped: typed, emailNormalised: typed })], contestants);
      const body = csv.slice(csv.indexOf('\r\n') + 2);
      expect(body.startsWith(`1,2026-11-03 12:00:00,1,Plain Name,counted,${cell},${cell},`)).toBe(true);
    });

    it('neutralises a hostile stage name here too', () => {
      const csv = auditCsv([row({ contestantId: 'c03' })], contestants);
      expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"",""click"")"`);
    });
  });

  it('the vote log adds up to the tally', () => {
    const counted = votesCsv(snapshot, contestants)
      .split('\r\n')
      .filter((line) => line.includes(',counted,')).length;
    const tallied = tallyCsv(snapshot, contestants, 2)
      .trim()
      .split('\r\n')
      .slice(1)
      .reduce((sum, line) => sum + Number(line.slice(line.lastIndexOf(',') + 1)), 0);
    expect(counted).toBe(3);
    expect(tallied).toBe(3);
  });
});
