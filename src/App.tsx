import { useEffect, useState } from 'react';
import { event } from '../event.config';
import { toVoteError, type VoteError } from './domain/errors';
import { useRoute } from './router';
import { createVoteStore, type VoteStore } from './storage';
import { DemoBanner, Message, Spinner } from './ui/common';
import { AdminView } from './views/AdminView';
import { VoteView } from './views/VoteView';

export function App(): JSX.Element {
  const route = useRoute();
  const [store, setStore] = useState<VoteStore | null>(null);
  const [error, setError] = useState<VoteError | null>(null);

  useEffect(() => {
    let cancelled = false;
    createVoteStore()
      .then((created) => {
        if (!cancelled) setStore(created);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(toVoteError(caught));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    document.title = `Vote | ${event.title}`;
  }, []);

  if (error !== null) {
    return (
      <main className="voter">
        <Message tone="warn" title="Voting isn't set up yet">
          <p>{error.message}</p>
        </Message>
      </main>
    );
  }

  if (store === null) {
    return (
      <main className="voter">
        <Spinner label="Loading" />
      </main>
    );
  }

  return (
    <div className={`app app--${route.view}`}>
      {store.isDemo && <DemoBanner />}
      {route.view === 'admin' ? <AdminView store={store} /> : <VoteView store={store} />}
    </div>
  );
}
