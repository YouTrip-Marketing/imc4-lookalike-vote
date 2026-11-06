import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
/**
 * Guards on event.config.ts itself: the things the brief fixes, and the things
 * that must stay true however the file is edited.
 */
import { describe, expect, it } from 'vitest';
import { burstRule, contestants, demo, event, keyVisual, promoBanner, promoDetails, sharedAddressRule, votingRules, votingWindow } from '../event.config';
import { buildSeedSql } from '../scripts/generate-seed-sql';
import { formatCalendarDateWithYear } from '../src/domain/time';
import { effectiveStatus } from '../src/domain/voting';

describe('event.config.ts', () => {
  it('has 10 contestants (Revision 13, the Top 10), numbered 1 to 10, with unique ids', () => {
    expect(contestants).toHaveLength(10);
    expect(contestants.map((c) => c.number)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    expect(new Set(contestants.map((c) => c.id)).size).toBe(10);
  });

  it('uses generated placeholders only: no photo of anyone is configured', () => {
    expect(contestants.every((c) => c.photo === null)).toBe(true);
  });

  it('sends 10 through', () => {
    expect(event.advancing).toBe(3);
  });

  it('defaults to no vote changes and counts hidden (one vote per email is fixed, not a setting)', () => {
    expect(votingRules).toEqual({ allowVoteChange: false, publicCounts: false });
  });

  it('has the legal gate cleared (Legal, IMC 4 Overview tab, 26 Oct 2026)', () => {
    expect(event.legalReviewPending).toBe(false);
  });

  it('has a voting window written in Singapore time that opens before it closes', () => {
    expect(votingWindow.opensAt).toMatch(/\+08:00$/);
    expect(votingWindow.closesAt).toMatch(/\+08:00$/);
    expect(Date.parse(votingWindow.opensAt ?? '')).toBeLessThan(Date.parse(votingWindow.closesAt ?? ''));
    expect(() => effectiveStatus('pending', votingWindow, new Date())).not.toThrow();
  });

  it('announces the Top 10 on a real calendar date', () => {
    expect(event.top10AnnouncedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(event.top10AnnouncedOn))).toBe(false);
  });

  it('has a burst rule that can flag something', () => {
    expect(burstRule.votes).toBeGreaterThanOrEqual(2);
    expect(burstRule.windowMinutes).toBeGreaterThan(0);
  });

  it('invents nothing for the placeholders: no taglines or handles', () => {
    expect(contestants.every((c) => c.tagline === undefined && c.handle === undefined)).toBe(true);
  });

  describe('key visual (Revision 8: Kelicia\'s "Top 20" creative, 2026-10-05)', () => {
    const publicFile = (path: string | null | undefined): string => resolve(import.meta.dirname, '..', 'public', path ?? '');
    /**
     * Width and height from a lossy WebP's VP8 frame header, so the test needs no
     * image library. The 26 Oct 2026 revision is quality-90 WebP (250 KB spec).
     */
    const webpSize = (path: string): { width: number; height: number } => {
      const bytes = readFileSync(path);
      expect(bytes.subarray(0, 4).toString('latin1')).toBe('RIFF');
      expect(bytes.subarray(8, 16).toString('latin1')).toBe('WEBPVP8 ');
      expect([...bytes.subarray(23, 26)]).toEqual([0x9d, 0x01, 0x2a]);
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    };

    it('points at the supplied phone (16:9) and desktop (3:1) files, under the project naming convention', () => {
      expect(keyVisual.mobile).toBe('key-visual/imc4-lookalike-kv-r3-1080x608.webp');
      expect(keyVisual.desktop).toBe('key-visual/imc4-lookalike-kv-r3-1920x640.webp');
      expect(existsSync(publicFile(keyVisual.mobile))).toBe(true);
      expect(existsSync(publicFile(keyVisual.desktop))).toBe(true);
    });

    it('uses files of the sizes the slot is built for: 1080 x 608 on phones, 1920 x 640 on desktop', () => {
      expect(webpSize(publicFile(keyVisual.mobile))).toEqual({ width: 1080, height: 608 });
      expect(webpSize(publicFile(keyVisual.desktop))).toEqual({ width: 1920, height: 640 });
    });

    it('keeps both files under the 250 KB spec', () => {
      expect(statSync(publicFile(keyVisual.mobile)).size).toBeLessThanOrEqual(250 * 1024);
      expect(statSync(publicFile(keyVisual.desktop)).size).toBeLessThanOrEqual(250 * 1024);
    });

    it('has the agreed alt text', () => {
      expect(keyVisual.alt).toBe('Top 10 K-pop idol lookalikes. YouTrip, best rates all day. T&Cs apply.');
    });

    it('never names the artist in the alt text (naming rule, until legal clears)', () => {
      expect(keyVisual.alt).not.toMatch(/jung\s*-?\s*kook|j\s*-?\s*kook|jeon|\bJK\b|bts|bangtan/i);
      expect(keyVisual.alt.toLowerCase()).not.toContain(event.title.split(' ')[0]?.toLowerCase() ?? '');
    });
  });

  it('has a shared-address flag threshold that can flag something', () => {
    expect(sharedAddressRule.votes).toBeGreaterThanOrEqual(2);
  });

  it('Revision 12: voting closes Thu 12 Nov 2026 23:59 SGT, and the winner line reads Thu 12 Nov 2026', () => {
    expect(votingWindow.closesAt).toBe('2026-11-12T23:59:00+08:00');
    expect(event.winnerAnnouncedOn).toBe('2026-11-12');
    expect(formatCalendarDateWithYear(event.winnerAnnouncedOn)).toBe('Thu 12 Nov 2026');
    expect(formatCalendarDateWithYear('not a date')).toBe('not a date');
  });

  it('Revision 12: Code.gs closes at the same instant as the page', () => {
    const codeGs = readFileSync(resolve(import.meta.dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
    expect(codeGs).toContain(`var CLOSES_AT = '${votingWindow.closesAt}';`);
  });

  it('words the post-vote "Your vote is in" panel with the CS promo brief facts only (Revision 11)', () => {
    expect(promoDetails).toEqual({
      heading: 'Your vote is in',
      headingWithName: 'Your vote for {name} is in',
      lines: [
        '100 Flights to Korea: 28 Oct to 31 Dec 2026.',
        'New to YouTrip? Sign up with promo code FLY100KR.',
        'Already on YouTrip? Tap "Join now" on the 100 Flights banner in the app, then spend S$500 within the campaign period.',
        'Winners drawn 31 Jan 2027. T&Cs apply.',
      ],
      cta: 'Join the 100 Flights promo',
    });
    // Revision 13d: "JKook" is allowed in page copy; the artist's full name is not.
    expect(JSON.stringify(promoDetails)).not.toMatch(/jung ?kook/i);
  });

  it('points the promo banner at the supplied creatives (3:1 and 16:9 phone), with the agreed alt text and the YouTrip OneLink', () => {
    expect(promoBanner).toEqual({
      image: 'promo/imc4-100-flights-korea-banner-1920x640.jpg',
      phoneImage: 'promo/imc4-100-flights-korea-banner-1080x608.jpg',
      alt: '100 free flights to Korea. Sign up for YouTrip with FLY100KR, 28 Oct to 31 Dec. T&Cs apply.',
      href: 'https://youtrip.onelink.me/P5AL/voting-site',
    });
    expect(existsSync(resolve(import.meta.dirname, '..', 'public', promoBanner.image ?? ''))).toBe(true);
    expect(existsSync(resolve(import.meta.dirname, '..', 'public', promoBanner.phoneImage ?? ''))).toBe(true);
  });

  it('keeps a demo passcode for the local adapter only', () => {
    expect(demo.passcode.length).toBeGreaterThan(0);
  });
});

describe('voter-facing copy', () => {
  const copy = [event.title, event.openHeading, event.openLede].join(' ');

  it('carries no purpose line for the email (removed 2026-09-29; the T&Cs hold any purpose statement)', () => {
    const config = JSON.stringify(event);
    expect(event).not.toHaveProperty('emailPurposeNote');
    expect(config).not.toMatch(/We use your email/i);
    expect(config).not.toMatch(/make sure each person/i);
  });

  it('Revision 13d: carries Kelicia\'s heading and lede verbatim', () => {
    expect(event.openHeading).toBe('Who’s the ultimate JKook lookalike?');
    expect(event.openLede).toBe(
      'We’re celebrating 100 Free Flights to Korea with a search for the ultimate JKook lookalike, and you get to decide who takes the crown! Cast your vote before 12 Nov and tune in to our Instagram livestream @youtripsg that day for the winner reveal.',
    );
  });

  // Revision 13d: the lede names the 100 Free Flights to Korea campaign on purpose,
  // and the vote does decide the winner, so "flights", "Korea" and "winner" are allowed.
  it.each([/\bcash\b/i, /\bS\$\s?\d/, /\bprize/i, /\bdraw\b/i])(
    'makes no promise about %s',
    (pattern) => {
      expect(copy).not.toMatch(pattern);
    },
  );

  it('no longer carries the two paragraphs Kelicia removed on 2026-09-29', () => {
    const config = JSON.stringify(event);
    expect(config).not.toMatch(/network address/i);
    expect(config).not.toMatch(/IP address/);
    expect(config).not.toMatch(/Your vote helps decide/);
    expect(config).not.toMatch(/eligibility check/);
  });
});

describe('seed SQL', () => {
  const sql = buildSeedSql();

  it('carries every contestant and the rules', () => {
    for (const contestant of contestants) expect(sql).toContain(`'${contestant.id}'`);
    expect(sql).not.toContain('max_votes_per_network');
    expect(sql).toContain('allow_vote_change     = false');
    expect(sql).toContain('public_counts         = false');
  });

  it('carries the window with its time zone', () => {
    expect(sql).toContain(`'${votingWindow.opensAt}'::timestamptz`);
    expect(sql).toContain(`'${votingWindow.closesAt}'::timestamptz`);
  });

  it('contains no secrets and touches no votes', () => {
    // Comments explain what the file leaves alone; only the statements are checked.
    const statements = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(statements).not.toMatch(/passcode|secret/i);
    expect(statements).not.toContain(demo.passcode);
    expect(statements).not.toMatch(/\b(delete|truncate|drop)\b/i);
    expect(statements).not.toMatch(/public\.votes/);
  });
});
