import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { contestants, event } from '../../event.config';
import { DemoVoterPanel } from '../demo/lazy';
import { checkEmail, type EmailProblem } from '../domain/email';
import { toVoteError, type VoteError } from '../domain/errors';
import { newRequestId } from '../domain/requestId';
import { formatLongCalendarDate, formatSgtDateTime } from '../domain/time';
import type { Contestant, PublicSession, VotingStatus } from '../domain/types';
import { usePolling } from '../hooks/usePolling';
import { browserStorage } from '../storage/keyValue';
import { withRetry } from '../storage/retry';
import {
  clearVoteMarker,
  readVoteMarker,
  writeVoteMarker,
  type VoteMarker,
} from '../storage/voteMarker';
import { hasDemoControls, type VoteStore } from '../storage';
import { ContestantArt } from '../ui/ContestantArt';
import { Message, Sheet, Spinner, StatusPill } from '../ui/common';
import { KeyVisualBanner } from '../ui/KeyVisual';
import { PromoBannerSlot, PromoPopup } from '../ui/PromoBanner';

type CastState =
  | { phase: 'idle' }
  | { phase: 'sending'; attempt: number; contestant: Contestant; email: string }
  | { phase: 'counted'; replaced: boolean }
  | {
      phase: 'failed';
      error: VoteError;
      contestant: Contestant;
      email: string;
      requestId: string;
    };

const ATTEMPTS = 4;

const nameOf = (contestant: Contestant): string => `#${contestant.number} ${contestant.stageName}`;

const twoDigits = (value: number): string => String(value).padStart(2, '0');

/** "No. 07", then the optional tagline, then the optional handle. */
function labelLine(contestant: Contestant): string {
  return [`No. ${twoDigits(contestant.number)}`, contestant.tagline, contestant.handle]
    .filter((part): part is string => part !== undefined && part.trim() !== '')
    .join(' · ');
}

const EMAIL_PROBLEM: Record<EmailProblem, string> = {
  empty: 'Enter your email address to vote.',
  malformed: "That email address doesn't look right. Check it and try again.",
  too_long: 'That email address is too long.',
};

/**
 * The public voting page. Phone-first: most people arrive from a link inside
 * Instagram and see this in Instagram's own in-app browser.
 *
 * Nothing here decides whether a vote counts. The checks below only choose what
 * to show; the server makes the decision and this page reports it.
 */
