import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogCacheKeys, catalogFallbackCacheKey, catalogVersionCacheKeys, readCatalogCacheVersion, resolveCachedCatalogVersion } from './archive-movie-proxy.js';

test('catalogue cache keys are versioned so a manual sync cannot reuse previous catalogue entries', () => {
  const [oldFresh, oldStale] = catalogCacheKeys('https://worker.test/catalog?limit=24&offset=0', '12');
  const [newFresh, newStale] = catalogCacheKeys('https://worker.test/catalog?limit=24&offset=0', '13');
  assert.notEqual(oldFresh.url, newFresh.url);
  assert.notEqual(oldStale.url, newStale.url);
  assert.match(newFresh.url, /v4\/catalog\/13\/fresh/);
  assert.match(newStale.url, /v4\/catalog\/13\/stale/);
  assert.match(newFresh.url, /limit=24/);
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

test('catalogue version pointers have stable edge cache keys', () => {
  const [fresh, stale] = catalogVersionCacheKeys('https://worker.test/catalog?limit=24');
  assert.match(fresh.url, /v5\/catalog-version\/fresh/);
  assert.match(stale.url, /v5\/catalog-version\/stale/);
  assert.notEqual(fresh.url, stale.url);
});

test('edge-caches the active version pointer and avoids repeat Redis lookups', async () => {
  const originalFetch = globalThis.fetch;
  const entries = new Map();
  const pending = [];
  const cache = {
    async match(key) { return entries.get(key.url)?.clone(); },
    async put(key, response) { entries.set(key.url, response.clone()); }
  };
  let lookups = 0;
  globalThis.fetch = async () => {
    lookups += 1;
    return Response.json({ version: '77', cacheable: true });
  };
  try {
    const ctx = { waitUntil(promise) { pending.push(promise); } };
    assert.equal(await resolveCachedCatalogVersion('https://worker.test/catalog', cache, ctx), '77');
    await Promise.all(pending);
    assert.equal(await resolveCachedCatalogVersion('https://worker.test/catalog', cache, ctx), '77');
    assert.equal(lookups, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('uses the last known version pointer when Redis is unavailable', async () => {
  const originalFetch = globalThis.fetch;
  const entries = new Map();
  const cache = {
    async match(key) { return entries.get(key.url)?.clone(); },
    async put(key, response) { entries.set(key.url, response.clone()); }
  };
  const [, staleKey] = catalogVersionCacheKeys('https://worker.test/catalog');
  entries.set(staleKey.url, new Response('76'));
  globalThis.fetch = async () => { throw new Error('Redis/Neon origin unavailable'); };
  try {
    assert.equal(await resolveCachedCatalogVersion('https://worker.test/catalog', cache, { waitUntil() {} }), '76');
  } finally { globalThis.fetch = originalFetch; }
});
