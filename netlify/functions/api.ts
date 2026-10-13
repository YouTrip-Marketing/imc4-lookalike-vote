/**
 * Netlify looks for functions in this folder. The adapter itself is in
 * server/adapters/netlify.ts.
 *
 * ALTERNATIVE deployment. The primary path is GitHub Pages + Supabase: see README.
 */
import { netlifyFunction } from '../../server/adapters/netlify';

export default netlifyFunction;

export const config = { path: '/api/*' };
