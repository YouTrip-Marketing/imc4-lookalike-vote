/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_STORAGE_ADAPTER?: string;
  /** '1' only in the build made by `npm run deploy:test`. Changes the demo banner to TEST SITE. */
  readonly VITE_TEST_DEPLOY?: string;
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
