import { lazy } from 'react';

/**
 * The demo panels, or null in a production build.
 *
 * The condition is a build-time constant, written out in full at each use so the
 * bundler can see it: in an `api` build the import() below is dead code, is
 * removed, and the demo panels are not in the bundle at all.
 */
export const DemoVoterPanel =
  import.meta.env.VITE_STORAGE_ADAPTER === 'api' ? null : lazy(() => import('./DemoVoterPanel'));

export const DemoAdminPanel =
  import.meta.env.VITE_STORAGE_ADAPTER === 'api' ? null : lazy(() => import('./DemoAdminPanel'));