export function VoteView({ store }: { store: VoteStore }): JSX.Element {
  const storage = useMemo(() => browserStorage(), []);
  const [marker, setMarker] = useState<VoteMarker | null>(() => readVoteMarker(storage, event.id));
  const [cast, setCast] = useState<CastState>({ phase: 'idle' });
  const [picked, setPicked] = useState<Contestant | null>(null);
  // Held for this page visit only, so a mistyped address can be fixed. Never
  // written to browser storage, and cleared once a vote is counted.
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const announcer = useRef<HTMLParagraphElement>(null);
  const grid = useRef<HTMLUListElement>(null);
  // Revision 10: the promo pops up once, straight after a vote is counted.
  const [promoOpen, setPromoOpen] = useState(false);
  const closePromo = useCallback(() => setPromoOpen(false), []);

  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const load = useCallback(() => store.getSession(), [store]);
  const polled = usePolling<PublicSession>(load, {
    intervalMs: 30_000,
    enabled: cast.phase !== 'sending',
    subscribe,
  });

  const session = polled.data;
  const status: VotingStatus = session?.state.status ?? 'not_open';
  const sending = cast.phase === 'sending';
  const voted = marker !== null;
  const canChange = session?.state.allowVoteChange === true;
  const canVote = status === 'open' && !sending && (!voted || canChange);

  const byId = useMemo(() => new Map(contestants.map((c) => [c.id, c])), []);
  const votedFor = marker === null ? undefined : byId.get(marker.contestantId);
  const tallies = useMemo(
    () => new Map((session?.tallies ?? []).map((tally) => [tally.contestantId, tally.votes])),
    [session],
  );

  // Another tab (or the demo controls) may have changed the marker since this page loaded.
  useEffect(() => {
    setMarker(readVoteMarker(storage, event.id));
  }, [session, storage]);

  // If voting closes while someone is mid-choice, put the sheet away.
  // A refusal from while voting was open no longer applies once it has closed.
  useEffect(() => {
    if (status !== 'open') {
      setPicked(null);
      setCast((current) => (current.phase === 'failed' ? { phase: 'idle' } : current));
    }
  }, [status]);

  const intro = useRef<HTMLElement>(null);
  useEffect(() => {
    if (cast.phase === 'counted') {
      // Revision 10: back up to the "Vote in!" message (the visitor voted from
      // somewhere down the grid), THEN the promo pops up over it. In that order,
      // so closing the pop-up hands focus back to the message, not the card.
      (intro.current?.closest('main') ?? intro.current)?.scrollIntoView({ block: 'start' });
      announcer.current?.focus({ preventScroll: true });
      setPromoOpen(true);
    } else if (cast.phase === 'failed') {
      announcer.current?.focus();
    }
  }, [cast.phase]);

  const openSheet = (contestant: Contestant): void => {
    setEmailError(null);
    setPicked(contestant);
  };

  const submit = useCallback(
    async (contestant: Contestant, address: string, requestId: string): Promise<void> => {
      setPicked(null);
      setCast({ phase: 'sending', attempt: 1, contestant, email: address });
      try {
        // Every retry carries the same request id, so a vote whose reply got lost
        // is recognised on the next try instead of being refused as a duplicate.
        const receipt = await withRetry(
          () => store.castVote(contestant.id, address, requestId),
          {
            attempts: ATTEMPTS,
            onRetry: (_error, nextAttempt) =>
              setCast({ phase: 'sending', attempt: nextAttempt, contestant, email: address }),
          },
        );
        const next = { contestantId: receipt.contestantId, votedAt: receipt.castAt };
        writeVoteMarker(storage, event.id, next);
        setMarker(next);
        setEmail('');
        setCast({ phase: 'counted', replaced: receipt.replaced });
      } catch (caught) {
        const error = toVoteError(caught);
        if (error.code === 'invalid_email') {
          // The server read the address differently from the page's own check.
          // Put the voter back where they can fix it.
          setCast({ phase: 'idle' });
          setEmailError(EMAIL_PROBLEM.malformed);
          setPicked(contestant);
          return;
        }
        setCast({ phase: 'failed', error, contestant, email: address, requestId });
      }
    },
    [store, storage],
  );

  const confirm = (formEvent: FormEvent<HTMLFormElement>, contestant: Contestant): void => {
    formEvent.preventDefault();
    const checked = checkEmail(email);
    if (!checked.ok) {
      setEmailError(EMAIL_PROBLEM[checked.problem]);
      return;
    }
    // Sent as typed (trimmed). The server decides what counts as the same voter,
    // and the audit record keeps both forms.
    void submit(contestant, email.trim(), newRequestId());
  };

  /**
   * The "I voted" marker belongs to this browser, not to a person. When a second
   * person uses the same phone, forgetting it lets them vote with their own
   * email. It gains nobody a second vote: the server still checks the email.
   */
  /** Revision 10: after voting, straight back to every contestant. */
  const showAllContestants = (): void => {
    setPromoOpen(false);
    grid.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    grid.current?.focus({ preventScroll: true });
  };

  const forgetThisBrowser = (): void => {
    clearVoteMarker(storage, event.id);
    setMarker(null);
    setCast({ phase: 'idle' });
  };

  const demoPanel =
    DemoVoterPanel !== null && hasDemoControls(store) ? (
      <Suspense fallback={null}>
        <DemoVoterPanel
          store={store}
          onForgetMarker={forgetThisBrowser}
          onPrefillEmail={(address) => {
            setEmail(address);
            setEmailError(null);
          }}
          onChanged={polled.refresh}
        />
      </Suspense>
    ) : null;

  if (session === null) {
    const error = polled.error;
    return (
      <VoteShell demoPanel={demoPanel}>
        {error === null ? (
          <Spinner label="Loading the contestants" />
        ) : error.code === 'unreachable' ? (
          <Message
            tone="warn"
            title="Can't reach the voting server"
            action={
              <button type="button" className="button" onClick={polled.refresh}>
                Try again
              </button>
            }
          >
            <p>Check your wifi or mobile data. We&apos;ll keep trying in the background.</p>
          </Message>
        ) : error.code === 'rate_limited' ? (
          <Message
            tone="warn"
            title="Lots of visits right now"
            action={
              <button type="button" className="button" onClick={polled.refresh}>
                Try again
              </button>
            }
          >
            <p>Give it a minute, then try again.</p>
          </Message>
        ) : (
          <Message tone="warn" title="Voting isn't set up yet">
            <p>Please check back soon.</p>
          </Message>
        )}
      </VoteShell>
    );
  }

  // Revision 10: the promo pops up after a vote. Before a vote it is not on the
  // page at all; once this browser has voted, or voting is not open, it also
  // sits at the bottom, under the contestants.
  const promoAtBottom = (voted || status !== 'open') && !sending;

  const opens = formatSgtDateTime(session.state.opensAt);
  const closes = formatSgtDateTime(session.state.closesAt);
  // Kelicia's wording, Revision 10.
  const top10Line = `Top ${event.advancing} will be announced ${formatLongCalendarDate(event.top10AnnouncedOn)}.`;
  const ruleLine = canChange
    ? 'You can switch until voting closes.'
    : 'One vote per person. It cannot be changed once you confirm.';

  return (
    <VoteShell status={status} offline={polled.error !== null} demoPanel={demoPanel}>
      <header ref={intro} className="voter__intro">
        <h1>
          {sending
            ? 'Sending your vote'
            : status === 'closed'
              ? 'Voting has closed'
              : status === 'not_open'
                ? 'Voting opens soon'
                : voted
                  ? 'Vote in!'
                  : `Who makes the Top ${event.advancing}?`}
        </h1>
        <p className="voter__lede">
          {sending && (
            <>Sending your vote for {nameOf(cast.contestant)}. Keep this page open for a moment.</>
          )}
          {!sending && status === 'closed' && (
            <>
              {votedFor !== undefined && <>Your vote for {nameOf(votedFor)} is in. </>}
              {top10Line}
            </>
          )}
          {!sending && status === 'not_open' && (
            <>
              {opens !== '' ? <>Voting opens {opens}. </> : <>Voting isn&apos;t open yet. </>}
              Meet the {contestants.length} contestants while you wait.
            </>
          )}
          {!sending && status === 'open' && voted && (
            <>
              {votedFor !== undefined ? (
                <>You voted for {nameOf(votedFor)}. </>
              ) : (
                <>Your vote is in. </>
              )}
              {canChange ? 'Changed your mind? You can switch until voting closes.' : top10Line}
            </>
          )}
          {!sending && status === 'open' && !voted && (
            <>
              Vote your favourite lookalike now!
              {closes !== '' && <> Voting closes {closes}.</>}
            </>
          )}
        </p>
        {!sending && status === 'open' && !voted && <p className="voter__rule">{ruleLine}</p>}
        {!sending && status === 'open' && voted && (
          <button type="button" className="button button--wide voter__see-all" onClick={showAllContestants}>
            See all contestants
          </button>
        )}
        {!sending && status === 'open' && voted && !canChange && (
          <button type="button" className="text-button" onClick={forgetThisBrowser}>
            Someone else voting on this phone? Vote with their email
          </button>
        )}
      </header>

      <p
        ref={announcer}
        tabIndex={-1}
        className={`voter__save voter__save--${cast.phase}`}
        role="status"
        aria-live="polite"
      >
        {cast.phase === 'sending' && cast.attempt === 1 && 'Sending...'}
        {cast.phase === 'sending' &&
          cast.attempt > 1 &&
          `Connection is slow. Trying again (attempt ${cast.attempt} of ${ATTEMPTS})...`}
        {cast.phase === 'counted' &&
          (cast.replaced
            ? 'Done. Your new vote replaced your earlier one.'
            : 'Done. Your vote is counted.')}
        {cast.phase === 'failed' && <CastFailure error={cast.error} />}
      </p>
      {cast.phase === 'failed' && cast.error.retryable && status === 'open' && (
        <button
          type="button"
          className="button button--vote button--wide"
          onClick={() => void submit(cast.contestant, cast.email, cast.requestId)}
        >
          Try sending again
        </button>
      )}

      <ul ref={grid} className="grid" aria-label="Contestants" tabIndex={-1}>
        {contestants.map((contestant) => {
          const chosen = marker?.contestantId === contestant.id;
          return (
            <li key={contestant.id} className={`card${chosen ? ' card--chosen' : ''}`}>
              <button
                type="button"
                className="card__face"
                disabled={!canVote}
                aria-pressed={chosen}
                onClick={() => openSheet(contestant)}
              >
                <span className="card__art">
                  <ContestantArt contestant={contestant} />
                </span>
                {/* Decorative: the number is already in the label line below. */}
                <span className="card__numeral" aria-hidden="true">
                  {twoDigits(contestant.number)}
                </span>
                {chosen && <span className="card__badge">Your vote</span>}
                <span className="card__caption">
                  <span className="card__stage">{contestant.stageName}</span>
                  <span className="card__label">{labelLine(contestant)}</span>
                  {session.tallies !== null && (
                    <span className="card__count">
                      {(tallies.get(contestant.id) ?? 0).toLocaleString('en-SG')}{' '}
                      {tallies.get(contestant.id) === 1 ? 'vote' : 'votes'}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {promoAtBottom && <PromoBannerSlot placement="bottom" />}


      <Sheet open={picked !== null} onClose={() => setPicked(null)} labelledBy="confirm-title">
        {picked !== null && (
          <>
            <div className="sheet__art">
              <ContestantArt contestant={picked} compact />
            </div>
            {voted && marker?.contestantId === picked.id ? (
              <>
                <h2 id="confirm-title">You&apos;ve already voted for {nameOf(picked)}</h2>
                <p>Nothing to change. Pick someone else if you want to switch.</p>
                <div className="sheet__actions">
                  <button
                    type="button"
                    className="button button--ghost button--wide"
                    onClick={() => setPicked(null)}
                  >
                    Back
                  </button>
                </div>
              </>
            ) : (
              <form noValidate onSubmit={(formEvent) => confirm(formEvent, picked)}>
                <h2 id="confirm-title">
                  {voted ? `Switch your vote to ${nameOf(picked)}?` : `Vote for ${nameOf(picked)}?`}
                </h2>
                <p>{ruleLine}</p>
                <div className="field">
                  <label htmlFor="voter-email">Your email</label>
                  <input
                    id="voter-email"
                    name="email"
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    enterKeyHint="send"
                    maxLength={254}
                    autoFocus
                    value={email}
                    aria-invalid={emailError !== null}
                    aria-describedby={emailError !== null ? 'voter-email-error' : undefined}
                    onChange={(changeEvent) => {
                      setEmail(changeEvent.target.value);
                      if (emailError !== null) setEmailError(null);
                    }}
                  />
                  {emailError !== null && (
                    <p id="voter-email-error" className="field__error" role="alert">
                      {emailError}
                    </p>
                  )}
                </div>
                <div className="sheet__actions">
                  <button type="submit" className="button button--vote button--wide">
                    {voted ? 'Switch my vote' : 'Confirm vote'}
                  </button>
                  <button
                    type="button"
                    className="button button--ghost button--wide"
                    onClick={() => setPicked(null)}
                  >
                    Back
                  </button>
                </div>
              </form>
            )}
          </>
        )}
      </Sheet>

      <PromoPopup open={promoOpen && cast.phase === 'counted'} onClose={closePromo} />
    </VoteShell>
  );
}

function CastFailure({ error }: { error: VoteError }): JSX.Element {
  switch (error.code) {
    case 'duplicate_vote':
      return <>A vote has already been counted for this email.</>;
    case 'voting_closed':
      return <>Voting closed before your vote could be counted.</>;
    case 'voting_not_open':
      return <>Voting isn&apos;t open yet, so that wasn&apos;t counted.</>;
    case 'rate_limited':
      return <>Too many attempts. Wait a minute, then try again.</>;
    case 'invalid_vote':
      return <>That vote couldn&apos;t be counted. Please choose again.</>;
    case 'unreachable':
      return (
        <>
          Not sent: we couldn&apos;t reach the voting server. Your vote has not been counted yet.
        </>
      );
    default:
      return <>That didn&apos;t go through. Please try again later.</>;
  }
}

function VoteShell({
  children,
  status,
  offline = false,
  demoPanel,
}: {
  children: ReactNode;
  status?: VotingStatus;
  offline?: boolean;
  demoPanel: ReactNode;
}): JSX.Element {
  // Revision 10: the key visual sits outside the padded column, edge to edge,
  // and the brand line under it is gone (the key visual carries the title).
  return (
    <>
      <KeyVisualBanner />
      <main className="voter">
        {status !== undefined && (
          <div className="voter__top">
            <StatusPill status={status} />
          </div>
        )}
      {offline && (
        <p className="offline" role="status">
          Connection lost. Reconnecting...
        </p>
      )}
        {children}
        {demoPanel}
      </main>
    </>
  );
}
