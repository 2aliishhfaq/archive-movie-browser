# Archive Movie Proxy

This Worker is deployed separately from the repository-root `worker.js`, which serves the site's existing application/API routes.

## Deploy

From the repository root, deploy the range proxy with:

```sh
npx wrangler deploy --config cloudflare/wrangler.jsonc
```

## Verify

Run its byte-range contract tests:

```sh
npm run test:stream
```

The proxy only accepts HTTPS Internet Archive hosts. MP4-family video requests are served with exact HTTP byte-range responses. A 1 MiB startup block is fetched first; subsequent aligned 8 MiB blocks are cached at the edge for one hour and pulled on demand as the browser consumes the stream. The browser receives the complete, truthful HTTP 206 Content-Range for the requested range (including open-ended ranges). Only one block is materialized in Worker memory at a time, and later blocks are fetched on demand. Multi-range and unsupported/conditional requests use the transparent upstream Range path.

The edge cache is a performance optimization, not a prerequisite: if a range is unsupported or the cache is unavailable, the Worker falls back to the upstream streaming response without buffering the complete file. The Worker never rewrites an MP4 index or changes the source bytes.
