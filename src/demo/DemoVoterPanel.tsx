import { useEffect, useState } from 'react';
import type { DemoClockPhase, DemoControls, VoteStore } from '../storage';

interface Props {
  store: VoteStore & DemoControls;
  /** Forgets this browser's "I voted" marker. */
  onForgetMarker: () => void;
  /** Puts an address in the vote form's email field. */
  onPrefillEmail: (email: string) => void;
  onChanged: () => void;
}

const CLOCK_LABEL: Record<DemoClockPhase, string> = {
  before: 'Before voting opens',
  during: 'During voting',
  after: 'After voting closes',
  real: "Today's real date",
};

/**
 * DEV ONLY. Loaded only in a demo build; a production build does not contain it.
 *
 * Lets someone clicking through the draft see the states that, for real, depend
 * on things one person with one browser cannot easily produce: a second voter,
 * a repeat email, and what day it is.
 */
export default function DemoVoterPanel({
  store,
  onForgetMarker,
  onPrefillEmail,
  onChanged,
}: Props): JSX.Element {
  const [lastSample, setLastSample] = useState(() => store.lastSampleEmail());
  const [clock, setClock] = useState<DemoClockPhase>(() => store.demoClock());
  const [note, setNote] = useState<string | null>(null);

  // The admin view's demo tools (possibly in another tab) can move these.
  useEffect(
    () =>
      store.subscribe(() => {
        setLastSample(store.lastSampleEmail());
        setClock(store.demoClock());
      }),
    [store],
  );

  const changeClock = async (phase: DemoClockPhase): Promise<void> => {
    await store.setDemoClock(phase);
    setClock(phase);
    setNote(`Pretend time moved: ${CLOCK_LABEL[phase].toLowerCase()}.`);
    onChanged();
  };

  return (
    <section className="panel panel--demo" aria-labelledby="demo-voter-heading">
      <div className="panel__head">
        <h2 id="demo-voter-heading">Demo controls</h2>
        <span className="hint">Simulated. Not part of the real site.</span>
      </div>

      <p className="hint">
        Made-up addresses at example.com, so nobody&apos;s real email goes into the demo. Each
        button also makes this browser forget it voted, as if a new person picked up the phone.
        Each visitor is on a simulated network, from a range reserved for documentation.
      </p>
      <div className="panel__actions">
        <button
          type="button"
          className="button button--ghost"
          onClick={() => {
            void store.nextSampleEmail().then((address) => {
              onForgetMarker();
              onPrefillEmail(address);
              setLastSample(address);
              setNote(`New visitor. ${address} is filled in: tap a contestant to vote with it.`);
              onChanged();
            });
          }}
        >
          New visitor, new email
        </button>
        <button
          type="button"
          className="button button--ghost"
          disabled={lastSample === null}
          onClick={() => {
            if (lastSample === null) return;
            onForgetMarker();
            onPrefillEmail(lastSample);
            setNote(
              `New visitor, same email: ${lastSample} is filled in again. If it has already voted, the vote is refused.`,
            );
            onChanged();
          }}
        >
          New visitor, same email
        </button>
        <button
          type="button"
          className="button button--ghost"
          onClick={() => {
            void store.nextSampleEmail({ sameNetwork: true }).then((address) => {
              onForgetMarker();
              onPrefillEmail(address);
              setLastSample(address);
              setNote(
                `New visitor on the same wifi: ${address} is filled in, on the same simulated network as the last visitor.`,
              );
              onChanged();
            });
          }}
        >
          New visitor, same wifi
        </button>
      </div>
      {lastSample !== null && (
        <p className="hint demo-row">
          Last sample address: <strong className="demo-email">{lastSample}</strong>
        </p>
      )}

      <p className="hint demo-row">Pretend the time is:</p>
      <div className="panel__actions panel__actions--tight">
        {(['before', 'during', 'after'] as const).map((phase) => (
          <button
            key={phase}
            type="button"
            className={`button button--ghost${clock === phase ? ' button--selected' : ''}`}
            aria-pressed={clock === phase}
            onClick={() => void changeClock(phase)}
          >
            {CLOCK_LABEL[phase]}
          </button>
        ))}
      </div>

      {note !== null && (
        <p className="notice notice--good" role="status">
          {note}
        </p>
      )}

      <p className="hint demo-row">
        <a href="#/admin">Open the admin view</a> (passcode <code>{store.demoPasscode}</code>)
      </p>
    </section>
  );
}
