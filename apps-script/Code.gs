/**
 * IMC 4 lookalike vote: the vote store, a Google Sheet (production from 26 Oct 2026).
 *
 * Paste this whole file into the sheet's Extensions > Apps Script editor and
 * deploy it as a web app (README, "Test votes into a Google Sheet"). The test
 * build of the voting page (VITE_STORAGE_ADAPTER=sheet) then POSTs every vote
 * here, and each vote becomes one row on the "Votes" tab.
 *
 * The sheet holds each voter's email in readable form, for the organisers'
 * confidential audit only (Kelicia's decision, 29 Sep 2026). Keep it private.
 *
 * What it does
 *   doPost  one attempt in, one row out. One vote per email, counted the same
 *           way as the site counts it (canonicalEmail below, a copy of
 *           src/domain/email.ts: tests/apps-script.test.ts checks they agree).
 *           A repeat from the same email is refused, but still gets a row with
 *           Duplicate? = TRUE, so the rule can be seen working; the Tally tab
 *           and doGet leave those rows out.
 *           A LockService lock makes the duplicate check and the append one step.
 *           A repeat of the same vote id (a retry after a lost reply) is
 *           answered with the first answer and never adds a second row.
 *   doGet   every counted vote without emails or IPs: row number, contestant
 *           number, time and a short reference made from the counted email.
 *           The admin page at #/admin builds its tally from this. Needs the
 *           admin passcode (?key=...), checked against ADMIN_KEY_SHA256 below,
 *           so running totals are not public.
 *
 *   doGet?view=contestants  the Top 10 from the "Contestants" tab (No., Name,
 *           Instagram handle, Tagline, Photo = a Google Drive share link or an
 *           https image address), for the page to show. Public, but EMPTY until
 *           REVEAL_AT (the reveal is 2 Nov 12:00 SGT), so filling the tab early
 *           leaks nothing; with the admin passcode (?key=) it answers early, for
 *           checking. Cached for 60 seconds. Drive links become
 *           lh3.googleusercontent.com/d/<id>=w960 (Google's image server,
 *           resized); each file must be shared "Anyone with the link".
 *
 * Voting window, enforced here whatever the page says: a vote before OPENS_AT
 * is refused with voting_not_open, from CLOSES_AT on with voting_closed. Both
 * must match votingWindow in event.config.ts (a unit test checks). One
 * exception, ORGANISER TEST votes: a POST carrying the admin passcode as
 * adminKey is accepted at any time and its row is marked Organiser test? = TRUE.
 * The page sends adminKey only in the browser tab where #/admin was unlocked.
 * Test rows are left out of the Tally and doGet, are checked for repeats only
 * against other test rows, and never stop that email's real vote. Delete them
 * whenever convenient.
 *
 * IP (self-reported): Apps Script cannot see the voter's IP address, so the
 * page looks up its own public IP and sends it. INDICATIVE ONLY: anyone can
 * send any value. It is never used to accept or refuse a vote. The production
 * Supabase API records the real address on the server.
 *
 * Replies are JSON: { ok: true, data: {...} } or { ok: false, error: '<code>' }.
 */

/**
 * The one spreadsheet this script may write to: Kelicia's "Voting site"
 * (production, 26 Oct 2026). The 13 Oct test sheet, 1nq_hyBZWk5zbTLuigdTyThQLf94mxaSr_Z3IklOcGEE,
 * is the test target only: a copy deployed there needs this ID changed.
 */
