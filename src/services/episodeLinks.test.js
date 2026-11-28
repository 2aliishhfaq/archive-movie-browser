import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEpisodeLinks, parseEpisodeLinksJson } from './episodeLinks.js';

test('normalizes multiple episodes and preserves their labels/order', () => {
  const links = [{ label: 'Episode 1', url: 'https://archive.org/download/show/one.mp4' }, { label: 'Episode 2', url: 'https://archive.org/download/show/two.mp4' }];
  assert.deepEqual(normalizeEpisodeLinks({ movie_links: links }), links);
});

test('legacy single movie_link remains playable', () => {
  assert.deepEqual(normalizeEpisodeLinks({ movie_link: 'https://archive.org/download/film/movie.mp4' }), [{ label: 'Full Movie', url: 'https://archive.org/download/film/movie.mp4' }]);
});

test('drops malformed and empty stored episode entries safely', () => {
  assert.deepEqual(normalizeEpisodeLinks({ movie_links: [{ label: '', url: '' }, null], movie_link: 'https://archive.org/download/film/movie.mp4' }), [{ label: 'Full Movie', url: 'https://archive.org/download/film/movie.mp4' }]);
});

test('accepts a valid JSON episode array and normalizes whitespace', () => {
  const result = parseEpisodeLinksJson('[{"label":" Episode 1 ","url":"https://archive.org/download/show/one.mp4"}]');
  assert.equal(result.ok, true);
  assert.equal(result.links[0].label, 'Episode 1');
});

test('rejects invalid JSON, empty arrays, unsafe hosts, duplicates and oversized labels', () => {
  for (const value of ['{', '[]', '[{"label":"E1","url":"https://notarchive.org/x"}]', '[{"label":"E1","url":"https://archive.org/a"},{"label":"E2","url":"https://archive.org/a"}]', JSON.stringify([{ label: 'x'.repeat(81), url: 'https://archive.org/a' }])]) assert.equal(parseEpisodeLinksJson(value).ok, false);
});
