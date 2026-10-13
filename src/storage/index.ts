import { VoteError } from '../domain/errors';
import type { VoteStore } from './VoteStore';

export type { VoteStore, DemoControls, DemoClockPhase } from './VoteStore';
export { hasDemoControls } from './VoteStore';

/**
 * Builds the store named by VITE_STORAGE_ADAPTER.
 *
 * The adapters are loaded with dynamic imports inside a branch on a build-time
 * constant. Vite inlines the constant, the dead branch is removed, and an `api`
 * build therefore contains no demo store and no demo passcode.
 * (`npm run test:e2e` builds both and checks the production bundle for leaks.)
 */
export async function createVoteStore(): Promise<VoteStore> {
  if (import.meta.env.VITE_STORAGE_ADAPTER === 'api') {
    const { ApiVoteStore } = await import('./apiStore');
    return new ApiVoteStore({ baseUrl: import.meta.env.VITE_API_BASE_URL ?? '/api' });
  }

  if (
    import.meta.env.VITE_STORAGE_ADAPTER !== undefined &&
    import.meta.env.VITE_STORAGE_ADAPTER !== '' &&
    import.meta.env.VITE_STORAGE_ADAPTER !== 'local'
  ) {
    throw new VoteError(
      'misconfigured',
      `Unknown VITE_STORAGE_ADAPTER "${import.meta.env.VITE_STORAGE_ADAPTER}". Use "local" or "api".`,
    );
  }

  const { createDemoStore } = await import('./demoStore');
  return createDemoStore();
}
