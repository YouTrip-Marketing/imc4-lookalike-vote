/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_STORAGE_ADAPTER?: string;
  /** '1' only in the build made by `npm run deploy:test`. Changes the demo banner to TEST SITE. */
  readonly VITE_TEST_DEPLOY?: string;
  readonly VITE_API_BASE_URL?: string;
  /** Sheet adapter only (test site): the Apps Script web app's /exec address. */
  readonly VITE_SHEET_ENDPOINT?: string;
  /** Sheet adapter only: where the page looks up its own public IP. Default api.ipify.org. */
  readonly VITE_IP_LOOKUP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