var SHEET_ID = '1ir3Umrw3Xq_ImhOA08Qcdj4aXD06LRuJSoDvCFLMqKI';
var VOTES_TAB = 'Votes';
/** Same instants as votingWindow in event.config.ts. */
var OPENS_AT = '2026-10-26T00:00:00+08:00';
var CLOSES_AT = '2026-11-12T23:59:00+08:00';
/** Contestant names and photos are public from this instant, when voting opens. */
var REVEAL_AT = OPENS_AT;
var CONTESTANTS_TAB = 'Contestants';
var CONTESTANTS_CACHE_SECONDS = 60;
/** Tests only (scripts/apps-script-harness.ts): lets http://127.0.0.1 photo addresses through. */
var LOCAL_PHOTOS_FOR_TESTS = false;
/** SHA-256 (hex) of the admin passcode. The passcode itself is never in this file. */
var ADMIN_KEY_SHA256 = '0025f030d4ebb2462d18c614e97cd3ff9a4b2cf61b54f61968bf33385d0e1661';
var CONTESTANT_COUNT = 10;
/** Column D, the finalist's one-line pitch (Revision 13b; was 40). The longest is about 300. */
var TAGLINE_MAX = 320;
var TIME_ZONE = 'Asia/Singapore';
var HEADER = [
  'Timestamp (SGT)', 'Email (as typed)', 'Canonical email', 'IP (self-reported)', 'Contestant no.',
  'Contestant name', 'Vote ID', 'User agent (short)', 'Duplicate?', 'Organiser test?',
];
var COLUMN = { time: 0, typed: 1, counted: 2, ip: 3, number: 4, name: 5, voteId: 6, device: 7, duplicate: 8, test: 9 };
var FORMATS = ['@', '@', '@', '@', '0', '@', '@', '@', 'General', 'General'];

// ------------------------------------------------------------------ email rule
// Copy of checkEmail + canonicalEmail in src/domain/email.ts. Keep them identical.

var MAX_LENGTH = 254;
var MAX_LOCAL_LENGTH = 64;
var GMAIL_DOMAINS = ['gmail.com', 'googlemail.com'];

