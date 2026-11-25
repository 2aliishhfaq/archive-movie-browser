import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { createFmp4CacheBlock } from './archive-movie-proxy.js';

const CHUNK = 8 * 1024 * 1024;
const TOTAL = CHUNK * 2 + 100;
const ARCHIVE_URL = 'https://archive.org/download/test-film/film.ia.mp4';
const PROXY_URL = 'https://archive-movie-proxy.2aliishhfaq.workers.dev/stream?url=' + encodeURIComponent(ARCHIVE_URL);

function makeBytes(start, length) {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = (start + i) % 251;
  return bytes;
}

function setup({ ignoreRange = false } = {}) {
  const entries = new Map();
  const upstreamCalls = [];
  globalThis.caches = { default: {
    async match(key) {
      const response = entries.get(key.url);
      return response ? response.clone() : undefined;
    },
    async put(key, response) {
      const bytes = await response.arrayBuffer();
      entries.set(key.url, new Response(bytes, { status: 200, headers: response.headers }));
    }
  } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const requestUrl = String(input);
    const headers = new Headers(init.headers || {});
    const rangeHeader = headers.get('Range');
    upstreamCalls.push({ url: requestUrl, method: init.method || 'GET', range: rangeHeader });
    if (init.method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'Content-Length': String(TOTAL), 'Accept-Ranges': 'bytes', 'Content-Type': 'video/mp4' } });
    }
    if (ignoreRange) {
      return new Response(makeBytes(0, TOTAL), { status: 200, headers: { 'Content-Length': String(TOTAL), 'Accept-Ranges': 'bytes', 'Content-Type': 'video/mp4' } });
    }
    if (rangeHeader && rangeHeader.includes(',')) {
      return new Response('multipart-range', { status: 206, headers: { 'Content-Type': 'multipart/byteranges; boundary=test', 'Content-Range': 'bytes 0-10/' + TOTAL, 'Accept-Ranges': 'bytes' } });
    }
    const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader || '');
    assert.ok(match, 'worker must forward an aligned byte range to Archive.org');
    const start = Number(match[1]);
    const end = Math.min(match[2] === '' ? TOTAL - 1 : Number(match[2]), TOTAL - 1);
    if (start >= TOTAL) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + TOTAL } });
    const bytes = makeBytes(start, end - start + 1);
    return new Response(bytes, { status: 206, headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(bytes.byteLength),
      'Content-Range': 'bytes ' + start + '-' + end + '/' + TOTAL,
      'Accept-Ranges': 'bytes',
      ETag: '"fmp4-test-v1"'
    } });
  };
  const ctx = {
    exports: {
      Fmp4RangeCache: {
        async fetch(request) {
          const key = request.url;
          const existing = entries.get(key);
          if (existing) {
            const bytes = await existing.clone().arrayBuffer();
            return new Response(bytes, { status: 200, headers: { ...Object.fromEntries(existing.headers), 'CF-Cache-Status': 'HIT' } });
          }
          const fresh = await createFmp4CacheBlock(request);
          if (fresh.status === 200) {
            const bytes = await fresh.arrayBuffer();
            entries.set(key, new Response(bytes, { status: 200, headers: fresh.headers }));
            return new Response(bytes, { status: 200, headers: { ...Object.fromEntries(fresh.headers), 'CF-Cache-Status': 'MISS' } });
          }
          return fresh;
        }
      }
    }
  };
  async function request(range, method = 'GET') {
    const headers = range ? { Range: range } : {};
    return worker.fetch(new Request(PROXY_URL, { method, headers }), {}, ctx);
  }
  async function flushCache() {}
  function restore() { globalThis.fetch = originalFetch; delete globalThis.caches; }
  return { request, upstreamCalls, entries, flushCache, restore };
}

