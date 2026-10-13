/**
 * Turns event.config.ts into the SQL that configures the database: contestants,
 * voting window and voting rules.
 *
 *   npm run seed:sql
 *
 * Writes supabase/seed-event.sql. Re-run and re-apply whenever the contestants,
 * the window or the rules change. It never touches votes or the open/closed
 * state. It contains no secrets: the admin passcode and the hashing secret are
 * environment variables on the server function, not database rows.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { contestants, votingRules, votingWindow } from '../event.config';
import { effectiveStatus } from '../src/domain/voting';
import { fail, parseArgs, sqlString } from './lib';

function timestampOrNull(value: string | null): string {
  return value === null ? 'null' : `${sqlString(value)}::timestamptz`;
}

export function buildSeedSql(): string {
  // Throws on a date it cannot read, so a typo is caught here and not by voters.
  effectiveStatus('pending', votingWindow, new Date());

  for (const [field, value] of Object.entries(votingWindow)) {
    if (typeof value === 'string' && !/(Z|[+-]\d{2}:\d{2})$/.test(value)) {
      throw new Error(
        `votingWindow.${field} ("${value}") has no time zone. Write it with +08:00 for Singapore time.`,
      );
    }
  }

  const ids = new Set<string>();
  const numbers = new Set<number>();
  for (const contestant of contestants) {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(contestant.id)) {
      throw new Error(`Contestant id "${contestant.id}" must be lower-case letters, digits, - or _.`);
    }
    if (ids.has(contestant.id)) throw new Error(`Duplicate contestant id "${contestant.id}".`);
    if (numbers.has(contestant.number)) {
      throw new Error(`Two contestants share the number ${contestant.number}.`);
    }
    ids.add(contestant.id);
    numbers.add(contestant.number);
  }

  return `-- Event settings and contestants, generated from event.config.ts.
-- Run in the SQL editor AFTER schema.sql. Safe to re-run.
-- Does not touch votes or the open/closed state. Contains no secrets.

insert into public.contestants (id, number, stage_name, sort_order) values
${contestants
  .map((c, index) => `  (${sqlString(c.id)}, ${c.number}, ${sqlString(c.stageName)}, ${index + 1})`)
  .join(',\n')}
on conflict (id) do update
  set number = excluded.number,
      stage_name = excluded.stage_name,
      sort_order = excluded.sort_order;

-- Contestants removed from the config are NOT deleted here, because votes may
-- already point at them. Review this list by hand before voting opens:
--   select id, stage_name from public.contestants
--    where id not in (${contestants.map((c) => sqlString(c.id)).join(', ')});

update public.event_settings
   set opens_at              = ${timestampOrNull(votingWindow.opensAt)},
       closes_at             = ${timestampOrNull(votingWindow.closesAt)},
       auto_open             = ${votingWindow.autoOpen ? 'true' : 'false'},
       allow_vote_change     = ${votingRules.allowVoteChange ? 'true' : 'false'},
       public_counts         = ${votingRules.publicCounts ? 'true' : 'false'},
       updated_at            = now()
 where id = 1;
`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(args.get('out') ?? 'supabase');

  let sql: string;
  try {
    sql = buildSeedSql();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  mkdirSync(outDir, { recursive: true });
  const file = resolve(outDir, 'seed-event.sql');
  writeFileSync(file, sql);

  console.log(`Wrote ${file}`);
  console.log(`  ${contestants.length} contestants`);
  console.log(`  window: ${votingWindow.opensAt ?? 'no start'} to ${votingWindow.closesAt ?? 'no end'}`);
  console.log(
    `  rules: one vote per email, ` +
      `changing a vote ${votingRules.allowVoteChange ? 'allowed' : 'not allowed'}, ` +
      `public counts ${votingRules.publicCounts ? 'shown' : 'hidden'}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
