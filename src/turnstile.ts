import { VoteError } from './domain/errors';

/**
 * Cloudflare Turnstile in the page (6 Nov 2026). The sheet store asks for a
 * token right before it sends a vote; /api/vote (functions/api/vote.ts)
 * checks the token with Cloudflare and refuses the vote without one.
 *
 * The widget is "interaction-only": nothing shows unless Cloudflare wants the
 * visitor to tap a checkbox, in which case the widget appears at the bottom
 * of the screen. The script is loaded the first time a token is needed, so
 * the demo and test builds (no site key) never contact Cloudflare.
 *
 * A token is single-use and lasts five minutes, so the widget is reset and
 * run again for every attempt, retries included.
 */

interface TurnstileApi {
  render(container: HTMLElement, options: Record<string, unknown>): string | undefined;
  execute(widgetId: string): void;
  reset(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const TOKEN_TIMEOUT_MS = 30_000;
const CONTAINER_ID = 'turnstile-widget';

let loading: Promise<TurnstileApi> | null = null;
let widgetId: string | null = null;
let pending: { resolve: (token: string) => void; reject: (error: VoteError) => void } | null = null;

const notLoaded = (): VoteError => new VoteError('unreachable', 'The check that you are a person could not be loaded.');
const notPassed = (detail?: string): VoteError =>
  new VoteError('human_check_failed', detail === undefined ? undefined : `The check that you are a person did not pass (${detail}).`);

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile !== undefined) return Promise.resolve(window.turnstile);
  if (loading !== null) return loading;
  loading = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (window.turnstile !== undefined) resolve(window.turnstile);
      else reject(notLoaded());
    };
    script.onerror = () => reject(notLoaded());
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    // Let the next attempt try loading again (a retry after a flaky connection).
    loading = null;
    throw error;
  });
  return loading;
}

function container(): HTMLElement {
  const existing = document.getElementById(CONTAINER_ID);
  if (existing !== null) return existing;
  const element = document.createElement('div');
  element.id = CONTAINER_ID;
  // Out of the way until Cloudflare has something to show.
  element.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:1000;';
  document.body.appendChild(element);
  return element;
}

function settle(result: string | VoteError): void {
  const waiting = pending;
  pending = null;
  if (waiting === null) return;
  if (typeof result === 'string') waiting.resolve(result);
  else waiting.reject(result);
}

/** A fresh Turnstile token for one vote attempt. Rejects with a VoteError. */
export async function turnstileToken(siteKey: string): Promise<string> {
  const api = await loadTurnstile();
  if (pending !== null) settle(notPassed('another attempt was already running'));
  if (widgetId === null) {
    const id = api.render(container(), {
      sitekey: siteKey,
      execution: 'execute',
      appearance: 'interaction-only',
      callback: (token: string) => settle(token),
      'error-callback': (code?: string) => {
        settle(notPassed(typeof code === 'string' && code !== '' ? `error ${code}` : 'error'));
        return true;
      },
      'expired-callback': () => settle(notPassed('the check expired')),
      'timeout-callback': () => settle(notPassed('the check timed out')),
      'unsupported-callback': () => settle(notPassed('this browser is not supported')),
    });
    if (id === undefined) throw notLoaded();
    widgetId = id;
  } else {
    api.reset(widgetId);
  }
  const id = widgetId;
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => settle(notPassed('it did not finish in time')), TOKEN_TIMEOUT_MS);
    pending = {
      resolve: (token) => {
        clearTimeout(timer);
        resolve(token);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    };
    api.execute(id);
  });
}