test('returns exact 206 bytes while caching the aligned first 8 MiB MP4 block', async () => {
  const env = setup();
  try {
    const response = await env.request('bytes=12-31');
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('Content-Range'), 'bytes 12-31/' + TOTAL);
    assert.equal(response.headers.get('Content-Length'), '20');
    assert.equal(response.headers.get('Content-Type'), 'video/mp4');
    assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
    assert.equal(response.headers.get('X-Range-Chunk-Bytes'), String(CHUNK));
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), makeBytes(12, 20));
    await env.flushCache();
    assert.equal(env.upstreamCalls.length, 1);
    assert.equal(env.upstreamCalls[0].range, 'bytes=0-' + (CHUNK - 1));
    assert.equal(env.entries.size, 1);
  } finally { env.restore(); }
});

test('serves a second seek inside the same 8 MiB block from edge cache', async () => {
  const env = setup();
  try {
    const first = await env.request('bytes=100-119');
    await first.arrayBuffer();
    await env.flushCache();
    const second = await env.request('bytes=5000-5024');
    assert.equal(second.status, 206);
    assert.equal(second.headers.get('X-Range-Cache'), 'HIT');
    assert.deepEqual(new Uint8Array(await second.arrayBuffer()), makeBytes(5000, 25));
    assert.equal(env.upstreamCalls.length, 1);
  } finally { env.restore(); }
});

test('streams a range spanning two aligned chunks without changing the requested range', async () => {
  const env = setup();
  try {
    const start = CHUNK - 4;
    const end = CHUNK + 5;
    const response = await env.request('bytes=' + start + '-' + end);
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('Content-Range'), 'bytes ' + start + '-' + end + '/' + TOTAL);
    assert.equal(response.headers.get('Content-Length'), '10');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), makeBytes(start, 10));
    await env.flushCache();
    assert.deepEqual(env.upstreamCalls.map(call => call.range), [
      'bytes=0-' + (CHUNK - 1),
      'bytes=' + CHUNK + '-' + (CHUNK * 2 - 1)
    ]);
    const cachedRepeat = await env.request('bytes=' + start + '-' + end);
    assert.equal(cachedRepeat.status, 206);
    assert.equal(cachedRepeat.headers.get('X-Range-Cache'), 'HIT');
    assert.deepEqual(new Uint8Array(await cachedRepeat.arrayBuffer()), makeBytes(start, 10));
    assert.equal(env.upstreamCalls.length, 2, 'both aligned chunks should be reused from cache on repeat seek');
  } finally { env.restore(); }
});

test('streams an open-ended browser range as a truthful full 206 while fetching only aligned 8 MiB blocks', async () => {
  const env = setup();
  try {
    const response = await env.request('bytes=0-');
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('Content-Range'), 'bytes 0-' + (TOTAL - 1) + '/' + TOTAL);
    assert.equal(response.headers.get('Content-Length'), String(TOTAL));
    const body = new Uint8Array(await response.arrayBuffer());
    assert.equal(body.byteLength, TOTAL);
    assert.deepEqual(body.slice(0, 32), makeBytes(0, 32));
    assert.deepEqual(body.slice(CHUNK - 16, CHUNK + 16), makeBytes(CHUNK - 16, 32));
    assert.deepEqual(body.slice(-32), makeBytes(TOTAL - 32, 32));
    await env.flushCache();
    assert.deepEqual(env.upstreamCalls.map(call => call.range), [
      'bytes=0-' + (CHUNK - 1),
      'bytes=' + CHUNK + '-' + (CHUNK * 2 - 1),
      'bytes=' + (CHUNK * 2) + '-' + (CHUNK * 3 - 1)
    ]);
  } finally { env.restore(); }
});

test('passes through a full 200 when an upstream ignores Range rather than mislabelling it 206', async () => {
  const env = setup({ ignoreRange: true });
  try {
    const response = await env.request('bytes=10-19');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Range'), null);
    assert.equal(response.headers.get('Content-Length'), String(TOTAL));
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), makeBytes(0, TOTAL));
  } finally { env.restore(); }
});

test('keeps multi-range requests on transparent upstream passthrough', async () => {
  const env = setup();
  try {
    const response = await env.request('bytes=0-10,20-30');
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('Content-Range'), 'bytes 0-10/' + TOTAL);
    assert.equal(env.upstreamCalls.length, 1);
    assert.equal(env.upstreamCalls[0].range, 'bytes=0-10,20-30');
  } finally { env.restore(); }
});
