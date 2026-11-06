/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_STORAGE_ADAPTER?: string;
  /** '1' only in the build made by `npm run deploy:test`. Changes the demo banner to TEST SITE. */
  readonly VITE_TEST_DEPLOY?: string;
  /** '1' = interim public build on the local store (src/interim.ts). */
  readonly VITE_INTERIM_LOCAL?: string;
  readonly VITE_API_BASE_URL?: string;
  /**
   * Sheet adapter: /api/vote in production (the Pages Function relays to Apps
   * Script), or the Apps Script /exec address itself for the test site.
   */
  readonly VITE_SHEET_ENDPOINT?: string;
  /** Sheet adapter, production: the Cloudflare Turnstile site key (public). Required with /api/vote. */
  readonly VITE_TURNSTILE_SITE_KEY?: string;
  /** Sheet adapter only: where the page looks up its own public IP. Default api.ipify.org. */
  readonly VITE_IP_LOOKUP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
