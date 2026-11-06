/**
 * THE config file. Everything an organiser needs to change lives here.
 *
 *   event         - title and the copy that frames the vote
 *   keyVisual     - the banner image at the top of the voting page
 *   promoBanner   - the campaign promo banner (in the post-vote panel; also at
 *                   the bottom once voted or not open)
 *   promoDetails  - the words in the post-vote "Your vote is in" panel
 *   contestants   - the 10 in the vote (Revision 13: the Top 10; was the Top 20)
 *   votingWindow  - when voting opens and closes (Singapore time)
 *   votingRules   - whether a vote can be changed, public counts
 *   burstRule     - when the admin view flags a run of votes
 *   sharedAddressRule - when the admin view flags many votes from one IP address
 *   demo          - admin passcode for the local DEMO adapter only
 *
 * One vote per email address. That rule is fixed, not a setting.
 *
 * The production admin passcode and the hashing secret are deliberately NOT in
 * this file: anything here ships in the public bundle. They are environment
 * variables on the server function. See README.
 *
 * After changing contestants, votingWindow or votingRules for a production
 * deployment, run `npm run seed:sql` and apply the output to the database:
 * the server enforces what the database holds, not what the page says.
 */
import type {
  BurstRule,
  Contestant,
  EventInfo,
  KeyVisual,
  PromoBanner,
  PromoDetails,
  SharedAddressRule,
  VotingRules,
  VotingWindow,
} from './src/domain/types';

export const event: EventInfo = {
  // Revision 13: new id for the Top 10 round, so every phone forgets its
  // Top 20 "I voted" note (the id keys the browser's vote marker, nothing else).
  id: 'imc4-top10-vote',

  // The only place the event title is written: the browser tab ("Vote | ...")
  // and the admin brand line follow. 6 Nov 2026 (Kelicia approved): "JKook
  // Lookalike", the name Legal cleared. Never the artist's full name.
  title: 'JKook Lookalike',

  organiser: 'YouTrip',
  // Revision 13 ASSUMPTION (Chief of Staff, 6 Nov 2026; Terry calls the next
  // round "the final-3 vote"; Kelicia has not confirmed): the heading reads
  // "Who makes the final 3?". Change this one number if the round differs.
  advancing: 3,

  // Sat 7 Nov 2026: Top 10 reveal, set 2026-10-13 with the confirmed 2 to 5 Nov
  // voting window (was 5 Nov, the PR brief's date, which is now close day).
  top10AnnouncedOn: '2026-11-07',

  // Revision 12 (Kelicia, 5 Nov 2026): the line shown after a vote is now the
  // winner announcement, "The winner will be announced on Thu 12 Nov 2026."
  winnerAnnouncedOn: '2026-11-12',

  // PAGE COPY RULE (Kelicia, 2026-09-29): the page does not explain or justify
  // why it asks for things. No purpose lines, privacy explanations or
  // reassurance copy. If legal needs a purpose statement for the email, it goes
  // in the T&Cs, not on the page.

  // Set to false once legal has cleared the event title AND T&Cs that cover
  // collecting and keeping each voter's email address and IP address for the
  // confidential audit export (Revision 5). Until then `npm run deploy` refuses
  // to publish. Nothing on the page shows this.
  // CLEARED 2026-10-26: the IMC 4 sheet's Overview tab records Legal's update,
  // "Ok to proceed with Jkook Lookalike as the overall name on marketing assets".
  legalReviewPending: false,

  // Revision 13d (Kelicia, 6 Nov 2026), verbatim: what a visitor sees while
  // voting is open and they have not voted. The rule line stays under it.
  openHeading: 'Who’s the ultimate JKook lookalike?',
  openLede:
    'We’re celebrating 100 Free Flights to Korea with a search for the ultimate JKook lookalike, and you get to decide who takes the crown! Cast your vote by 12 Nov and tune in to our Instagram livestream @youtripsg that day for the winner reveal.',

  // COPY GUARDRAIL, revised 6 Nov 2026 (Revision 13d): the public vote DOES
  // decide the winner ("you get to decide who takes the crown"), so the page may
  // say so, and the post-vote line "The winner will be announced on ..." stands.
  // Still never promise cash, a prize draw or a cash value for voting, and never
  // the artist's full name in alt text. tests/config.test.ts checks both.
};

/**
 * KEY VISUAL: the banner at the very top of the voting page.
 *
 * Revision 3 (5 Nov 2026): Kelicia's "Top 10" key visual for the final round,
 * re-encoded from her PNGs to quality-90 WebP (250 KB spec), in public/key-visual/.
 * Background edges match revision 2 within 3/255, so the band stops are unchanged.
 * (Earlier: "Top 20" KV, 2026-10-05; r2 pill "best rates all day", 2026-10-29.)
 *   mobile:  16:9 (1080 x 608), used below 900px wide
 *   desktop: 3:1 (1920 x 640), used from 900px wide
 * The page background around the banner is matched to these two images
 * (src/styles/app.css, "key visual band"). A new creative with a different
 * background needs those colour stops re-sampled.
 * Sizes, file format and the size limit: developer/outbox/imc4-voting-site-key-visual-spec.md
 *
 * The alt text must not name the artist (naming rule, until legal clears).
 *
 * If mobile is set back to null: the demo build shows a marked placeholder in
 * the slot; a production build shows nothing, and `npm run check:deploy` warns.
 */