function checkEmail(raw) {
  if (typeof raw !== 'string') return { ok: false, problem: 'empty' };
  var email = raw.trim().toLowerCase();
  if (email === '') return { ok: false, problem: 'empty' };
  if (email.length > MAX_LENGTH) return { ok: false, problem: 'too_long' };

  var at = email.lastIndexOf('@');
  if (at < 1 || at !== email.indexOf('@')) return { ok: false, problem: 'malformed' };
  var local = email.slice(0, at);
  var domain = email.slice(at + 1);

  if (local.length > MAX_LOCAL_LENGTH) return { ok: false, problem: 'too_long' };
  if (/[\s<>()[\]\\,;:"]/.test(email)) return { ok: false, problem: 'malformed' };
  if (local.charAt(0) === '.' || local.charAt(local.length - 1) === '.' || local.indexOf('..') !== -1) {
    return { ok: false, problem: 'malformed' };
  }

  var labels = domain.split('.');
  var lastLabel = labels[labels.length - 1] || '';
  if (labels.length < 2 || lastLabel.length < 2 || /^\d+$/.test(lastLabel)) {
    return { ok: false, problem: 'malformed' };
  }
  for (var i = 0; i < labels.length; i += 1) {
    var label = labels[i];
    if (label === '' || label.length > 63 || label.charAt(0) === '-' || label.charAt(label.length - 1) === '-') {
      return { ok: false, problem: 'malformed' };
    }
    if (!/^[\p{L}\p{N}-]+$/u.test(label)) return { ok: false, problem: 'malformed' };
  }
  return { ok: true, email: email };
}

function canonicalEmail(raw) {
  var checked = checkEmail(raw);
  if (!checked.ok) return null;
  var at = checked.email.lastIndexOf('@');
  var local = checked.email.slice(0, at);
  var domain = checked.email.slice(at + 1);

  if (GMAIL_DOMAINS.indexOf(domain) === -1) return checked.email;

  var plus = local.indexOf('+');
  var mailbox = (plus === -1 ? local : local.slice(0, plus)).replace(/\./g, '');
  return mailbox === '' ? null : mailbox + '@gmail.com';
}

// ---------------------------------------------------------------- web app

function doPost(e) {
  var vote;
  try {
    vote = JSON.parse(e && e.postData ? e.postData.contents : '');
  } catch (error) {
    return reply_({ ok: false, error: 'invalid_vote' });
  }
  if (typeof vote !== 'object' || vote === null) return reply_({ ok: false, error: 'invalid_vote' });

  var number = vote.contestantNumber;
  if (typeof number !== 'number' || Math.floor(number) !== number || number < 1 || number > CONTESTANT_COUNT) {
    return reply_({ ok: false, error: 'invalid_vote' });
  }
  var voteId = vote.voteId;
  if (typeof voteId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(voteId)) {
    return reply_({ ok: false, error: 'invalid_vote' });
  }
  var counted = canonicalEmail(vote.email);
  if (counted === null) return reply_({ ok: false, error: 'invalid_email' });

  var organiser = isAdmin_(vote.adminKey);
  if (!organiser) {
    var now0 = new Date().getTime();
    if (now0 < new Date(OPENS_AT).getTime()) return reply_({ ok: false, error: 'voting_not_open' });
    if (now0 >= new Date(CLOSES_AT).getTime()) return reply_({ ok: false, error: 'voting_closed' });
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return reply_({ ok: false, error: 'busy' });
  try {
    var sheet = votesSheet_();
    if (sheet === null) return reply_({ ok: false, error: 'misconfigured' });
    var rows = readRows_(sheet);
    var duplicate = false;
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      if (plain_(row[COLUMN.voteId]) === voteId) {
        // The same attempt sent again: its first reply was lost. Answer as before.
        return reply_(
          row[COLUMN.duplicate] === true
            ? { ok: true, data: { duplicate: true } }
            : { ok: true, data: { duplicate: false, castAt: isoTime_(row[COLUMN.time]), row: i + 2 } },
        );
      }
      // Real votes are checked against real votes, organiser tests against tests.
      var rowIsTest = row[COLUMN.test] === true;
      if (row[COLUMN.duplicate] !== true && rowIsTest === organiser && plain_(row[COLUMN.counted]) === counted) {
        duplicate = true;
      }
    }

    var now = new Date();
    var rowNumber = rows.length + 2;
    var values = [
      Utilities.formatDate(now, TIME_ZONE, 'yyyy-MM-dd HH:mm:ss'),
      safe_(text_(vote.email, 254).trim()),
      safe_(counted),
      ipOrUnavailable_(vote.ip),
      number,
      safe_(text_(vote.contestantName, 60)),
      voteId,
      safe_(text_(vote.device, 80)),
      duplicate,
      organiser,
    ];
    sheet.getRange(rowNumber, 1, 1, HEADER.length).setNumberFormats([FORMATS]).setValues([values]);
    SpreadsheetApp.flush();
    return reply_(
      duplicate
        ? { ok: true, data: { duplicate: true } }
        : { ok: true, data: { duplicate: false, castAt: now.toISOString(), row: rowNumber } },
    );
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  if (e && e.parameter && e.parameter.view === 'contestants') {
    return reply_({ ok: true, data: contestantsAnswer_(isAdmin_(e.parameter.key)) });
  }
  if (!isAdmin_(e && e.parameter ? e.parameter.key : undefined)) return reply_({ ok: false, error: 'bad_passcode' });
  var sheet = votesSheet_();
  if (sheet === null) return reply_({ ok: false, error: 'misconfigured' });
  var rows = readRows_(sheet);
  var votes = [];
  for (var i = 0; i < rows.length; i += 1) {
    var row = rows[i];
    var number = Number(row[COLUMN.number]);
    if (!(number >= 1) || row[COLUMN.duplicate] === true || row[COLUMN.test] === true) continue;
    votes.push({
      n: i + 1,
      no: number,
      at: isoTime_(row[COLUMN.time]),
      ref: shortRef_(plain_(row[COLUMN.counted])),
    });
  }
  return reply_({ ok: true, data: { takenAt: new Date().toISOString(), votes: votes } });
}

// ---------------------------------------------------------------- contestants

/** { revealed, contestants: [{ no, name, handle, tagline, photo }] }. Nothing about voters. */
function contestantsAnswer_(admin) {
  var revealed = new Date().getTime() >= new Date(REVEAL_AT).getTime();
  if (!revealed && !admin) return { revealed: false, contestants: [] };
  var cache = admin ? null : CacheService.getScriptCache();
  var cached = cache === null ? null : cache.get('contestants');
  if (cached !== null) return { revealed: revealed, contestants: JSON.parse(cached) };
  var list = readContestants_();
  if (cache !== null) cache.put('contestants', JSON.stringify(list), CONTESTANTS_CACHE_SECONDS);
  return { revealed: revealed, contestants: list };
}

function readContestants_() {
  var book = book_();
  if (book === null) return [];
  var sheet = book.getSheetByName(CONTESTANTS_TAB);
  if (sheet === null || sheet.getLastRow() < 2) return [];
  var rows = sheet.getRange(2, 1, Math.min(sheet.getLastRow() - 1, 60), 5).getValues();
  var seen = {};
  var list = [];
  for (var i = 0; i < rows.length; i += 1) {
    var no = Number(rows[i][0]);
    if (!(no >= 1 && no <= CONTESTANT_COUNT) || Math.floor(no) !== no || seen[no]) continue;
    seen[no] = true;
    list.push({
      no: no,
      name: cleanText_(rows[i][1], 40),
      handle: cleanHandle_(rows[i][2]),
      tagline: cleanText_(rows[i][3], TAGLINE_MAX),
      photo: photoAddress_(rows[i][4]),
    });
  }
  return list;
}

function cleanText_(value, max) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** "@name" for a plausible Instagram handle, else ''. */
function cleanHandle_(value) {
  var handle = cleanText_(value, 40).replace(/^@/, '');
  return /^[A-Za-z0-9._]{1,30}$/.test(handle) ? '@' + handle : '';
}

/** A Drive share link becomes Google's resized image address; any other https image address passes. */
function photoAddress_(value) {
  var text = cleanText_(value, 500);
  if (text === '') return '';
  var drive = /^https:\/\/(drive|docs)\.google\.com\//.test(text)
    ? /\/d\/([A-Za-z0-9_-]{20,})/.exec(text) || /[?&]id=([A-Za-z0-9_-]{20,})/.exec(text)
    : null;
  if (drive !== null) return 'https://lh3.googleusercontent.com/d/' + drive[1] + '=w960';
  if (/^https:\/\/[^\s"'<>]+$/.test(text)) return text;
  if (LOCAL_PHOTOS_FOR_TESTS && /^http:\/\/127\.0\.0\.1:\d+\/[^\s"'<>]+$/.test(text)) return text;
  return '';
}

// ---------------------------------------------------------------- helpers

/**
 * The "Voting site" spreadsheet, opened by its ID, so the script works wherever
 * the Apps Script project lives (bound to the sheet or standalone), as long as
 * the deploying account can edit the sheet. null if it cannot be opened.
 */
function book_() {
  try {
    return SpreadsheetApp.openById(SHEET_ID);
  } catch (error) {
    return null;
  }
}

/** The Votes tab, or null when the spreadsheet cannot be opened. */
function votesSheet_() {
  var book = book_();
  if (book === null) return null;
  var sheet = book.getSheetByName(VOTES_TAB);
  if (sheet === null) {
    sheet = book.insertSheet(VOTES_TAB);
    sheet.getRange(1, 1, 1, HEADER.length).setValues([HEADER]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function readRows_(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, HEADER.length).getValues();
}

/** An IPv4 or IPv6 address as sent by the page, or 'unavailable'. Never trusted for anything. */
function ipOrUnavailable_(value) {
  if (typeof value !== 'string') return 'unavailable';
  var ip = value.trim();
  return /^[0-9A-Fa-f:.]{3,45}$/.test(ip) && /[.:]/.test(ip) ? ip : 'unavailable';
}

function text_(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** Stops a typed value from being read as a formula: '=...', '+...', '-...', '@...'. */
function safe_(value) {
  return /^[=+\-@]/.test(value) ? "'" + value : value;
}

/** A cell's text without the apostrophe safe_ may have added. */
function plain_(value) {
  var textValue = String(value === null || value === undefined ? '' : value);
  return textValue.charAt(0) === "'" ? textValue.slice(1) : textValue;
}

function isoTime_(value) {
  if (value instanceof Date) return value.toISOString();
  var match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(String(value));
  return match === null ? '' : new Date(match[1] + 'T' + match[2] + '+08:00').toISOString();
}

/** First 8 hex characters of SHA-256 of the counted email: tells voters apart, is not an address. */
function shortRef_(counted) {
  if (counted === '') return '';
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, counted, Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < 4; i += 1) {
    var b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

/** True when `key` is the admin passcode. Constant-time enough for a hash compare. */
function isAdmin_(key) {
  if (typeof key !== 'string' || key === '' || !/^[0-9a-f]{64}$/.test(ADMIN_KEY_SHA256)) return false;
  return sha256Hex_(key) === ADMIN_KEY_SHA256;
}

function sha256Hex_(value) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < bytes.length; i += 1) {
    var b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

function reply_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}
