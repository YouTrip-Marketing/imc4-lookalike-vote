# IMC 4 lookalike contest: public voting site

The online public voting round, Top 20 to Top 10. Voters arrive from Instagram,
tap a contestant, type their email, confirm, done. The site is the single official count: it
replaces "comment the number" voting.

**Status: first draft, local build only.** Nothing is deployed. No account,
database or hosting service has been created. The contestants are placeholders.

| | |
|---|---|
| Voting page | `http://localhost:5173/` |
| Admin view | `http://localhost:5173/#/admin` (demo passcode `demo-admin`) |
| One vote per | **Email address** (Kelicia, 2026-09-29; replaced one-per-IP so people on the same wifi can all vote). Uniqueness by an HMAC of the email. Since Revision 5 the readable email and the IP are also kept, for a confidential audit export only (IP recorded, never enforced). Emails not verified |
| Hosting plan | **GitHub Pages** for the page, as Trippie Chomp. **Supabase** for the vote API and database |
| Stack | Vite 5, React 18, TypeScript. Backend: one server function + Postgres |

## Run it

```bash
npm install          # if it fails on cache permissions: npm install --cache /tmp/npm-cache-fix
npm run dev          # http://localhost:5173/
```

That runs the **demo**: votes live in your browser only, and a yellow DEMO DATA
banner says so on every page. No credentials needed.

### What to click

1. Open `http://localhost:5173/`. The demo starts inside the voting window, so you
   can vote straight away whatever today's date is.
2. Tap a contestant, confirm. You land on "Vote in!".
3. Scroll to **Demo controls** at the bottom of the page:
   - **New visitor, new email** makes this browser forget it voted and fills in a
     fresh made-up address (`visitor1@example.com`, `visitor2@...`). Tap a
     contestant and confirm: accepted.
   - **New visitor, same email** fills in the last made-up address again. Confirm
     and you see the refusal: "A vote has already been counted for this email."
   - **Before voting opens / During voting / After voting closes** moves the
     pretend clock so you can see all three states.
4. Open `http://localhost:5173/#/admin`, passcode `demo-admin`. Use **Simulate 60
   votes** and **Simulate a burst** to fill the tally, the chart and the burst flags.

The demo keeps votes in your browser and stands in a plain checksum for the
server's keyed hash. It never keeps a readable address either.

### Other commands

| Command | What it does |
|---|---|
| `npm run build` | Type-check and build to `dist/` |
| `npm run deploy` | Publish `dist/` to GitHub Pages. **Do not run yet.** It refuses by itself until the build is ready (see "Deploy") |
| `npm run check:deploy` | The check `deploy` runs first. Safe to run: it publishes nothing |
| `npm run build:edge` | Bundle the Supabase Edge Function into one file. Publishes nothing |
| `npm test` | Unit and integration tests (vitest) |
| `npm run test:e2e` | Builds both variants and clicks through them in headless Chrome. Rewrites `e2e-artifacts/*.png` |
| `npm run api:local` | Local stand-in for the production backend (see "Rehearse") |
| `npm run seed:sql` | Writes `supabase/seed-event.sql` from `event.config.ts` |
| `npm run secrets` | Prints fresh values for the two server secrets |

## Editing contestants, dates and rules

Everything is in **`event.config.ts`**. Nothing about the event is hardcoded elsewhere.

