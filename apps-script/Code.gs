/**
 * IMC 4 lookalike vote: TEST SITE receiver for a Google Sheet.
 *
 * Paste this whole file into the sheet's Extensions > Apps Script editor and
 * deploy it as a web app (README, "Test votes into a Google Sheet"). The test
 * build of the voting page (VITE_STORAGE_ADAPTER=sheet) then POSTs every vote
 * here, and each vote becomes one row on the "Votes" tab.
 *
 * FOR TESTING ONLY. The real vote runs on the Supabase API (README, "Deploy").
 * This sheet holds each voter's email in readable form.
 *
 * What it does
 *   doPost  one vote in, one row out. One vote per email, counted the same way
 *           as the site counts it (canonicalEmail below, a copy of
 *           src/domain/email.ts: tests/apps-script.test.ts checks they agree).
 *           A LockService lock makes the duplicate check and the append one step.
 *           A repeat of the same vote id (a retry after a lost reply) is
 *           answered with the first answer and never adds a second row.
 *   doGet   every vote without emails: row number, contestant number, time and
 *           a short reference made from the counted email. The admin page at
 *           #/admin builds its tally from this.
 *
 * Replies are JSON: { ok: true, data: {...} } or { ok: false, error: '<code>' }.
 */

var VOTES_TAB = 'Votes';
var CONTESTANT_COUNT = 20;
var TIME_ZONE = 'Asia/Singapore';
var HEADER = ['Time (SGT)', 'No.', 'Contestant', 'Email (as typed)', 'Email (counted as)', 'Device', 'Vote ID'];
var COLUMN = { time: 0, number: 1, name: 2, typed: 3, counted: 4, device: 5, voteId: 6 };

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

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return reply_({ ok: false, error: 'busy' });
  try {
    var sheet = votesSheet_();
    var rows = readRows_(sheet);
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      if (plain_(row[COLUMN.voteId]) === voteId) {
        // The same vote sent again: its first reply was lost. Answer as before.
        return reply_({ ok: true, data: { duplicate: false, castAt: isoTime_(row[COLUMN.time]), row: i + 2 } });
      }
      if (plain_(row[COLUMN.counted]) === counted) {
        return reply_({ ok: true, data: { duplicate: true } });
      }
    }

    var now = new Date();
    var rowNumber = rows.length + 2;
    var values = [
      Utilities.formatDate(now, TIME_ZONE, 'yyyy-MM-dd HH:mm:ss'),
      number,
      safe_(text_(vote.contestantName, 60)),
      safe_(text_(vote.email, 254).trim()),
      safe_(counted),
      safe_(text_(vote.device, 80)),
      voteId,
    ];
    sheet
      .getRange(rowNumber, 1, 1, HEADER.length)
      .setNumberFormats([['@', '0', '@', '@', '@', '@', '@']])
      .setValues([values]);
    SpreadsheetApp.flush();
    return reply_({ ok: true, data: { duplicate: false, castAt: now.toISOString(), row: rowNumber } });
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  var rows = readRows_(votesSheet_());
  var votes = [];
  for (var i = 0; i < rows.length; i += 1) {
    var row = rows[i];
    var number = Number(row[COLUMN.number]);
    if (!(number >= 1)) continue;
    votes.push({
      n: i + 1,
      no: number,
      at: isoTime_(row[COLUMN.time]),
      ref: shortRef_(plain_(row[COLUMN.counted])),
    });
  }
  return reply_({ ok: true, data: { takenAt: new Date().toISOString(), votes: votes } });
}

// ---------------------------------------------------------------- helpers

function votesSheet_() {
  var book = SpreadsheetApp.getActiveSpreadsheet();
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

function reply_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}
