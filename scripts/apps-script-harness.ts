/**
 * TEST ONLY. Runs apps-script/Code.gs in Node against a pretend spreadsheet,
 * so the unit tests and the e2e stub endpoint exercise the very file Kelicia
 * pastes into Apps Script.
 *
 * The fakes copy the few Apps Script behaviours the script relies on:
 *   - setValues on a string starting with "'" stores the rest as plain text;
 *     a string starting with "=" is taken as a FORMULA (recorded, so a test can
 *     prove no typed value ever became one);
 *   - getValues returns what was stored;
 *   - LockService locks are exclusive (tryLock fails while one is held).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';

export const CODE_GS_PATH = resolve(import.meta.dirname, '..', 'apps-script', 'Code.gs');

type Cell = string | number | Date;

export class FakeSheet {
  readonly rows: Cell[][] = [];
  readonly formulas: string[] = [];
  frozenRows = 0;

  getLastRow(): number {
    return this.rows.length;
  }

  setFrozenRows(count: number): void {
    this.frozenRows = count;
  }

  getRange(row: number, column: number, numRows = 1, numColumns = 1) {
    const sheet = this;
    const range = {
      setNumberFormats: () => range,
      setValues(values: unknown[][]) {
        values.forEach((line, r) => {
          const target = (sheet.rows[row - 1 + r] ??= []);
          line.forEach((value, c) => {
            let stored = value as Cell;
            if (typeof value === 'string' && value.startsWith("'")) stored = value.slice(1);
            else if (typeof value === 'string' && value.startsWith('=')) sheet.formulas.push(value);
            target[column - 1 + c] = stored;
          });
        });
        return range;
      },
      getValues(): Cell[][] {
        const out: Cell[][] = [];
        for (let r = 0; r < numRows; r += 1) {
          const source = sheet.rows[row - 1 + r] ?? [];
          const line: Cell[] = [];
          for (let c = 0; c < numColumns; c += 1) line.push(source[column - 1 + c] ?? '');
          out.push(line);
        }
        return out;
      },
    };
    return range;
  }
}

export interface AppsScriptRun {
  doPost(body: string): { status: number; json: unknown };
  doGet(): { status: number; json: unknown };
  /** The Votes tab, or undefined before the first vote creates it. */
  votes(): FakeSheet | undefined;
  /** Simulates another request holding the script lock. */
  holdLock(held: boolean): void;
  /** Calls a top-level function from Code.gs by name (e.g. canonicalEmail). */
  call(name: string, ...args: unknown[]): unknown;
}

export function loadAppsScript(options: { now?: () => Date } = {}): AppsScriptRun {
  const tabs = new Map<string, FakeSheet>();
  let lockHeld = false;
  const RealDate = Date;
  const now = options.now ?? (() => new RealDate());

  class ScriptDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(now().getTime());
      else super(...(args as [string]));
    }
  }

  const services = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: (name: string) => tabs.get(name) ?? null,
        insertSheet: (name: string) => {
          const sheet = new FakeSheet();
          tabs.set(name, sheet);
          return sheet;
        },
      }),
      flush: () => undefined,
    },
    LockService: {
      getScriptLock: () => {
        let mine = false;
        return {
          tryLock: () => {
            if (lockHeld) return false;
            lockHeld = true;
            mine = true;
            return true;
          },
          releaseLock: () => {
            if (mine) lockHeld = false;
            mine = false;
          },
        };
      },
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (_algorithm: string, value: string) =>
        // Apps Script returns signed bytes.
        [...createHash('sha256').update(value, 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b)),
      formatDate: (date: Date, timeZone: string, pattern: string) => {
        if (timeZone !== 'Asia/Singapore' || pattern !== 'yyyy-MM-dd HH:mm:ss') {
          throw new Error(`formatDate stand-in only knows SGT, got ${timeZone} ${pattern}`);
        }
        return new RealDate(date.getTime() + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
      },
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text: string) => ({ text, setMimeType: () => ({ text }) }),
    },
    Date: ScriptDate,
    JSON,
  };

  const context = createContext({ ...services });
  runInContext(readFileSync(CODE_GS_PATH, 'utf8'), context, { filename: 'Code.gs' });
  const fn = (name: string): ((...args: unknown[]) => unknown) => {
    const found = (context as Record<string, unknown>)[name];
    if (typeof found !== 'function') throw new Error(`Code.gs has no function ${name}`);
    return found as (...args: unknown[]) => unknown;
  };
  const answer = (output: unknown) => ({
    status: 200,
    json: JSON.parse((output as { text: string }).text) as unknown,
  });

  return {
    doPost: (body) => answer(fn('doPost')({ postData: { contents: body, type: 'text/plain' } })),
    doGet: () => answer(fn('doGet')({ parameter: {} })),
    votes: () => tabs.get('Votes'),
    holdLock: (held) => {
      lockHeld = held;
    },
    call: (name, ...args) => fn(name)(...args),
  };
}
