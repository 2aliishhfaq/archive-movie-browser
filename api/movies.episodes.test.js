import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMovie } from './movies.js';

const movie = { movie_name: 'Example Show', category: 'Series', poster: 'https://example.com/poster.jpg' };
const one = 'https://archive.org/download/example-show/episode-1.mp4';
const two = 'https://archive.org/download/example-show/episode-2.mp4';

test('accepts and normalizes multiple episode links in order', () => {
  const result = validateMovie({ ...movie, movie_links: [{ label: ' Episode 1 ', url: one }, { label: 'Episode 2', url: two }] });
  assert.equal(typeof result, 'object');
  assert.deepEqual(result.movie_links, [{ label: 'Episode 1', url: one }, { label: 'Episode 2', url: two }]);
  assert.equal(result.movie_link, one);
});

test('accepts JSON string input for the admin array editor', () => {
  const result = validateMovie({ ...movie, movie_links: JSON.stringify([{ label: 'Episode 1', url: one }]) });
  assert.equal(result.movie_links.length, 1);
});

test('preserves backward compatibility for existing single movie_link clients', () => {
  const result = validateMovie({ ...movie, movie_link: one });
  assert.deepEqual(result.movie_links, [{ label: 'Full Movie', url: one }]);
});

test('rejects malformed arrays, invalid hosts, duplicate URLs and more than 100 links', () => {
  const invalid = [
    { ...movie, movie_links: '{bad json' },
    { ...movie, movie_links: [] },
    { ...movie, movie_links: [{ label: 'Episode 1', url: 'https://evil.example/video.mp4' }] },
    { ...movie, movie_links: [{ label: 'Episode 1', url: one }, { label: 'Episode 2', url: one }] },
    { ...movie, movie_links: Array.from({ length: 101 }, (_, i) => ({ label: `Episode ${i + 1}`, url: `https://archive.org/download/show/e${i + 1}.mp4` })) },
    { ...movie, movie_links: [{ label: '', url: one }] },
  ];
  for (const input of invalid) assert.equal(typeof validateMovie(input), 'string');
});

test('rejects HTTP URLs and unsafe poster URLs', () => {
  assert.equal(typeof validateMovie({ ...movie, movie_links: [{ label: 'Episode 1', url: 'http://archive.org/download/show/e1.mp4' }] }), 'string');
  assert.equal(typeof validateMovie({ ...movie, poster: 'javascript:alert(1)', movie_links: [{ label: 'Episode 1', url: one }] }), 'string');
});
