import test from 'node:test';
import assert from 'node:assert/strict';
import { readCachedCatalogue, writeCachedCatalogue, readCachedCategories, writeCachedCategories } from './catalogueResilience.js';
function memoryStorage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
}
test('stores and restores a catalogue by normalized query parameters', () => {
  const storage = memoryStorage();
  const params = new URLSearchParams('limit=24&offset=0');
  const data = { movies: [{ id: '1', movie_name: 'Example' }], total: 1 };
  assert.equal(writeCachedCatalogue(params, data, storage, 1000), true);
  assert.deepEqual(readCachedCatalogue(new URLSearchParams('offset=0&limit=24'), storage, 2000), data);
});
test('rejects expired, malformed, and oversized catalogue entries safely', () => {
  const storage = memoryStorage();
  const params = new URLSearchParams('limit=24');
  writeCachedCatalogue(params, { movies: [], total: 0 }, storage, 1000);
  assert.equal(readCachedCatalogue(params, storage, 1000 + 31 * 86400000), null);
  assert.equal(writeCachedCatalogue(params, { movies: ['x'.repeat(300000)], total: 1 }, storage), false);
  assert.equal(readCachedCatalogue(params, { getItem: () => '{broken' }), null);
});
test('stores categories and gracefully handles unavailable browser storage', () => {
  const storage = memoryStorage();
  assert.equal(writeCachedCategories(['Drama', 'Sci-Fi'], storage, 1000), true);
  assert.deepEqual(readCachedCategories(storage, 2000), ['Drama', 'Sci-Fi']);
  const unavailable = { setItem() { throw new Error('quota'); }, getItem() { throw new Error('blocked'); } };
  assert.equal(writeCachedCategories(['Drama'], unavailable), false);
  assert.deepEqual(readCachedCategories(unavailable), []);
});

test('keeps only the 8 most recently saved catalogue query entries', () => {
  const storage = memoryStorage();
  for (let index = 0; index < 15; index += 1) {
    writeCachedCatalogue(new URLSearchParams('q=film' + index), { movies: [], total: 0 }, storage, 1000 + index);
  }
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(key => key?.startsWith('reelbox:catalogue:v1:'));
  assert.equal(keys.length, 8);
  assert.equal(readCachedCatalogue(new URLSearchParams('q=film0'), storage, 2000), null);
  assert.deepEqual(readCachedCatalogue(new URLSearchParams('q=film14'), storage, 2000), { movies: [], total: 0 });
});
