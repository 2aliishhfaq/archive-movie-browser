import test from 'node:test';
import assert from 'node:assert/strict';
import { validateArchiveVideoUrl } from './archiveValidation.js';

function mockFetch({ status = 200, payload } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  };
  return { fetchImpl, calls };
}

const metadata = {
  metadata: { mediatype: 'movies', title: 'Test film' },
  files: [
    { name: 'readme.txt', size: '500' },
    { name: 'empty.mp4', size: '0' },
    { name: 'feature.mkv', size: '5000000' },
    { name: 'feature.ia.mp4', size: '125000000', format: 'MPEG4' },
    { name: 'feature.webm', size: '90000000', format: 'WebM' },
  ],
};

test('resolves a details URL to the best supported, non-empty direct video file', async () => {
  const mock = mockFetch({ payload: metadata });
  const result = await validateArchiveVideoUrl('https://archive.org/details/test-film', mock.fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.movieLink, 'https://archive.org/download/test-film/feature.ia.mp4');
  assert.equal(result.file.size, 125000000);
  assert.equal(mock.calls.length, 1);
});

test('preserves an explicitly selected playable file and canonicalizes encoded paths', async () => {
  const mock = mockFetch({ payload: metadata });
  const result = await validateArchiveVideoUrl('https://archive.org/download/test-film/feature.webm', mock.fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.movieLink, 'https://archive.org/download/test-film/feature.webm');
});

test('rejects missing, empty, and unsupported files but accepts video files in data items', async () => {
  const mock = mockFetch({ payload: metadata });
  assert.equal((await validateArchiveVideoUrl('https://archive.org/download/test-film/missing.mp4', mock.fetchImpl)).ok, false);
  assert.equal((await validateArchiveVideoUrl('https://archive.org/download/test-film/empty.mp4', mock.fetchImpl)).ok, false);
  const dataItem = mockFetch({ payload: { metadata: { mediatype: 'data' }, files: [{ name: 'f&f062013.mp4', size: '1505656638', source: 'original' }] } });
  const accepted = await validateArchiveVideoUrl('https://archive.org/download/ff062013-2026/f%26f062013.mp4', dataItem.fetchImpl);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.movieLink, 'https://archive.org/download/ff062013-2026/f%26f062013.mp4');
  const noVideo = mockFetch({ payload: { metadata: { mediatype: 'texts' }, files: [{ name: 'book.pdf', size: '12000' }] } });
  assert.match((await validateArchiveVideoUrl('https://archive.org/details/test-film', noVideo.fetchImpl)).error, /no non-empty browser-compatible video/i);
});

test('rejects lookalike hosts, insecure URLs, and unsafe item identifiers', async () => {
  const mock = mockFetch({ payload: metadata });
  for (const url of [
    'http://archive.org/details/test-film',
    'https://notarchive.org/details/test-film',
    'https://archive.org/details/../secret',
    'https://user:pass@archive.org/details/test-film',
  ]) assert.equal((await validateArchiveVideoUrl(url, mock.fetchImpl)).ok, false);
  assert.equal(mock.calls.length, 0);
});

test('returns actionable errors for missing items and Archive.org outages', async () => {
  const missing = mockFetch({ status: 404, payload: {} });
  assert.match((await validateArchiveVideoUrl('https://archive.org/details/missing', missing.fetchImpl)).error, /does not exist/i);
  const outage = mockFetch({ status: 503, payload: {} });
  assert.match((await validateArchiveVideoUrl('https://archive.org/details/test-film', outage.fetchImpl)).error, /temporarily unavailable/i);
  const offline = await validateArchiveVideoUrl('https://archive.org/details/test-film', async () => { throw new Error('offline'); });
  assert.match(offline.error, /could not be reached/i);
});