| To change | Edit |
|---|---|
| Event title | `event.title`. **The only place it is written** (legal gate, see below) |
| Contestants | `contestants`: `id`, `number`, `stageName`, `photo`, optional `handle`, optional `tagline` (short free text for the card's label line, e.g. a town) |
| Promo banner | `promoBanner`: `image`, optional `phoneImage`, `alt`, optional `href` (https:// only). Files in `public/promo/`. See "Promo banner" |
| Key visual banner | `keyVisual`: `mobile`, optional `desktop`, `alt`. Files in `public/key-visual/`. Spec: `developer/outbox/imc4-voting-site-key-visual-spec.md`. Set since Revision 8 (Kelicia's "Top 20" creative). A new creative also needs the band colours re-sampled (see "Key visual banner") |
| Voting window | `votingWindow.opensAt` / `closesAt`. Always write `+08:00` |
| Top 10 announcement date | `event.top10AnnouncedOn` (`YYYY-MM-DD`) |
| Votes per email | Fixed at one. Not a setting |
| Let voters change their vote | `votingRules.allowVoteChange` (default `false`. Leave it off while emails are unverified: with it on, anyone who knows a voter's address could move that vote) |
| Show live counts to the public | `votingRules.publicCounts` (default `false`) |
| Burst flag threshold | `burstRule` |
| "Many votes from one network" flag threshold | `sharedAddressRule` (default 10 votes from one IP address). Flag only |
| Legal-review switch | `event.legalReviewPending` (blocks `npm run deploy` while `true`; not shown on the page) |

**Voting window confirmed by Kelicia (2026-10-13):** opens Mon 2 Nov 2026 12:00
SGT (Top 20 reveal), closes Thu 5 Nov 2026 23:59 SGT (matches the key visual's
"voting closes on 5 Nov" pill). Top 10 announced Sat 7 Nov 2026
(`top10AnnouncedOn`). The 12:00 open and 23:59 close follow the
file's earlier time convention. The earlier placeholders (3 Nov 12:00 to 4 Nov
23:59) matched neither the PR brief nor the execution plan.

**Contestant photos.** Put consented photos in `public/contestants/` and set
`photo: 'contestants/01.jpg'`. Portrait **4:5**, 480 x 600 px (face roughly
centred, head in the upper half), JPEG or WebP, aim for under 60 KB each: twenty
of them load over mobile data. They are lazy-loaded. **No editing needed**: the
page turns every photo into high-contrast mono toned purple by itself (see
"Design"). Until a photo is set, the card shows a generated abstract stage
(spotlight and haze) with the same treatment. It is deliberately not a face, a
silhouette or anyone's likeness.

**In production, changing the config is two steps.** The page reads the config at
build time, but the server enforces what is in the database. After editing
contestants, the window or the rules: `npm run seed:sql`, apply the output in the
database's SQL editor, then rebuild and redeploy the page.

## Design: Spotlight Arena (Revision 4)

Chosen by Kelicia on 2026-09-29 from Research's three directions
(`research/outbox/imc4-voting-site-visual-references.html`, Direction 3). The
flow, rules, backend and copy wording did not change.

| | |
|---|---|
| Palette | `#12003C` stage (the key visual's darkest purple, Revision 8; was `#0B0A12`), `#1C0B47` card (was `#1A1626`), `#7B3FE4` YouTrip purple, `#B794FF` lilac, `#D7FF3D` vote lime, `#F4F1FF` white. Plus two functional colours not in the look: `#FF6B81` for errors and `#FFC46B` for admin/offline warnings |
| Lime | **Reserved for the vote action (Confirm vote, Try sending again) and the selected card** (outline, numeral, "Your vote" badge). Nothing else |
| Type | **Poppins**, YouTrip's brand font (Revision 6, 2026-09-30), replacing Anton and Inter everywhere. 800 for headlines and the outlined numerals; 700 for contestant names, buttons and headings (upper-cased by CSS; the text itself is unchanged); 400/500 for body, labels and inputs. Self-hosted from `@fontsource/poppins` (SIL Open Font License), Latin subset, four weights, **31.27 KB of WOFF2 in total** (about 7.8 KB each; the Anton + Inter set was about 96 KB). **The page requests no fonts from Google or anyone else**; the e2e test fails if any request leaves the site, and checks that no Anton or Inter file is loaded |
| Card | 4:5 portrait, 4px corners. Giant outlined numeral top right (decorative, hidden from screen readers). Name and label line bottom left over a black fade. Label line = `No. 07`, then `tagline`, then `handle`, whichever exist |
| Photo treatment | CSS only, so any photo dropped in gets it: `grayscale(1) contrast(1.25)`, then a lilac layer in `multiply` (whites become lilac) and a deep-purple layer in `screen` (blacks become purple; `#33076A` to `#1C0048` since Revision 8, taken from the key visual). A true duotone: the research tile's single `color` blend left pure white and pure black untouched, which the stress test showed. Contestant photos only; **not** the key visual |
| Widths | 2 columns on phones, 3 from 640px, 4 from 900px (as in Revision 3) |
| Admin | Same palette and type (Poppins), tables with tabular figures |

## Key visual banner

A slot at the very top of the voting page for the contest's key visual. **Not an
upload feature**: drop the files in `public/key-visual/` and set `keyVisual` in
`event.config.ts`. The designer's spec is
`developer/outbox/imc4-voting-site-key-visual-spec.md`.

- 16:9 phone image (1080 x 608 px), optional 3:1 desktop image (1920 x 640 px)
  used from 900px wide. One image alone is used at every width. JPG or WebP,
  under 250 KB each.
- Full width of the content column, fixed aspect ratio (no jump while loading),
  4px corners, loaded eagerly. Shown exactly as supplied: no photo treatment.
- **No image set:** the demo build shows a marked placeholder with the sizes
  (16:9 on phones, 3:1 from 900px, the shapes in the spec sheet); a
  production build shows nothing at all (the placeholder is not even in the
  production bundle), and `npm run check:deploy` warns (warning, not blocker).
  It also warns about missing alt text or a file that is not in `public/`.
- First screen at 390 x 844 with a key visual, as the public sees it: the full
  first row of contestants plus the top of the second (measured by the e2e test,
  written to `e2e-artifacts/first-screen.json`).
- `npm run check:deploy` also warns when a key visual file is over 250 KB.

### The real key visual and its colour band (Revision 8, 2026-10-05)

Kelicia's "Top 20" key visual, used exactly as supplied (PNG, not re-encoded):
`public/key-visual/imc4-lookalike-kv-1080x608.png` (16:9, below 900px, 700 KB)
and `imc4-lookalike-kv-1920x640.png` (3:1, from 900px, 1204 KB). Alt text:
"Top 20 K-pop idol lookalikes. YouTrip. Voting closes 5 Nov. T&Cs apply." It must
never name the artist (unit-tested).

The creative's background is a left-to-right gradient, dark indigo to violet,
the same from top to bottom. The page continues it: a band (`.kv-band` in
`src/styles/app.css`) carries the same colour stops behind and beside the
banner, lined up with its edges, then fades into the page colour below it.
Measured on the e2e screenshots, the step between page and image at the
banner's edges is at most 2/255 per channel at every width (invisible).

| | Phone image (below 900px) | Desktop image (from 900px) |
|---|---|---|
| Left edge | `#12003C` | `#000026` |
| Middle | `#3B0B74` | `#280065` |
| Right edge | `#6920AF` | `#5F1AA7` |
| Fade below the banner | 112px | 160px |

Eleven stops per image, every 10%, are in the CSS. **A new creative with a
different background needs them re-sampled**, or the band will show an edge.

The band paints outside the content column with a `border-image` outset (not
scrollable, so no sideways scroll) and sits at `z-index: -1` behind all content.
The demo placeholder and the production collapse are still tested, on builds
with the slot emptied.

**Page heading:** kept visible. It is the state message ("Who makes the Top
10?", "Vote in!", "Voting has closed"), not the event title, so it does not
repeat the key visual. A visually hidden version was screenshotted for
comparison (`e2e-artifacts/option-h1-hidden-*`); it gains 80px of grid at
390 x 844 but loses the call to action.

## Promo banner (Revision 7)

One campaign banner for **"100 Free Flights to Korea"** (IMC 4's acquisition
promo, code FLY100KR, 28 Oct to 31 Dec). Creatives supplied by Kelicia on
2026-09-30, both in `public/promo/`: `imc4-100-flights-korea-banner-1920x640.jpg`
(3:1, 150 KB, from 640px wide) and `imc4-100-flights-korea-banner-1080x608.jpg`
(16:9, 94 KB, phones below 640px). Separate from the key visual slot.

- **Where:** at the bottom of the page, after the contestants. Once the visitor
  has voted (and voting is open), directly under the "vote counted" message,
  above the grid. Not-open and closed states: at the bottom. Never in the
  confirm sheet.
- **What:** an image and, when `href` is set, a link around it (new tab,
  `rel="noopener noreferrer"`, `https://` only; anything else is ignored). No
  caption and no other text on the page. No photo treatment.
- **Sizing:** full column width, fixed 3:1 (16:9 below 640px when `phoneImage`
  is set), 4px corners, lazy-loaded.
- **Not set:** with `image: null`, nothing renders in any build.
- **Phone version:** supplied and set (`phoneImage`). Below 640px the banner is
  16:9, where the code line and dates are readable; from 640px it is 3:1.
- **Landing URL unknown** as of 2026-09-30, so `href` is empty and the banner is
  a plain image. `npm run check:deploy` warns (not blocks) about a missing link,
  a missing phone version, missing alt text and missing files; today only the
  link.
- **First screen, voted state, 390 x 844** (e2e measurement, public view, key
  visual slot in place): the "vote counted" message ends at 527px, the 16:9
  promo sits at 543-745px and the grid starts at 765px, so 79px of the grid is
  visible. On the first screen, but tight. In the demo, whose notice takes about
  80px, only 1px of the grid shows.
- The creative contains a small photo-booth strip with people in it (YouTrip's
  own artwork, supplied by Kelicia).

## How it is built

```
  GitHub Pages                 static files only: the page itself
     |
  Browser (Instagram in-app browser, Safari, Chrome)
     |   POST https://<project>.supabase.co/functions/v1/vote-api/vote
     |        { contestantId, email, requestId }          <- email in the body, never the URL
     v
  Vote API                     server/handler.ts + one platform adapter
     |   answers only to the configured site (CORS)
     |   checks and normalises the email (src/domain/email.ts)
     |   HMACs it with VOTER_HASH_SECRET + the event id (the uniqueness key)
     |   takes the caller's IP from the platform adapter (recorded, never enforced)
     |   checks the admin passcode on admin routes
     v
  Postgres                     supabase/schema.sql
         enforces: voting window, one counted vote per voter key (unique index)
         votes:      the hash, the contestant, the time
         vote_audit: email as typed, email normalised, IP (CONFIDENTIAL, server-only)
```

GitHub Pages serves files and nothing else. It cannot count votes or keep a
secret, so the vote API lives on another address and the page calls it
across origins.

| Folder | What is in it |
|---|---|
| `event.config.ts` | The one config file |
| `src/domain/` | The rules as pure functions: window, uniqueness, ranking, bursts, CSV, Singapore time |
| `src/storage/` | `VoteStore` interface and its two adapters: `local` (demo) and `api` (production) |
| `src/views/` | `VoteView` (public page), `AdminView` |
| `src/demo/` | Demo-only controls. Not included in a production build |
| `server/` | The vote API: identity, database client, request handler. Platform-neutral |
| `server/adapters/` | One thin adapter per platform: `supabase-edge.ts`, `netlify.ts` |
| `supabase/` | `schema.sql` (tables and rules), `config.toml`, and the generated Edge Function |
| `netlify/functions/` | Where Netlify looks for the function. Alternative deployment |
| `scripts/` | Seed SQL, secrets, local API stand-in, end-to-end test |
| `tests/` | vitest suites |

Two adapters sit behind one interface (`src/storage/VoteStore.ts`), chosen at
build time by `VITE_STORAGE_ADAPTER`:

- **`local`** runs the rules in the browser against localStorage. Demo only.
- **`api`** sends requests to the server function. It holds no rules.

The same rules exist twice on purpose, in TypeScript (for the demo) and in SQL
(for production). `tests/fixtures.ts` holds shared case tables that are run
against both, so they cannot drift apart unnoticed.

**Client-side checks alone are not acceptable for production.** The page decides
what to *show*. It never decides whether a vote counts. Anyone can edit a web
page in their own browser; every rule that matters is enforced on the server.

## One vote per email address

Decided by Kelicia on 2026-09-29, replacing one vote per IP address: different
people on the same wifi must all be able to vote. The IP-address version is
archived at `developer/builds/_archive/imc4-lookalike-voting-ip-uniqueness/`.

### The flow

Tap a contestant. The confirm sheet asks for an email ("Your email"). Confirm.
Voted.

**Page copy rule (Kelicia, 2026-09-29):** the page does not explain or justify
why it asks for things. No purpose lines, privacy explanations or reassurance
copy. The line that used to sit under the email field was removed for this
reason, and the tests fail if it comes back. If legal requires a purpose
statement for the email, it goes in the T&Cs, not on the page.

The field is set up for phones: `type="email"`, `inputmode="email"`,
`autocomplete="email"` (so the phone offers the address it knows),
`autocapitalize="none"`, no autocorrect, and 16px text so iOS does not zoom the
page on focus. On a phone the sheet docks to the bottom of the *visible* screen
(`window.visualViewport`), so with the keyboard up the field and both buttons sit
above it; on short screens the picture drops out to make room.

A mistyped address is caught in the sheet ("That email address doesn't look
right") and nothing is sent. The server checks again and has the final say.

### What counts as the same voter

`canonicalEmail` in `src/domain/email.ts`, used by the server and by the demo:

| Everyone | Trimmed and lower-cased |
|---|---|
| Gmail only (`gmail.com`, `googlemail.com`) | Dots and `+anything` removed from the part before the `@`; `googlemail.com` read as `gmail.com` |

Why Gmail is folded: to Google, `jane.doe@gmail.com`, `janedoe@gmail.com` and
`janedoe+vote2@gmail.com` are the same inbox. Counting them separately would give
every Gmail user unlimited votes from one inbox, with no effort. Folding them can
never merge two different people: Google does not issue addresses that differ
only in those ways.

Why only Gmail: for other providers a dot or a `+tag` may or may not reach the
same inbox. Guessing wrong would tell a real person they had already voted. So
every other address is taken exactly as typed (after trimming and lower-casing).
Outlook and Yahoo both support `+` or `-` aliases, so a determined voter there can
still make extra addresses; that is one of the limits below.

**This rule cannot change once voting starts**: the stored hashes are made from it.

Validation (`checkEmail`) is deliberately forgiving: it catches slips (no `@`, a
space, no domain ending, two addresses pasted together, over-long parts) and
leaves the rest alone. The only proof an address exists is sending mail to it.

### What is stored

```
hash = HMAC-SHA256( key: VOTER_HASH_SECRET, message: "<event id>|email|<canonical email>" )
```

The hash is the uniqueness key, in `votes.voter_key`. Since Revision 5 the
readable email and the IP address are ALSO kept, in a separate audit table: see
"Audit record and confidential export" below. Neither is ever logged: error
messages in this codebase never include them, and tests check the server log.

- **Why an HMAC.** A plain hash of an email can be reversed by hashing a list of
  known addresses. Without the secret, the HMAC cannot be checked against a
  guess at all.
- **Where the secret lives.** `VOTER_HASH_SECRET` is an environment variable
  where the vote API runs. Not in the database, the code or the page.
- **Per event.** A new secret for every event (`npm run secrets`), and the event
  id is mixed in, so a hash here matches nothing anywhere else.
- **The database enforces uniqueness itself.** A partial unique index
  (`votes_one_per_voter` on `voter_key where replaced_at is null`) means a second
  counted vote for the same key cannot be written, whatever calls the database.
  `cast_vote` also takes a per-voter lock so two quick taps cannot race.
- **The admin screen and the two publishable CSVs** (tally, vote log) show a
  12-character slice of the hash (`voter_ref`), never an email or IP address.

**The IP address is recorded, never enforced.** There is no IP-based limit of
any kind on voting, so a busy shared network (an office, a campus,
carrier-grade NAT on mobile data) never turns anyone away, and a missing IP
never rejects a vote. The hosting platform will also keep its own access logs,
which this code has no say over.

### Audit record and confidential export (Revision 5)

Decided by Kelicia on 2026-09-29, replacing "HMAC only, no IP read": each vote's
email and IP address are kept, **for the organisers' own checking of the vote.
Not for marketing**: these are not campaign leads and there is no opt-in.

**What is stored, and where.** Table `vote_audit`, one row per counted vote,
keyed to the vote and separate from it:

| Column | Holds |
|---|---|
| `email_typed` | The email as the voter typed it, trimmed (clipped at 320 characters) |
| `email_normalised` | The form the uniqueness check used (lower-cased; Gmail dots and `+tags` folded), so a reviewer can see two spellings counted as one voter |
| `ip` | The address the hosting platform reported: Supabase reads `X-Forwarded-For` counted from the right by `TRUSTED_PROXY_HOPS` (default 1), never the leftmost entry; Netlify uses `context.ip`; the local stand-in uses the socket address. An IPv4 address wrapped in IPv6 is recorded as plain IPv4. `''` when nothing usable was reported |

- Server-only: row level security on, no policies, all privileges revoked from
  `public`, `anon` and `authenticated`. Read only through `admin_audit()`, with
  the service key, after the admin passcode.
- Refused votes and retries leave no row. Emptying the table changes no tally.
- A bad `TRUSTED_PROXY_HOPS` falls back to 1 rather than stopping the API.
- The IP adapter code is restored from the archived IP version
  (`developer/builds/_archive/imc4-lookalike-voting-ip-uniqueness/`).

**The confidential export.** Admin view, panel "Confidential audit export",
button "Audit export: emails and IP addresses (CSV)". Saved as
`vote-audit-CONFIDENTIAL-<date-time>.csv`, a different file from the two
publishable ones. Columns: `vote_id`, `cast_at_sgt`, `contestant_number`,
`stage_name`, `status` (counted / replaced), `email_as_typed`,
`email_normalised`, `ip_address`, `ip_source` (platform / not reported / not
kept / simulated (demo)), `votes_from_this_ip` (how many votes in the whole event
share that address). Behind the admin passcode like the rest of the admin view.
Emails and IPs are **never shown on screen**.

**Spreadsheet safety.** The emails are typed by the public. Every cell that
starts with `=`, `+`, `-`, `@`, tab or carriage return gets a leading apostrophe
so Excel and Google Sheets treat it as text, and cells with commas, quotes or
line breaks are quoted. Tested with hostile inputs such as `=1+2@example.com`
and `=HYPERLINK(...)`.

**"Many votes from one network" flag.** Next to the burst flags: when
`sharedAddressRule.votes` or more votes share one IP address, the admin view
shows the count and the contestants involved, not the address. Flag only, and
worded as a reason to look, not a finding: shared networks produce the same
pattern.

**Where emails and IPs never go** (each has a test): browser storage, the
voting page, any public API answer (session, vote, refusals), the server log,
the tally CSV, the vote-log CSV, and the admin snapshot behind them.

**Trustworthiness.** Emails are unverified: the file shows what was typed, not
who typed it. The Supabase IP is unverified until checked on a real project
(see "Before launch"); until then treat recorded IPs as indicative, not proof.

**The demo.** There is no real IP in a browser-only demo. Each demo visitor gets
a stand-in from a range reserved for documentation (`203.0.113.x`; the
simulated crowd `198.51.100.x`; the one-network simulation `192.0.2.77`),
labelled `simulated (demo)` in the export. Demo audit records are kept in memory
only, never in browser storage, so they last until the page is reloaded (older
votes then show `not kept`). Demo controls: "New visitor, same wifi" (voting
page) and "Simulate 12 votes from one network" (admin).

### The seam for verification

Emails are **not verified**. Adding a one-time code later is designed not to need
a rewrite:

- `VoterIdentityResolver` (`src/domain/identity.ts`) is the one place that decides
  who a voter is. Today `createEmailIdentityResolver` in `server/identity.ts`
  takes the address on trust. A verifying resolver would also check
  `claim.proof` (the code the voter was sent) and is swapped in with one line in
  `server/env.ts`.
- `VoteStore.castVote(contestantId, email, requestId, proof?)` and the API body
  already carry an optional `proof`. The page would need a "send me a code" step
  and one extra field.
- Sending the code needs an email service (an account, a sender domain), plus a
  table for pending codes with expiry and attempt limits. None of that is built.
- The canonical form and the hash stay the same, so votes cast before and after
  switching verification on are counted against the same keys.

### The browser's "you've voted" marker

After a vote the browser keeps a small note in localStorage: which contestant,
and when. **Not the email.** It exists so a returning voter sees their choice. It
is not the enforcement: clearing it, or using another browser, changes nothing,
because the server has the email's hash on record.

Because the marker belongs to the browser, not the person, the voted screen has
a link: "Someone else voting on this phone? Vote with their email". It clears
the marker and reopens the ballot. It gains nobody a second vote.

The public session tells the page nothing about any voter. The page cannot ask
"has this email voted?" without casting a vote.

### Known limits of email uniqueness without verification

Stated plainly. These are properties of the method, not defects in the build.

1. **Anyone can type any address.** Nothing checks that the address exists or
   belongs to the person typing it. One person can vote again with a made-up
   address (`anything@example.com`), a real address that is not theirs, or as
   many addresses as they care to invent. This is the big one: **without
   verification, one vote per email is one vote per string that looks like an
   email.**
2. **Disposable and alias addresses.** Throwaway inbox services, catch-all
   domains, and `+`/`-` aliases at providers other than Gmail all give extra
   votes. A blocklist of disposable domains would slow this down but is never
   complete; not built.
3. **Someone can vote "as" somebody else.** If Alice's address is used first by
   someone else, Alice is told her email has already voted. With
   `allowVoteChange` off (the default) that cannot move her vote once cast, but it
   can pre-empt it.
4. **Voting reveals whether an address has voted.** The refusal message tells
   whoever typed an address that it has been used. That is inherent to telling a
   real voter why they were refused.
5. **Scripts.** Nothing ties a vote to a person or a device. A script inventing
   addresses is limited only by the bot check (not yet built) and by the burst
   flags and Cut 2 review.

What narrows these:

| Measure | Stops | Cost |
|---|---|---|
| **One-time code by email** (recommended before launch) | 1, 3 and most of 5. Disposable inboxes (2) still work | An email-sending service and account, a sender domain, deliverability testing; one more step for voters |
| CAPTCHA-style check (Turnstile) | Most of 5 | A third-party account; seam ready (`humanCheck`) |
| Disposable-domain blocklist | Part of 2 | Upkeep; never complete |
| Cut 2 review of the vote log and burst flags | Visible manipulation | Already in the process |

What protects the result today is the process: the vote decides who enters the
final, the panel confirms the Top 10 after an eligibility check, and the burst
flags and per-vote log give that check something to look at.

### Which sites may call the API

The page and the API are on different origins, so the browser asks the API for
permission before each call (CORS). The API grants it to the sites listed in
`ALLOWED_ORIGINS` and to nobody else.

- The list is exact origins: scheme and host, no path. `https://youtrip-marketing.github.io`.
- **There is no wildcard.** `*` and `https://*.github.io` are refused at start-up.
- A request from any other site gets HTTP 403 and no permission header, so the
  browser blocks it. The vote is refused before the database is touched.
- With `ALLOWED_ORIGINS` unset, no site is allowed. Forgetting it breaks the
  page rather than opening the API.

Two things to know:

1. **An origin is a host, not a folder.** On GitHub Pages every project in the
   organisation is served from `https://youtrip-marketing.github.io`, so allowing
   that origin allows any page under it, Trippie Chomp included. Those are all
   YouTrip's own pages, so the exposure is small. A custom domain for the voting
   page would make the origin its own.
2. **CORS restrains browsers, not scripts.** It stops another website from
   casting votes through its visitors' browsers. It does nothing about someone
   running `curl`. That is what verification and a CAPTCHA are for.

## Deploy: GitHub Pages + Supabase

**None of this has been done, and none of it should be done from this draft.**
It needs accounts and a repository to be created, which are decisions for
Kelicia (see "Open decisions" in the build summary). This is the same hosting
pattern as Trippie Chomp (`gh-pages` package, `npm run deploy`, Vite
`base: './'`), plus a backend, which Trippie Chomp does not have.

### 1. Database and vote API (Supabase)

1. Create a Supabase project under an account YouTrip owns.
2. In the SQL editor, run `supabase/schema.sql`, then the output of `npm run seed:sql`.
3. `npm run secrets` prints a `VOTER_HASH_SECRET` and an `ADMIN_PASSCODE`.
4. Set the function's secrets (Dashboard, or `supabase secrets set`):

   | Secret | Value |
   |---|---|
   | `VOTER_HASH_SECRET` | From step 3. 32+ characters |
   | `ADMIN_PASSCODE` | From step 3. 12+ characters |
   | `ALLOWED_ORIGINS` | `https://youtrip-marketing.github.io` |
   | `TRUSTED_PROXY_HOPS` | Leave unset (1) unless the IP check in "Before launch" says otherwise |

   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to Edge Functions
   by Supabase itself. Supabase's documentation lists the service role key under
   "legacy keys". If a project no longer provides it, put a secret key in
   `DB_SERVICE_KEY` instead (secret names may not start with `SUPABASE_`).
5. `npm run build:edge`, then `supabase functions deploy vote-api`.
   `supabase/config.toml` switches off Supabase's login check for this one
   function, because voters are anonymous.
6. The API is now at `https://<project>.supabase.co/functions/v1/vote-api`.

None of the secrets starts with `VITE_`. Anything prefixed `VITE_` is baked into
the public page. The function refuses to start if a secret is missing or too
short, so a half-configured API takes no votes rather than unsafe ones.

### 2. The page (GitHub Pages)

1. Give this project its own git repository, under the YouTrip-Marketing
   organisation, with that as its `origin`. It has none today: the folder sits,
   untracked, inside the workspace's repository. The simplest way is to copy the
   project folder out of the workspace and `git init` the copy.
2. Copy `.env.production.example` to `.env.production` and put the API address in it.
3. `npm run deploy`. It runs the deploy check, builds, and publishes `dist/` to
   the repository's `gh-pages` branch. The page appears at
   `https://youtrip-marketing.github.io/<repo-name>/`.

**The deploy check** (`scripts/check-deploy.ts`) stops `npm run deploy` when:

- the build would publish the demo (the default when nothing is configured),
  with its simulated votes and its demo admin passcode;
- the API address is missing or is not a full `https://` address;
- this folder has no git repository of its own. **Today it sits inside the
  workspace's repository.** `gh-pages` publishes to the `origin` of whichever
  repository contains the folder it runs in, so a deploy from here would publish
  into the workspace's repository, not a project one;
- `event.legalReviewPending` is still `true`. Publishing makes the event title
  and the email wording public, and both are waiting on legal. Once cleared, set
  it to `false`. To publish a private rehearsal before then:
  `ALLOW_PENDING_LEGAL=1 npm run deploy`.

As the project stands today, the check fails on all four. That is intended.

Things GitHub Pages changes, compared with a host that runs code:

| | |
|---|---|
| Sub-folder | The page is served from `/<repo-name>/`. All asset paths are relative and routing is by `#`, so nothing needs configuring. The end-to-end test checks the built page for absolute paths |
| Response headers | GitHub Pages cannot send custom headers, so the page cannot ask browsers not to embed it. It checks for itself instead, and shows a plain link rather than the vote when it finds itself inside a frame |
| Repository visibility | Check whether the organisation's plan needs the repository to be public for Pages. If so, everything pushed to it is public, including `event.config.ts` and the event title. No secret is in the repository either way |
| Two deployments | The page and the API are deployed separately. After changing contestants, the window or the rules: re-apply the seed SQL **and** redeploy the page |

### Rehearse locally first

`npm run api:local` runs the **real** vote API against the **real**
`schema.sql` in an embedded Postgres, on your machine, with no account. The page
and the API are on different origins here too, so CORS is exercised for real.

```bash
OPEN_NOW=1 npm run api:local        # terminal 1. OPEN_NOW=1 opens voting for 24 hours
VITE_STORAGE_ADAPTER=api VITE_API_BASE_URL=http://localhost:54329/api npm run dev   # terminal 2
```

Every browser you open reaches the stand-in from the same address, which is
exactly the shared-wifi case: each can still vote with its own email.

It proves the page, the API and the SQL work together. It proves nothing about a
real hosting platform.

### Before launch

| # | Check | How |
|---|---|---|
| 1 | **Decide on verification** | Open decision. Without a one-time code, see "Known limits" above |
| 2 | **Two people, one wifi** | Two phones on the same wifi, two different emails: both accepted. The `votes` table holds two different hashes |
| 3 | **Same email, twice** | Vote again with the first email from a different phone on mobile data: refused with "A vote has already been counted for this email." Try it in capitals and, for a Gmail address, with a dot or `+tag` added: still refused |
| 4 | **Emails and IPs only where they belong** | After rehearsal: `votes` shows hashes only, the function's logs show no address, and only `vote_audit` and the audit export hold emails and IPs |
| 4a | **Is the recorded IP real, and can it be forged?** | Vote once from a known network and compare the audit export's `ip_address` with that network's public address. Vote again with `-H 'X-Forwarded-For: 1.2.3.4'` added (new email): the recorded IP must not be `1.2.3.4`. If it is, the IP column is not trustworthy on this platform (voting is unaffected) |
| 5 | The Instagram in-app browser | On a real iPhone and a real Android phone: put the link in an Instagram bio or Story, tap it, vote. Check the keyboard does not cover the Confirm button and that autofill offers the address. See "Instagram in-app browser" below |
| 6 | Bot protection | Add it. See below |
| 7 | Load | Send a few hundred votes from a script and watch response times and the database's connection count |
| 8 | Legal | Event title; voting rules; T&Cs covering collection and retention of email and IP addresses (and any purpose statement) |
| 9 | Real contestants | Names, photos, written consent |
| 10 | Clocks | Confirm the window in the admin view reads correctly in SGT |

### Alternative: Netlify

The same API runs as a Netlify Function (`netlify/functions/api.ts`,
`netlify.toml`). The page can stay on GitHub Pages and call it across origins,
or move to Netlify too, in which case page and API share an origin and
`VITE_API_BASE_URL` is `/api`.

Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as Netlify environment
variables alongside the secrets above: Netlify is not given them automatically.
The database is still Supabase. Set `ALLOWED_ORIGINS` to the page's origin in
either arrangement.

### Deploy options compared

| Option | For | Against |
|---|---|---|
| **GitHub Pages + Supabase** (primary) | Same pattern as Trippie Chomp. Everything under accounts YouTrip can own. One backend vendor for the API and the database | Supabase pauses free projects after a week without activity, so create it close to the vote or use a paid tier |
| GitHub Pages + Netlify Function + Supabase database | Works the same; the adapter is built | Three services. The existing Netlify account is a personal one |
| GitHub Pages + Cloudflare Worker | Turnstile (CAPTCHA) is the same vendor | New account. New adapter. Not built |
| GitHub Pages alone | Nothing to set up | **Cannot work.** No server to keep the secret or hold the count |

### Bot protection

This is a public link that 20 contestants will push to their followers. Expect
people to try scripts. What is built in:

- One counted vote per email hash, enforced by a unique index and a per-voter
  lock, so parallel requests cannot both slip through.
- A site-wide throttle on wrong admin passcodes (20 a minute by default; right
  passcodes are not counted). It records that a guess was wrong, nothing about
  who guessed.
- **No per-network rate limit on voting**, on purpose: it would turn away real
  voters sharing an office, campus or mobile-carrier address.
- An allow-list of sites (CORS), so another website's page cannot cast votes
  using its visitors' browsers.
- The page refuses to render inside another site's frame.
- Burst flags in the admin view.

What is **not** built in, and should be added for launch: a CAPTCHA-style check
on the vote, such as Cloudflare Turnstile, and ideally email verification. None
of the above stops a script that invents email addresses; a check that the
caller is a person does, and a one-time code makes each address cost a real
inbox. The seam is ready: `humanCheck` in `server/handler.ts`. It was
left unconnected because this draft integrates no third-party service.

## Privacy and retention

**What is collected:** a keyed hash of the voter's email (the uniqueness key), a
random id for the vote attempt, the contestant chosen and the time; and, in the
separate server-only audit table, the email as typed, the normalised email and
the IP address reported by the platform (Revision 5, for audit, not
marketing). No names, phone numbers or Instagram handles. No analytics, no
trackers, no third-party fonts or scripts: the end-to-end test fails if the page
makes a request to any other origin.

The page carries no purpose statement for the email (see the page copy rule
above). **If legal requires one, it goes in the T&Cs.** `event.legalReviewPending`
keeps `npm run deploy` shut until legal has cleared the event title and **T&Cs
that cover collecting and keeping each voter's email and IP address**. The page
itself says nothing about it (page copy rule). The audit emails are **not
campaign leads**; using them for marketing would need separate consent.

**Retention plan (recommended):**

1. Voting closes. Export the tally and vote log, and, if the eligibility check
   needs it, the confidential audit export. Keep the audit file on a
   restricted drive, never in a shared or public folder.
2. Cut 2: tally, eligibility check, panel confirmation.
3. **Once the Top 10 tally is signed off**, in the database's SQL editor:

   ```sql
   select public.purge_voter_keys();
   ```

   This wipes every email hash, every request id and every throttle counter,
   and **deletes every audit record: all readable emails and IP addresses**.
   The votes, their timestamps and the tally stay. It refuses to run while voting
   is open, it cannot be undone, and voting cannot be reopened afterwards.
4. Delete `VOTER_HASH_SECRET` from the function's secrets. Without it, any copy of
   the hashes that escaped (an exported CSV, a backup) can never be matched to an
   address.
5. **Delete every downloaded copy of the audit export** on the same day. The
   purge cannot reach files already on someone's laptop.
6. The vote-log CSV holds a 12-character slice of each hash. Treat it as
   internal, and delete it on the same schedule unless legal advises otherwise.
   The tally CSV holds no voter data and is the one to publish.

## Instagram in-app browser

Most voters will see this page inside Instagram, not in Safari or Chrome.
**It has not been tested in the real Instagram app.** That needs real phones.

What was designed for, and how far each point was checked:

| Concern | What the build does | Checked how |
|---|---|---|
| The link arrives with tracking parameters (`?fbclid=`, `?igsh=`) | The voting page is the default route; unknown parameters are ignored | Automated, in headless Chrome |
| Storage may be blocked or wiped | Every storage call is wrapped. With storage blocked the page still votes; it just forgets the choice on reload, and the server still enforces the limit | Automated, by making storage throw |
| The in-app browser shares nothing with Safari or Chrome | Expected and harmless: the limit is per email, on the server, not per browser | By design. Not observed on a device |
| The on-screen keyboard covers the confirm sheet | The sheet is laid out against `visualViewport`, sits above the keyboard, and drops its picture on short screens | Simulated only, by halving the window height in headless Chrome at 360, 390 and 430px. Not seen with a real keyboard |
| Autofill and keyboard type | `type="email"`, `inputmode="email"`, `autocomplete="email"`, `autocapitalize="none"`, 16px text (no iOS zoom) | Attributes and font size checked automatically. Not observed on a device |
| `<dialog>` is missing on iOS before 15.4 | The confirm sheet falls back to a positioned element | Automated, by deleting `showModal` |
| `crypto.randomUUID` is missing on older engines | Falls back to `getRandomValues`, then to a timestamp | Automated, by deleting it |
| Instagram's own toolbars cover the screen edges | On phones the sheet docks to the bottom of the visible area and respects the safe-area inset. No sticky footer | Layout only, at 360, 390 and 430px |
| Numbers turned into phone links | `format-detection` meta tag | Not checked on a device |
| Date formatting differs between engines | Singapore time is formatted by hand, not through `Intl` | Unit tests |
| Slow mobile data | Self-hosted fonts (Latin subset, 4 files, about 24 KB each as WOFF2; `font-display: swap`, so text shows at once in a fallback font), no third-party requests. Production build is about 60 KB of JavaScript gzipped | Build output |

The automated checks run in Chrome with a phone-sized window and, in one case, an
Instagram user-agent string. That tests the page's logic and layout. It is not
the Instagram app, not WebKit, and not a phone.

The admin view is built for a laptop. CSV download in particular is unlikely to
work inside an in-app browser: open the admin view in a normal browser.

## Legal gate

Naming the artist in public-facing assets is **pending legal review**. The event
title is written in exactly one place, `event.title` in `event.config.ts`, and
"Jungkook Lookalike Contest" is the working title for this internal draft only.
Changing that one value changes every page and the browser tab.

The page uses no photo of the artist or of any real person, and no BTS, HYBE or
BigHit logo, font or styling, and no show logos or title treatments. It is a
YouTrip page in the Spotlight Arena direction: genre, not brand.

The page no longer has a footer: Kelicia removed the network-address privacy
paragraph and the "Your vote helps decide..." paragraph on 2026-09-29. The page
makes no mention of any prize. `tests/config.test.ts` and the end-to-end test
fail if the voter-facing copy mentions cash, prizes, flights or a draw, or if
either removed paragraph comes back.

## Tests

```bash
npm test             # 630 tests, about 3 seconds
npm run test:e2e     # 113 steps in headless Chrome, about 2-3 minutes
```

| Suite | Covers |
|---|---|
| `voting-rules` | Window truth table, allowance, ranking, ties at the Top 10 cut |
| `engine` | The reference rules. The required cases, then the scenario table |
| `schema.sql` | The **same** cases against the real SQL in an embedded Postgres; the unique index; privileges; the passcode throttle; purge |
| `api-handler` | The vote API end to end: one vote per email, Gmail folding, many voters from one network, no readable email in the database or the server log, passcode, CORS allow-list |
| `adapters` | The Supabase Edge Function **bundle itself**, run under Node with a stand-in for Deno; the Netlify adapter; the deploy check |
| `identity` | Email checking and normalisation (shared case table), the HMAC against a published test vector, secret and event-id separation, and that the demo agrees with the server on who is who |
| `analytics` | Tally, volume per hour, burst detection |
| `local-store` | The demo adapter: email voters, sample addresses, pretend clock, the browser marker |
| `api-store` | The production adapter's requests (email in the body, not the URL), error mapping and response validation |
| `csv-time-retry` | CSV escaping and formula neutralising, Singapore time, retry with backoff |
| `config` | `event.config.ts` itself: 20 contestants, defaults, copy guardrails, the removed paragraphs stay removed |

The end-to-end test also screenshots every voter state and the admin view at
360, 390, 430 and 1280px, three times over:

- `layout-*.png`: no key visual set (the demo placeholder shows);
- `layout-kv-*.png`: a generated stand-in key visual, four generated "difficult
  lighting" textures as contestant photos (blown-out white, near-black with one
  hot spot, strong orange cast, fine stripes), a 24-character name, a two-word
  name, and a tagline plus handle. It builds with a test-only Vite plugin that
  swaps in an override of `event.config.ts`; the real file is not touched;
- `layout-prod-*.png`: the production build with no key visual (slot collapsed).

It fails on sideways overflow, tap targets under 44px, a confirm sheet that does
not fit, names clipped or outside their card, a banner of the wrong ratio or
width, the photo treatment reaching the key visual, and any request to another
origin.

## Not verified

Stated plainly, so nobody assumes otherwise:

- **The photo treatment on real contestant photos.** Tested only on generated
  images (placeholders and four stress textures). Real selfies, especially of
  darker and lighter skin tones under mixed lighting, need checking once 3-4
  consented submissions exist.
- **A real key visual.** Tested with a generated stand-in only.
- **The recorded IP addresses.** On Supabase, how `X-Forwarded-For` is filled is
  undocumented; on Netlify, whether `context.ip` can be influenced is
  undocumented. Treat the audit export's IPs as indicative, not proof, until
  check 4a in "Before launch" has passed on the real platform.
- **The sample audit CSV** is generated and its rows asserted by the e2e test;
  it has not been inspected by eye.
- **Email addresses are not verified.** See "Known limits of email uniqueness
  without verification". No email is ever sent by this build.
- **The on-screen keyboard** has only been simulated (a shorter window), never
  seen on a phone.
- **Not run on any hosting platform, and never deployed.** `npm run deploy` has
  not been run. The Supabase adapter has never run on Supabase or on Deno: its
  bundle is tested under Node with a stand-in for the `Deno` global. The Netlify
  adapter has never run on Netlify.
- **`supabase/config.toml`** (`verify_jwt`, `entrypoint`) follows Supabase's
  function configuration page but has not been used with the Supabase CLI.
- **Not run against a real Supabase project.** The SQL is tested in PGlite, an
  embedded Postgres. A hosted project's default grants, REST layer and
  connection limits are untested.
- **Not served from GitHub Pages.** The build is checked for relative paths and
  the page was exercised cross-origin against the local API, but not from a
  `github.io` address.
- **Not tested in the Instagram in-app browser, or on any phone.**
- **Not load tested.** Nothing here says how it behaves at 1,155 voters, or under
  a scripted attack.
- **The passcode throttle and the burst threshold are starting guesses**, not
  tuned against traffic.
- **Accessibility** was built in (labels, focus, live regions, keyboard access to
  the chart, reduced motion) but not audited with a screen reader.
