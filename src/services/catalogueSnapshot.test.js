import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalogueResponse } from './catalogueSnapshot.js';

const snapshot = {
  version: '123',
  movies: [
    { id: 4, movie_name: 'The Matrix', category: ' Sci-Fi ' },
    { id: 3, movie_name: 'A Drama', category: 'Drama' },
    { id: 2, movie_name: 'Matrix Reloaded', category: 'sci-fi' },
    { id: 1, movie_name: 'Another Film', category: null },
  ],
};

test('filters a frozen snapshot without querying a database', () => {
  const result = buildCatalogueResponse(snapshot, { q: 'matrix', limit: 1, offset: 1 });
  assert.equal(result.total, 2);
  assert.equal(result.movies[0].id, 2);
  assert.equal(result.limit, 1);
  assert.equal(result.offset, 1);
});

test('normalizes categories and returns a stable unique category list', () => {
  assert.deepEqual(buildCatalogueResponse(snapshot, { categoriesOnly: true }).categories, ['Drama', 'Sci-Fi']);
});

test('returns a movie by id and safely returns null for invalid or missing ids', () => {
  assert.equal(buildCatalogueResponse(snapshot, { id: '4' }).movie.movie_name, 'The Matrix');
  assert.equal(buildCatalogueResponse(snapshot, { id: 'bad' }).movie, null);
  assert.equal(buildCatalogueResponse(snapshot, { id: '99' }).movie, null);
});

test('returns the complete filtered count while slicing the requested page', () => {
  const result = buildCatalogueResponse(snapshot, { category: ' SCI-fi ', limit: 1, offset: 0 });
  assert.equal(result.total, 2);
  assert.deepEqual(result.movies.map(movie => movie.id), [4]);
});
