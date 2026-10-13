/**
 * Refuses to let an unfinished build be published.
 *
 *   npm run check:deploy        (runs by itself at the start of `npm run deploy`)
 *
 * `npm run deploy` publishes whatever `npm run build` produces. Without this
 * check, a missing setting would publish the DEMO, with its simulated votes and
 * its demo admin passcode, as if it were the real voting page.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv } from 'vite';
import { contestants, event, keyVisual, promoBanner, votingWindow } from '../event.config';

export interface DeployCheck {
  ok: boolean;
  problems: string[];
  warnings: string[];
}

export interface RepositoryFacts {
  /** Folder this project lives in. */
  projectRoot: string;
  /** Top folder of the git repository that contains it, or null if there is none. */
  repositoryRoot: string | null;
  /** Address of that repository's `origin` remote, or null if it has none. */
  originUrl: string | null;
}

function git(cwd: string, args: readonly string[]): string | null {
  try {
    const output = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return output.trim() === '' ? null : output.trim();
  } catch {
    return null;
  }
}

/** Read-only: asks git two questions and changes nothing. */
export function readRepositoryFacts(projectRoot: string): RepositoryFacts {
  const top = git(projectRoot, ['rev-parse', '--show-toplevel']);
  return {
    projectRoot: realpathSync(projectRoot),
    repositoryRoot: top === null ? null : realpathSync(top),
    originUrl: git(projectRoot, ['config', '--get', 'remote.origin.url']),
  };
}

/**
 * `gh-pages` publishes to the `origin` of whichever git repository contains the
 * folder it is run in. If this project has no repository of its own, that is
 * the repository AROUND it, and a deploy would publish a voting page into
 * somebody else's repository.
 */
export function checkRepository(facts: RepositoryFacts): string[] {
  if (facts.repositoryRoot === null) {
    return ['This folder is not a git repository. Create one for this project, with its own `origin`.'];
  }
  if (facts.repositoryRoot !== facts.projectRoot) {
    return [
      `This folder is inside another git repository (${facts.repositoryRoot}) and has none of its own. ` +
        'Deploying from here would publish to THAT repository. Give this project its own repository first.',
    ];
  }
  if (facts.originUrl === null) {
    return ['This repository has no `origin` remote, so there is nowhere to publish to.'];
  }
  return [];
}

/** The key visual spec's size limit (developer/outbox/imc4-voting-site-key-visual-spec.md). */
export const KEY_VISUAL_MAX_BYTES = 250 * 1024;

export function checkDeploy(
  env: Readonly<Record<string, string | undefined>>,
  config = { contestants, event, votingWindow, keyVisual, promoBanner },
  repository?: RepositoryFacts,
  /** Where the key visual files should be. Checked only when given. */
  publicDir?: string,
): DeployCheck {
  const problems: string[] = repository === undefined ? [] : checkRepository(repository);
  const warnings: string[] = [];

  if (env.VITE_STORAGE_ADAPTER !== 'api') {
    problems.push(
      'VITE_STORAGE_ADAPTER is not "api". This build would publish the DEMO. Set it in .env.production.',
    );
  }

  const base = env.VITE_API_BASE_URL ?? '';
  if (!/^https:\/\/[^/]+\/.+/.test(base)) {
    problems.push(
      'VITE_API_BASE_URL must be the full https address of the vote API, ' +
        'e.g. https://<project>.supabase.co/functions/v1/vote-api. ' +
        'A path like /api cannot work: GitHub Pages serves files only.',
    );
  }

  if (config.event.legalReviewPending && env.ALLOW_PENDING_LEGAL !== '1') {
    problems.push(
      'event.legalReviewPending is still true (event.config.ts). Legal has to clear the event ' +
        'title and T&Cs that cover collecting and keeping each voter\'s email address and IP ' +
        'address (the confidential audit export) before anything is published.',
    );
  }

  if (config.contestants.some((contestant) => contestant.photo === null)) {
    warnings.push('Some contestants have no photo and will show a placeholder tile.');
  }
  if (config.contestants.some((c) => /^Contestant \d+$/.test(c.stageName))) {
    warnings.push('Some contestants still have placeholder names ("Contestant 7").');
  }
  // A warning, not a blocker: launching without a key visual should be a choice, not an oversight.
  const { mobile, desktop, alt } = config.keyVisual;
  if (mobile === null || mobile.trim() === '') {
    warnings.push(
      'No key visual is set (keyVisual.mobile in event.config.ts). The banner slot will be empty on the live page.',
    );
  } else {
    if (alt.trim() === '') {
      warnings.push('The key visual has no alt text (keyVisual.alt). Screen-reader users will get nothing.');
    }
    if (publicDir !== undefined) {
      for (const path of [mobile, desktop]) {
        if (typeof path !== 'string' || path.trim() === '') continue;
        const file = resolve(publicDir, path);
        if (!existsSync(file)) {
          warnings.push(`Key visual file not found: public/${path}`);
        } else if (statSync(file).size > KEY_VISUAL_MAX_BYTES) {
          // The key visual loads first, eagerly, often over mobile data in the Instagram app.
          warnings.push(
            `Key visual file is ${Math.round(statSync(file).size / 1024)} KB: public/${path}. ` +
              'The spec asks for under 250 KB (JPG or WebP); it is the first thing the page loads.',
          );
        }
      }
    }
  }
  // Promo banner: warnings only. Each is a choice, not a blocker.
  const promo = config.promoBanner;
  if (promo !== undefined && promo.image !== null && promo.image.trim() !== '') {
    if ((promo.href ?? '').trim() === '') {
      warnings.push('The promo banner has no link (promoBanner.href). It will show as a plain image.');
    } else if (!/^https:\/\//i.test((promo.href ?? '').trim())) {
      warnings.push('promoBanner.href is not an https:// address, so it is ignored and the banner is not a link.');
    }
    if (promo.phoneImage === undefined || promo.phoneImage === null || promo.phoneImage.trim() === '') {
      warnings.push(
        'The promo banner has no phone version (promoBanner.phoneImage). On phones the 3:1 image is small and its text is hard to read.',
      );
    }
    if (promo.alt.trim() === '') warnings.push('The promo banner has no alt text (promoBanner.alt).');
    if (publicDir !== undefined) {
      for (const path of [promo.image, promo.phoneImage]) {
        if (typeof path === 'string' && path.trim() !== '' && !existsSync(resolve(publicDir, path))) {
          warnings.push(`Promo banner file not found: public/${path}`);
        }
      }
    }
  }
  if (config.votingWindow.closesAt !== null && Date.parse(config.votingWindow.closesAt) < Date.now()) {
    warnings.push('The voting window has already closed.');
  }

  return { ok: problems.length === 0, problems, warnings };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = resolve(import.meta.dirname, '..');
  const result = checkDeploy(
    { ...loadEnv('production', root, ''), ...process.env },
    undefined,
    readRepositoryFacts(root),
    resolve(root, 'public'),
  );
  for (const warning of result.warnings) console.warn(`Warning: ${warning}`);
  if (!result.ok) {
    console.error('\nNot deploying:\n');
    for (const problem of result.problems) console.error(`  - ${problem}`);
    console.error('');
    process.exit(1);
  }
  console.log('Deploy check passed.');
}
