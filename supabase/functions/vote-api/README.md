# vote-api

`index.js` in this folder is generated. It is not kept in the repository.

```bash
npm run build:edge      # writes index.js here. Deploys nothing.
```

The source is `server/adapters/supabase-edge.ts`. It hands each request to the
platform-neutral handler and reads nothing about the caller's network.
