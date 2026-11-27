import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMovieCategories } from './movieCategories.js';

test('normalizes, sorts and de-duplicates database category labels', () => {
  assert.deepEqual(
    normalizeMovieCategories([' Action ', 'action', 'Animation', 'Kids   Cartoon', 'Romantic', '']),
    ['Action', 'Animation', 'Kids Cartoon', 'Romantic']
  );
});

test('preserves meaningful label text while collapsing whitespace-only differences', () => {
  assert.deepEqual(
    normalizeMovieCategories(['Sci-Fi', '  sci-fi  ', 'Kids & Family', 'Drama']),
    ['Drama', 'Kids & Family', 'Sci-Fi']
  );
});

test('ignores nulls, non-strings and empty category arrays safely', () => {
  assert.deepEqual(normalizeMovieCategories([null, undefined, 12, {}, '   ']), []);
  assert.deepEqual(normalizeMovieCategories(null), []);
});
