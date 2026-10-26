import { Suspense, useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { burstRule, event, sharedAddressRule } from '../../event.config';
import { useContestants } from '../contestants';
import { recallPasscode, rememberPasscode } from '../organiser';
import { DemoAdminPanel } from '../demo/lazy';
import { detectBursts, tallyVotes, volumeTimeline } from '../domain/analytics';
import { auditCsv, tallyCsv, votesCsv } from '../domain/csv';
import { toVoteError, type VoteError } from '../domain/errors';
import { formatSgtDateTime, formatSgtShort } from '../domain/time';
import type { AdminSnapshot, AdminStatus } from '../domain/types';
import { rankTallies, standings } from '../domain/voting';
import { usePolling } from '../hooks/usePolling';
import { hasDemoControls, type VoteStore } from '../storage';
import { Brand, Message, Spinner, StatusPill } from '../ui/common';
import { VolumeChart } from '../ui/VolumeChart';


function downloadCsv(filename: string, csv: string): void {
  // The BOM makes Excel read the file as UTF-8, so stage names with accents survive.
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fileStamp(iso: string): string {
  return iso.replace(/[:.]/g, '-').slice(0, 19);
}

export function AdminView({ store }: { store: VoteStore }): JSX.Element {
  const [passcode, setPasscode] = useState<string | null>(() => recallPasscode());

  const lock = useCallback((): void => {
    rememberPasscode(null);
    setPasscode(null);
  }, []);

  return (
    <main className="admin">
      <div className="admin__top">
        <Brand />
        {passcode !== null && (
          <span className="admin__top-actions">
            {store.supportsOrganiserTest === true && (
              <a className="button button--ghost" href="#/">
                Cast a test vote
              </a>
            )}
            <button type="button" className="button button--ghost" onClick={lock}>
              Lock
            </button>
          </span>
        )}
      </div>
      <h1>Voting admin</h1>
      {passcode === null ? (
        <PasscodeGate
          store={store}
          onUnlock={(value) => {
            rememberPasscode(value);
            setPasscode(value);
          }}
        />
      ) : (
        <Dashboard store={store} passcode={passcode} onLocked={lock} />
      )}
    </main>
  );
}

function PasscodeGate({
  store,
  onUnlock,
}: {
  store: VoteStore;
  onUnlock: (passcode: string) => void;
}): JSX.Element {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<VoteError | null>(null);

  const submit = async (submitEvent: FormEvent): Promise<void> => {
    submitEvent.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await store.adminGetSnapshot(value);
      onUnlock(value);
    } catch (caught) {
      setError(toVoteError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel gate" onSubmit={(submitEvent) => void submit(submitEvent)}>
      <label htmlFor="passcode">Admin passcode</label>
      <input
        id="passcode"
        type="password"
        autoComplete="off"
        value={value}
        onChange={(changeEvent) => setValue(changeEvent.target.value)}
        aria-describedby={error !== null ? 'passcode-error' : undefined}
        aria-invalid={error !== null}
        autoFocus
      />
      {hasDemoControls(store) && (
        <p className="hint">
          Demo passcode: <code>{store.demoPasscode}</code>
        </p>
      )}
      {error !== null && (
        <p id="passcode-error" className="error" role="alert">
          {error.code === 'bad_passcode'
            ? "That passcode isn't right."
            : error.code === 'unreachable'
              ? "Can't reach the voting server. Check the connection and try again."
              : error.code === 'rate_limited'
                ? 'Too many attempts. Wait a minute and try again.'
                : error.message}
        </p>
      )}
      <button type="submit" className="button" disabled={busy || value.length === 0}>
        {busy ? 'Checking...' : 'Unlock'}
      </button>
    </form>
  );
}

type Pending = 'open' | 'close' | 'export' | null;

function Dashboard({
  store,
  passcode,
  onLocked,
}: {
  store: VoteStore;
  passcode: string;
  onLocked: () => void;
}): JSX.Element {
  const contestants = useContestants();
  const [pending, setPending] = useState<Pending>(null);
  const [notice, setNotice] = useState<{ tone: 'good' | 'warn'; text: string } | null>(null);

  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const load = useCallback(() => store.adminGetSnapshot(passcode), [store, passcode]);
  const { data, error, refresh } = usePolling<AdminSnapshot>(load, { intervalMs: 5000, subscribe });

  useEffect(() => {
    if (error?.code === 'bad_passcode') onLocked();
  }, [error, onLocked]);

  const byId = useMemo(() => new Map(contestants.map((c) => [c.id, c])), [contestants]);

  const derived = useMemo(() => {
    if (data === null) return null;
    const ranked = rankTallies(
      tallyVotes(
        data.votes,
        contestants.map((c) => c.id),
      ),
    );
    const counted = data.votes.filter((vote) => vote.replacedAt === null);

    const first = data.votes[0];
    const from = new Date(data.state.opensAt ?? first?.castAt ?? data.takenAt);
    const closesAt = data.state.closesAt === null ? null : new Date(data.state.closesAt);
    const taken = new Date(data.takenAt);
    const to = closesAt !== null && closesAt < taken ? closesAt : taken;
    // Hourly while it fits on the chart; three-hourly for a long window.
    const bucketMinutes = to.getTime() - from.getTime() > 100 * 3_600_000 ? 180 : 60;

    return {
      ranked,
      standing: standings(ranked, event.advancing),
      counted: counted.length,
      replaced: data.votes.length - counted.length,
      bucketMinutes,
      timeline: volumeTimeline(data.votes, { bucketMinutes, from, to }),
      bursts: detectBursts(data.votes, burstRule),
      // Counts and contestants only. The admin view never receives an address.
      sharedAddresses: data.sharedAddresses.filter((group) => group.votes >= sharedAddressRule.votes),
    };
  }, [data, contestants]);

  const act = async (kind: Exclude<Pending, null>, action: () => Promise<string>): Promise<void> => {
    setPending(kind);
    setNotice(null);
    try {
      setNotice({ tone: 'good', text: await action() });
    } catch (caught) {
      const voteError = toVoteError(caught);
      if (voteError.code === 'bad_passcode') {
        onLocked();
        return;
      }
      setNotice({
        tone: 'warn',
        text:
          voteError.code === 'unreachable'
            ? "That didn't go through: the voting server can't be reached. Nothing was changed. Try again."
            : voteError.message,
      });
    } finally {
      setPending(null);
      refresh();
    }
  };

  const setStatus = (status: AdminStatus, kind: 'open' | 'close', done: string): Promise<void> =>
    act(kind, async () => {
      await store.adminSetStatus(passcode, status);
      return done;
    });

  if (data === null || derived === null) {
    return error !== null && error.code !== 'bad_passcode' ? (
      <Message
        tone="warn"
        title="Can't load the admin view"
        action={
          <button type="button" className="button" onClick={refresh}>
            Try again
          </button>
        }
      >
        <p>{error.message}</p>
      </Message>
    ) : (
      <Spinner label="Loading the numbers" />
    );
  }

  const { state } = data;
  // Contestants level on zero are not a tie worth raising: the vote has barely started.
  const tiedAtCut = derived.ranked.filter(
    (row) => derived.standing.get(row.contestantId) === 'tied_at_cut' && row.votes > 0,
  );
  const withVotes = derived.ranked.filter((row) => row.votes > 0).length;
  const opens = formatSgtDateTime(state.opensAt);
  const closes = formatSgtDateTime(state.closesAt);
  const pausedInsideWindow = state.adminStatus === 'closed' && state.status === 'closed';
  const heldByWindow = state.adminStatus === 'open' && state.status === 'not_open';
  const closedByWindow = state.adminStatus !== 'closed' && state.status === 'closed';

  return (
    <>
      {error !== null && (
        <p className="offline" role="status">
          Connection lost. Showing the last numbers received. Reconnecting...
        </p>
      )}
      {notice !== null && (
        <p className={`notice notice--${notice.tone}`} role="status">
          {notice.text}
        </p>
      )}

      <section className="panel" aria-labelledby="voting-heading">
        <div className="panel__head">
          <h2 id="voting-heading">Voting</h2>
          <StatusPill status={state.status} />
        </div>
        <dl className="facts">
          <div>
            <dt>Opens</dt>
            <dd>{opens === '' ? 'No opening time set' : opens}</dd>
          </div>
          <div>
            <dt>Closes</dt>
            <dd>{closes === '' ? 'No closing time set' : closes}</dd>
          </div>
          <div>
            <dt>Votes per email</dt>
            <dd>1</dd>
          </div>
          <div>
            <dt>Changing a vote</dt>
            <dd>{state.allowVoteChange ? 'Allowed' : 'Not allowed'}</dd>
          </div>
          <div>
            <dt>Counts on the public page</dt>
            <dd>{state.publicCounts ? 'Shown' : 'Hidden'}</dd>
          </div>
        </dl>
        <p className="hint">
          {state.adminStatus === 'pending'
            ? 'Following the schedule: voting opens and closes by itself at the times above.'
            : 'Open and Close work inside the scheduled window. To move the window itself, change event.config.ts and re-apply the seed.'}
        </p>
        {closedByWindow && (
          <p className="hint hint--warn">
            Voting is past its closing time ({closes}), so it is closed.
          </p>
        )}
        {heldByWindow && (
          <p className="hint hint--warn">
            You pressed Open, but the window does not start until {opens}. Nobody can vote until
            then.
          </p>
        )}
        {pausedInsideWindow && (
          <p className="hint hint--warn">Voting was closed from this page.</p>
        )}
        <div className="panel__actions">
          <button
            type="button"
            className="button"
            disabled={pending !== null || state.adminStatus === 'open' || closedByWindow}
            onClick={() => {
              if (
                state.adminStatus === 'closed' &&
                !window.confirm('Voting was closed. Reopen it? People will be able to vote again.')
              ) {
                return;
              }
              void setStatus('open', 'open', 'Voting is set to open.');
            }}
          >
            {pending === 'open'
              ? 'Opening...'
              : state.adminStatus === 'closed'
                ? 'Reopen voting'
                : 'Open voting'}
          </button>
          <button
            type="button"
            className="button button--danger"
            disabled={pending !== null || state.status === 'closed'}
            onClick={() => {
              if (!window.confirm('Close voting? No more votes will be accepted.')) return;
              void setStatus('closed', 'close', 'Voting is closed.');
            }}
          >
            {pending === 'close' ? 'Closing...' : 'Close voting'}
          </button>
        </div>
      </section>

      <section className="panel" aria-labelledby="tally-heading">
        <div className="panel__head">
          <h2 id="tally-heading">Tally and ranking</h2>
          <span className="hint">Updates every few seconds</span>
        </div>
        <p className="stats">
          <span>
            <strong>{derived.counted.toLocaleString('en-SG')}</strong>{' '}
            {derived.counted === 1 ? 'vote counted' : 'votes counted'}
          </span>
          {derived.replaced > 0 && (
            <span>
              <strong>{derived.replaced.toLocaleString('en-SG')}</strong> replaced
            </span>
          )}
        </p>
        {withVotes < event.advancing && (
          <p className="hint">
            {withVotes === 0
              ? 'No votes yet.'
              : `Only ${withVotes} of ${contestants.length} contestants have a vote so far, so there is no Top ${event.advancing} yet.`}
          </p>
        )}
        {tiedAtCut.length > 0 && (
          <p className="flag" role="note">
            <span className="flag__icon" aria-hidden="true">
              !
            </span>
            <span>
              <strong>Tie at the Top {event.advancing} cut.</strong>{' '}
              {tiedAtCut.map((row) => `#${byId.get(row.contestantId)?.number ?? '?'}`).join(', ')}{' '}
              are level on {tiedAtCut[0]?.votes ?? 0}{' '}
              {tiedAtCut[0]?.votes === 1 ? 'vote' : 'votes'}. The votes cannot separate them: that
              is a call for the panel.
            </span>
          </p>
        )}
        <table className="preview ranking">
          <caption className="visually-hidden">Votes per contestant, highest first</caption>
          <thead>
            <tr>
              <th scope="col">Rank</th>
              <th scope="col">Contestant</th>
              <th scope="col" className="ranking__bar-head">
                <span className="visually-hidden">Share of the leader&apos;s votes</span>
              </th>
              <th scope="col" className="preview__num">
                Votes
              </th>
            </tr>
          </thead>
          <tbody>
            {derived.ranked.map((row, index) => {
              const contestant = byId.get(row.contestantId);
              const standing = derived.standing.get(row.contestantId) ?? 'out';
              const lastInside = index === event.advancing - 1;
              return (
                <tr
                  key={row.contestantId}
                  className={`ranking__row ranking__row--${standing}${lastInside ? ' ranking__row--cut' : ''}`}
                >
                  <td>
                    {row.rank}
                    {row.tied && row.votes > 0 ? ' (tie)' : ''}
                  </td>
                  <td>
                    #{contestant?.number} {contestant?.stageName}
                    {standing === 'tied_at_cut' && row.votes > 0 && (
                      <span className="ranking__note"> tie at the cut</span>
                    )}
                  </td>
                  <td className="ranking__bar-cell">
                    <span className="ranking__bar" aria-hidden="true">
                      <span
                        className="ranking__fill"
                        style={{ width: `${Math.round(row.share * 100)}%` }}
                      />
                    </span>
                  </td>
                  <td className="preview__num">{row.votes.toLocaleString('en-SG')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="hint">
          The line marks the Top {event.advancing} on votes alone. The final {event.advancing} are
          confirmed by the organisers after the eligibility check.
        </p>
      </section>

      <section className="panel" aria-labelledby="volume-heading">
        <div className="panel__head">
          <h2 id="volume-heading">
            Votes received per {derived.bucketMinutes === 60 ? 'hour' : '3 hours'}
          </h2>
          <span className="hint">Singapore time</span>
        </div>
        <VolumeChart buckets={derived.timeline} bucketMinutes={derived.bucketMinutes} />
      </section>

      <section className="panel" aria-labelledby="burst-heading">
        <div className="panel__head">
          <h2 id="burst-heading">Burst flags</h2>
          <span className="hint">
            {burstRule.votes}+ votes for one contestant within {burstRule.windowMinutes} minutes
          </span>
        </div>
        {derived.bursts.length === 0 ? (
          <p className="hint">Nothing flagged.</p>
        ) : (
          <ul className="flags">
            {derived.bursts.map((burst) => {
              const contestant = byId.get(burst.contestantId);
              return (
                <li key={`${burst.contestantId}-${burst.firstVoteAt}`} className="flag">
                  <span className="flag__icon" aria-hidden="true">
                    !
                  </span>
                  <span>
                    <strong>
                      #{contestant?.number} {contestant?.stageName}
                    </strong>{' '}
                    received {burst.votes} votes between {formatSgtShort(burst.firstVoteAt)} and{' '}
                    {formatSgtShort(burst.lastVoteAt)}.
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <p className="hint">
          A flag is a reason to look, not proof of anything: a contestant sharing the link with a
          large following causes a real burst. Nothing is removed or discounted automatically.
        </p>
      </section>

      <section className="panel" aria-labelledby="shared-heading">
        <div className="panel__head">
          <h2 id="shared-heading">Many votes from one network</h2>
          <span className="hint">{sharedAddressRule.votes}+ votes from one IP address</span>
        </div>
        {derived.sharedAddresses.length === 0 ? (
          <p className="hint">Nothing flagged.</p>
        ) : (
          <ul className="flags">
            {derived.sharedAddresses.map((group, index) => (
              <li key={index} className="flag">
                <span className="flag__icon" aria-hidden="true">
                  !
                </span>
                <span>
                  <strong>{group.votes} votes</strong> came from one network:{' '}
                  {group.contestants
                    .map((entry) => {
                      const contestant = byId.get(entry.contestantId);
                      return `#${contestant?.number ?? '?'} ${contestant?.stageName ?? entry.contestantId} (${entry.votes})`;
                    })
                    .join(', ')}
                  .
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="hint">
          Offices, campuses, cafes and mobile networks put many different people behind one address,
          so this is common and often entirely genuine. A reason to look, not a finding. No vote is
          ever refused or removed because of its network, and the address itself is only in the
          confidential export below.
        </p>
      </section>

      <section className="panel" aria-labelledby="export-heading">
        <div className="panel__head">
          <h2 id="export-heading">Export</h2>
        </div>
        {state.status !== 'closed' && (
          <p className="hint hint--warn">
            Voting has not closed, so anything exported now is not final.
          </p>
        )}
        <div className="panel__actions">
          <button
            type="button"
            className="button button--ghost"
            disabled={pending !== null}
            onClick={() =>
              void act('export', async () => {
                const snapshot = await store.adminGetSnapshot(passcode);
                downloadCsv(
                  `top${event.advancing}-tally-${fileStamp(snapshot.takenAt)}.csv`,
                  tallyCsv(snapshot, contestants, event.advancing),
                );
                return 'Downloaded the tally.';
              })
            }
          >
            Tally per contestant (CSV)
          </button>
          <button
            type="button"
            className="button button--ghost"
            disabled={pending !== null}
            onClick={() =>
              void act('export', async () => {
                const snapshot = await store.adminGetSnapshot(passcode);
                downloadCsv(
                  `vote-log-${fileStamp(snapshot.takenAt)}.csv`,
                  votesCsv(snapshot, contestants),
                );
                return `Downloaded ${snapshot.votes.length} vote rows.`;
              })
            }
          >
            Every vote, with timestamps (CSV)
          </button>
        </div>
        <p className="hint">
          The tally is the file to publish. The vote log is the audit trail: one row per vote, with
          its time and a short voter reference (the start of a scrambled code made from the email).
          It holds no email addresses, names or IP addresses.
        </p>
      </section>

      <section className="panel panel--confidential" aria-labelledby="audit-heading">
        <div className="panel__head">
          <h2 id="audit-heading">Confidential audit export</h2>
          <span className="hint">Not for publishing</span>
        </div>
        <p className="hint">
          Every vote with the email as typed, the email as counted, and the IP address the hosting
          platform reported. For the organisers&apos; own checks only: never publish or share it.
          Emails are unverified: they show what was typed, not who typed it. Nothing from this file
          is shown on screen.
        </p>
        <div className="panel__actions">
          <button
            type="button"
            className="button button--ghost"
            disabled={pending !== null}
            onClick={() =>
              void act('export', async () => {
                const rows = await store.adminGetAudit(passcode);
                downloadCsv(
                  `vote-audit-CONFIDENTIAL-${fileStamp(new Date().toISOString())}.csv`,
                  auditCsv(rows, contestants),
                );
                return `Downloaded the confidential audit export (${rows.length} rows).`;
              })
            }
          >
            Audit export: emails and IP addresses (CSV)
          </button>
        </div>
      </section>

      {DemoAdminPanel !== null && hasDemoControls(store) && (
        <Suspense fallback={null}>
          <DemoAdminPanel store={store} votingOpen={state.status === 'open'} onChanged={refresh} />
        </Suspense>
      )}
    </>
  );
}
