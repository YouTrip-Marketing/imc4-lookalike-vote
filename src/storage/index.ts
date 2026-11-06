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

  // Votes go to a Google Sheet (apps-script/Code.gs). Production, or the test site with VITE_TEST_DEPLOY=1.
  if (import.meta.env.VITE_STORAGE_ADAPTER === 'sheet') {
    const { createSheetStore } = await import('./sheetStore');
    return createSheetStore(
      import.meta.env.VITE_SHEET_ENDPOINT ?? '',
      import.meta.env.VITE_IP_LOOKUP_URL,
      import.meta.env.VITE_TEST_DEPLOY === '1',
      import.meta.env.VITE_TURNSTILE_SITE_KEY,
    );
  }

  if (
    import.meta.env.VITE_STORAGE_ADAPTER !== undefined &&
    import.meta.env.VITE_STORAGE_ADAPTER !== '' &&
    import.meta.env.VITE_STORAGE_ADAPTER !== 'local'
  ) {
    throw new VoteError(
      'misconfigured',
      `Unknown VITE_STORAGE_ADAPTER "${import.meta.env.VITE_STORAGE_ADAPTER}". Use "local", "sheet" or "api".`,
    );
  }

  const { createDemoStore } = await import('./demoStore');
  return createDemoStore();
}
