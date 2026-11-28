# Reelbox capacity and resilience checks

## Resilience behaviour

- The catalogue is served from the versioned Cloudflare edge cache first.
- Vercel's public catalogue API is the next read-only fallback.
- Internet Archive search is the final live fallback.
- Successful catalogue responses are also stored in browser local storage (per query) as a bounded last-known-good copy. If all remote catalogue sources fail, the UI can show that copy rather than an empty screen.
- Browser cache entries are limited to 256 KiB each and expire after 30 days. Storage/quota/privacy failures are ignored; they must never break browsing.
- Video playback continues to use the existing Worker proxy first and direct Archive.org fallback when the proxy is unavailable.

## Controlled preview load test

This test is intentionally conservative: GET-only, at most 10 concurrent requests, at most 100 total requests, and it refuses known production URLs (including the current deployment URL and main-branch alias). It does not request video bytes or hammer Archive.org.

1. Open the Vercel preview deployment for the branch and copy its HTTPS URL.
2. Run BASE_URL=https://<preview>.vercel.app CATALOGUE_URL=https://archive-movie-proxy.2aliishhfaq.workers.dev npm run test:capacity.
3. Optionally raise the bounded run to CONCURRENCY=10 REQUESTS=100 after the first run is clean.
4. Review success/failure count, average, p50/p95 latency and observed cache status. Repeat only after a code/config change.

Never point this script at production. For higher-volume tests, use a dedicated staging project and explicit traffic budget; do not use Archive.org as a stress-test origin.
