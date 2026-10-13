import { tallyVotes } from './analytics';
import { formatSgtStamp } from './time';
import type { AdminSnapshot, AuditRow, Contestant, Standing } from './types';
import { rankTallies, standings } from './voting';

type Cell = string | number;

/**
 * Spreadsheets treat a cell starting with = + - @ (or tab / CR) as a formula.
 * Stage names and, in the audit export, email addresses are typed in by people
 * (the emails by the public), so neutralise them before they reach Excel or
 * Sheets: a leading apostrophe makes the cell plain text.
 */
function neutraliseFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function escapeCell(cell: Cell): string {
  const text = typeof cell === 'number' ? String(cell) : neutraliseFormula(cell);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: readonly string[], rows: readonly (readonly Cell[])[]): string {
  return [header, ...rows].map((row) => row.map(escapeCell).join(',')).join('\r\n') + '\r\n';
}

const STANDING_LABEL: Record<Standing, string> = {
  advancing: 'yes',
  tied_at_cut: 'tie at the cut',
  out: 'no',
};

/** One row per contestant, ranked. This is the tally to publish. */
export function tallyCsv(
  snapshot: AdminSnapshot,
  contestants: readonly Contestant[],
  places: number,
): string {
  const byId = new Map(contestants.map((c) => [c.id, c]));
  const ranked = rankTallies(
    tallyVotes(
      snapshot.votes,
      contestants.map((c) => c.id),
    ),
  );
  const standing = standings(ranked, places);
  return toCsv(
    ['rank', 'tied', `in_top_${places}_on_votes`, 'contestant_number', 'contestant_id', 'stage_name', 'votes'],
    ranked.map((row) => {
      const contestant = byId.get(row.contestantId);
      return [
        row.rank,
        row.tied ? 'yes' : 'no',
        STANDING_LABEL[standing.get(row.contestantId) ?? 'out'],
        contestant?.number ?? '',
        row.contestantId,
        contestant?.stageName ?? '',
        row.votes,
      ];
    }),
  );
}

/** One row per vote received, oldest first. The audit trail behind the tally. */
export function votesCsv(snapshot: AdminSnapshot, contestants: readonly Contestant[]): string {
  const byId = new Map(contestants.map((c) => [c.id, c]));
  return toCsv(
    [
      'vote_id',
      'cast_at_sgt',
      'cast_at_utc',
      'contestant_number',
      'contestant_id',
      'stage_name',
      'status',
      'replaced_at_sgt',
      'voter_ref',
    ],
    snapshot.votes.map((vote) => {
      const contestant = byId.get(vote.contestantId);
      return [
        vote.id,
        formatSgtStamp(vote.castAt),
        new Date(vote.castAt).toISOString(),
        contestant?.number ?? '',
        vote.contestantId,
        contestant?.stageName ?? '',
        vote.replacedAt === null ? 'counted' : 'replaced',
        formatSgtStamp(vote.replacedAt),
        vote.voterRef,
      ];
    }),
  );
}

/**
 * CONFIDENTIAL AUDIT EXPORT (Revision 5). Readable emails and IP addresses.
 * A different file from the two above on purpose: the tally is published, this
 * never is. Every cell goes through the same formula neutralising and quoting.
 */
export function auditCsv(rows: readonly AuditRow[], contestants: readonly Contestant[]): string {
  const byId = new Map(contestants.map((c) => [c.id, c]));
  return toCsv(
    [
      'vote_id',
      'cast_at_sgt',
      'contestant_number',
      'stage_name',
      'status',
      'email_as_typed',
      'email_normalised',
      'ip_address',
      'ip_source',
      'votes_from_this_ip',
    ],
    rows.map((row) => {
      const contestant = byId.get(row.contestantId);
      return [
        row.voteId,
        formatSgtStamp(row.castAt),
        contestant?.number ?? '',
        contestant?.stageName ?? '',
        row.replacedAt === null ? 'counted' : 'replaced',
        row.emailTyped,
        row.emailNormalised,
        row.ip,
        row.ipSource,
        row.votesFromIp,
      ];
    }),
  );
}