export const keyVisual: KeyVisual = {
  mobile: 'key-visual/imc4-lookalike-kv-r3-1080x608.webp',
  desktop: 'key-visual/imc4-lookalike-kv-r3-1920x640.webp',
  alt: 'Top 10 K-pop idol lookalikes. YouTrip, best rates all day. T&Cs apply.',
};

/**
 * PROMO BANNER: the "100 Free Flights to Korea" campaign (IMC 4, code FLY100KR,
 * 28 Oct to 31 Dec). Creative supplied by Kelicia, 2026-09-30, in public/promo/.
 *
 *   image       3:1 (1920 x 640), used at every width unless phoneImage is set
 *   phoneImage  16:9 (1080 x 608, under 250 KB), used below 640px wide, where
 *               the 3:1 image would be too small to read. Supplied by Kelicia,
 *               2026-09-30.
 *   href        where a tap goes, https:// only. Empty = plain image (and
 *               `npm run check:deploy` warns). Since 2026-10-26: the YouTrip OneLink.
 *
 * Where it shows: at the bottom of the page, after the contestants; once the
 * visitor has voted, directly under the "vote counted" message. Never in the
 * confirm sheet. No caption or other text goes with it.
 */
export const promoBanner: PromoBanner = {
  image: 'promo/imc4-100-flights-korea-banner-1920x640.jpg',
  phoneImage: 'promo/imc4-100-flights-korea-banner-1080x608.jpg',
  alt: '100 free flights to Korea. Sign up for YouTrip with FLY100KR, 28 Oct to 31 Dec. T&Cs apply.',
  // AppsFlyer OneLink that opens the YouTrip app (Kelicia, 26 Oct 2026). Was the
  // campaign blog post. Desktop and no-app fallback is set on the AppsFlyer side.
  href: 'https://youtrip.onelink.me/P5AL/voting-site',
};

/**
 * Revision 11 (Kelicia, 5 Nov 2026): the post-vote panel. Heading, the promo
 * image above, these lines, then a button to promoBanner.href and Close.
 * Facts from the CS promo brief only. Edit the wording here, not in components.
 */
export const promoDetails: PromoDetails = {
  heading: 'Your vote is in',
  headingWithName: 'Your vote for {name} is in',
  lines: [
    '100 Flights to Korea: 28 Oct to 31 Dec 2026.',
    'New to YouTrip? Sign up with promo code FLY100KR.',
    'Already on YouTrip? Tap "Join now" on the 100 Flights banner in the app, then spend S$500 within the campaign period.',
    'Winners drawn 31 Jan 2027. T&Cs apply.',
  ],
  cta: 'Join the 100 Flights promo',
};

/**
 * PLACEHOLDERS for the Top 10 (Revision 13: 10, was 20). The real names and
 * photos come from the sheet's Contestants tab at runtime. Replace here once confirmed
 * and consented. `photo: null` renders a generated abstract tile.
 * Real photos go in /public/contestants/ and are referenced as 'contestants/01.jpg'.
 * `handle` is optional and is shown as plain text, e.g. handle: '@example'.
 * `tagline` is optional short text for the card's label line (e.g. a town).
 * Left empty here on purpose: nothing is invented for placeholders.
 */
export const contestants: readonly Contestant[] = Array.from({ length: 10 }, (_, index) => {
  const number = index + 1;
  return {
    id: `c${String(number).padStart(2, '0')}`,
    number,
    stageName: `Contestant ${number}`,
    photo: null,
  };
});

/**
 * CONFIRMED by Kelicia 2026-10-13: voting closes Thu 5 Nov 2026 (matches the
 * "Top 20" key visual pill). Opens Mon 2 Nov 2026, the Top 20 reveal date.
 * Times keep this file's earlier convention: open 12:00, close 23:59 SGT.
 * (Replaced placeholders 3 Nov 12:00 to 4 Nov 23:59, which matched neither the
 * PR brief nor the execution plan.)
 *
 * Always write the +08:00 offset. autoOpen: true means voting opens by itself at
 * opensAt and closes by itself at closesAt; an admin can pause and resume inside
 * the window but cannot move its edges.
 */
export const votingWindow: VotingWindow = {
  opensAt: '2026-10-26T00:00:00+08:00',
  // Hard close, the backstop (Revision 12). On the night the real close is a
  // manual call during the livestream.
  closesAt: '2026-11-12T23:59:00+08:00',
  autoOpen: true,
};

export const votingRules: VotingRules = {
  // Off. Emails are not verified, so with this on, anyone who knows or guesses
  // a voter's email could move that person's vote to a different contestant.
  allowVoteChange: false,
  // Hidden by default: public running totals invite pile-ons and gaming.
  publicCounts: false,
};

/**
 * Flag only. Nothing is removed or discounted automatically.
 * The threshold is a starting guess, not a measured one: tune it after the first day.
 */
export const burstRule: BurstRule = {
  votes: 12,
  windowMinutes: 5,
};

/**
 * Flag only. When this many votes in the whole event share one IP address, the
 * admin view says so (with the count and contestants, never the address).
 * Nothing is removed and no vote is ever refused because of its IP: an office,
 * campus or mobile network puts many real voters behind one address.
 * A starting guess, not a measured one.
 */
export const sharedAddressRule: SharedAddressRule = {
  votes: 10,
};

/** Local DEMO adapter only. Not used, or bundled, in a production build. */
export const demo: { passcode: string } = {
  passcode: 'demo-admin',
};
