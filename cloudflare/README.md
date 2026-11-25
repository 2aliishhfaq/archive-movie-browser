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

The proxy only accepts HTTPS Internet Archive hosts. MP4-family video requests are served with exact HTTP byte-range responses while aligned 8 MiB blocks are cached at the edge for one hour. Open-ended browser ranges are capped to one 8 MiB response window, and the next block is fetched only when the browser requests it. Multi-range and unsupported/conditional requests use the transparent upstream Range path.

The edge cache is a performance optimization, not a prerequisite: if a range is unsupported or the cache is unavailable, the Worker falls back to the upstream streaming response without buffering the complete file.
