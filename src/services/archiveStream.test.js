import test from 'node:test';
import assert from 'node:assert/strict';
import { ARCHIVE_STREAM_PROXY, FMP4_RANGE_CHUNK_BYTES, getArchiveStreamUrl, isFmp4FileName } from './archiveStream.js';

test('uses an eight MiB byte-range chunk size', () => {
  assert.equal(FMP4_RANGE_CHUNK_BYTES, 8 * 1024 * 1024);
});

test('routes Archive.org MP4 files through the range-aware stream proxy', () => {
  const source = 'https://archive.org/download/example-film/feature.ia.mp4?download=0';
  const result = new URL(getArchiveStreamUrl(source));
  assert.equal(result.origin, ARCHIVE_STREAM_PROXY);
  assert.equal(result.pathname, '/stream');
  assert.equal(result.searchParams.get('url'), source);
});

test('allows Archive.org storage subdomains and preserves encoded filenames', () => {
  const source = 'https://ia800504.us.archive.org/12/items/example/a%20movie.mp4';
  const result = new URL(getArchiveStreamUrl(source));
  assert.equal(result.pathname, '/stream');
  assert.equal(result.searchParams.get('url'), source);
});

test('does not proxy non-Archive, insecure, non-download, or non-MP4 URLs', () => {
  for (const source of [
    'https://example.com/video.mp4',
    'http://archive.org/download/id/video.mp4',
    'https://notarchive.org/download/id/video.mp4',
    'https://archive.org/details/id',
    'https://archive.org/download/id/video.webm',
  ]) {
    assert.equal(getArchiveStreamUrl(source), source);
  }
});

test('only accepts MP4-family Archive files for the fMP4 player', () => {
  assert.equal(isFmp4FileName('video.mp4'), true);
  assert.equal(isFmp4FileName('video.ia.mp4'), true);
  assert.equal(isFmp4FileName('folder/video.m4v'), true);
  assert.equal(isFmp4FileName('video.webm'), false);
  assert.equal(isFmp4FileName('video.ogv'), false);
  assert.equal(isFmp4FileName('video.m3u8'), false);
});
