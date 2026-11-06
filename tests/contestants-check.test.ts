import { describe, expect, it } from 'vitest';
import { LIVE_RELAY, passcodePath, resolveEndpoint } from '../scripts/contestants-check';

/** 6 Nov 2026: the check works with the Turnstile relay, not only a direct /exec address. */
describe('contestants-check: where it asks', () => {
  const EXEC = 'https://script.google.com/macros/s/AKfyc_example-123/exec';

  it('defaults to the live relay, which passes GETs through to Apps Script', () => {
    expect(resolveEndpoint(['passcode.txt'], {})).toBe(LIVE_RELAY);
    expect(LIVE_RELAY).toBe('https://youtrip-lookalike-vote.pages.dev/api/vote');
  });

  it('takes the environment variable over the default, and --endpoint over both', () => {
    expect(resolveEndpoint(['p.txt'], { CONTESTANTS_CHECK_ENDPOINT: EXEC })).toBe(EXEC);
    expect(resolveEndpoint(['p.txt', '--endpoint', 'https://example.pages.dev/api/vote'], { CONTESTANTS_CHECK_ENDPOINT: EXEC })).toBe(
      'https://example.pages.dev/api/vote',
    );
    expect(resolveEndpoint(['--endpoint', 'http://127.0.0.1:4190/exec', 'p.txt'], {})).toBe('http://127.0.0.1:4190/exec');
  });

  it('refuses anything that is not a relay or /exec address', () => {
    expect(() => resolveEndpoint(['p.txt', '--endpoint', 'http://example.com/api/vote'], {})).toThrow(/Not an address/);
    expect(() => resolveEndpoint(['p.txt', '--endpoint', '/api/vote'], {})).toThrow(/Not an address/);
    expect(() => resolveEndpoint(['p.txt', '--endpoint'], {})).toThrow(/needs an address/);
  });

  it('finds the passcode file wherever --endpoint sits', () => {
    expect(passcodePath(['secret.txt'])).toBe('secret.txt');
    expect(passcodePath(['--endpoint', EXEC, 'secret.txt'])).toBe('secret.txt');
    expect(passcodePath(['secret.txt', '--endpoint', EXEC])).toBe('secret.txt');
    expect(() => passcodePath(['--endpoint', EXEC])).toThrow(/passcode/);
  });
});
