import { useState } from 'react';
import { event } from '../../event.config';
import { browserStorage } from '../storage/keyValue';
import { clearVoteMarker } from '../storage/voteMarker';
import type { DemoControls, VoteStore } from '../storage';

interface Props {
  store: VoteStore & DemoControls;
  votingOpen: boolean;
  onChanged: () => void;
}

/** DEV ONLY. Loaded only in a demo build; a production build does not contain it. */
export default function DemoAdminPanel({ store, votingOpen, onChanged }: Props): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const run = async (action: () => Promise<string>): Promise<void> => {
    setBusy(true);
    try {
      setNote(await action());
    } catch {
      setNote('That did not work. Reset the demo and try again.');
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  return (
    <section className="panel panel--demo" aria-labelledby="demo-admin-heading">
      <div className="panel__head">
        <h2 id="demo-admin-heading">Demo tools</h2>
        <span className="hint">Simulated. Not part of the real site.</span>
      </div>
      {!votingOpen && (
        <p className="hint hint--warn">
          Voting is not open, so simulated votes would be rejected like real ones. Open voting, or
          set the pretend time to &quot;During voting&quot; on the voting page.
        </p>
      )}
      <div className="panel__actions">
        <button
          type="button"
          className="button button--ghost"
          disabled={busy || !votingOpen}
          onClick={() =>
            void run(async () => {
              const cast = await store.simulateVotes(60);
              return `Simulated ${cast} votes from ${cast} made-up email addresses.`;
            })
          }
        >
          Simulate 60 votes
        </button>
        <button
          type="button"
          className="button button--ghost"
          disabled={busy || !votingOpen}
          onClick={() =>
            void run(async () => {
              const cast = await store.simulateBurst(15);
              return `Simulated a burst: ${cast} votes for one contestant inside 3 minutes.`;
            })
          }
        >
          Simulate a burst
        </button>
        <button
          type="button"
          className="button button--ghost"
          disabled={busy || !votingOpen}
          onClick={() =>
            void run(async () => {
              const cast = await store.simulateSharedNetwork(12);
              return `Simulated ${cast} votes from ${cast} made-up voters on one simulated network.`;
            })
          }
        >
          Simulate 12 votes from one network
        </button>
        <button
          type="button"
          className="button button--ghost"
          disabled={busy}
          onClick={() => {
            if (!window.confirm('Reset all demo data?')) return;
            void run(async () => {
              await store.reset();
              clearVoteMarker(browserStorage(), event.id);
              return 'Demo data reset.';
            });
          }}
        >
          Reset demo
        </button>
      </div>
      {note !== null && (
        <p className="notice notice--good" role="status">
          {note}
        </p>
      )}
      <p className="hint demo-row">
        <a href="#/">Open the voting page</a>
      </p>
    </section>
  );
}
