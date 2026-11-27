import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogCacheKeys, catalogFallbackCacheKey, readCatalogCacheVersion } from './archive-movie-proxy.js';

test('catalogue cache keys are versioned so mutations cannot reuse previous catalogue entries', () => {
  const [oldFresh, oldStale] = catalogCacheKeys('https://worker.test/catalog?limit=24&offset=0', '12');
  const [newFresh, newStale] = catalogCacheKeys('https://worker.test/catalog?limit=24&offset=0', '13');
  assert.notEqual(oldFresh.url, newFresh.url);
  assert.notEqual(oldStale.url, newStale.url);
  assert.match(newFresh.url, /v4\/catalog\/13\/fresh/);
  assert.match(newStale.url, /v4\/catalog\/13\/stale/);
  assert.match(newFresh.url, /v4\/catalog\/13\/fresh/);
});

test('catalogue cache version reader accepts only a cacheable numeric Redis version', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.match(String(url), /cacheVersion=1/);
      assert.equal(new Headers(init.headers).get('Cache-Control'), 'no-cache');
      return Response.json({ version: '42', cacheable: true });
    };
    assert.equal(await readCatalogCacheVersion(), '42');

    globalThis.fetch = async () => Response.json({ version: null, cacheable: false });
    assert.equal(await readCatalogCacheVersion(), null);

    globalThis.fetch = async () => new Response('unavailable', { status: 503 });
    assert.equal(await readCatalogCacheVersion(), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('outage fallback uses a separate versioned cache key from canonical catalogue data', () => {
  const [fresh] = catalogCacheKeys('https://worker.test/catalog?limit=24&offset=0', '42');
  const fallback = catalogFallbackCacheKey('https://worker.test/catalog?limit=24&offset=0', '42');
  assert.match(fresh.url, /v4\/catalog\/42\/fresh/);
  assert.match(fallback.url, /v4\/catalog\/42\/fallback/);
  assert.notEqual(fresh.url, fallback.url);
});
