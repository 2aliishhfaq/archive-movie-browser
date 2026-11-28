const CACHE_PREFIX = 'reelbox:catalogue:v1:';
const CATEGORY_KEY = 'reelbox:categories:v1';
const MAX_ENTRY_BYTES = 512 * 1024;
const MAX_STALE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
function getStorage(storage) { if (storage) return storage; try { return globalThis.localStorage; } catch { return null; } }
function safeRead(key, storage) { try { const raw = getStorage(storage)?.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; } }
function safeWrite(key, value, storage) {
  try {
    const target = getStorage(storage);
    if (!target) return false;
    const serialized = JSON.stringify(value);
    if (new Blob([serialized]).size > MAX_ENTRY_BYTES) return false;
    target.setItem(key, serialized);
    return true;
  } catch { return false; }
}
function cacheKey(searchParams) { const params = new URLSearchParams(searchParams); params.sort(); return CACHE_PREFIX + params.toString(); }
export function readCachedCatalogue(searchParams, storage, now = Date.now()) {
  const entry = safeRead(cacheKey(searchParams), storage);
  if (!entry || !Number.isFinite(entry.savedAt) || now - entry.savedAt > MAX_STALE_AGE_MS) return null;
  if (!entry.data || !Array.isArray(entry.data.movies)) return null;
  return entry.data;
}
export function writeCachedCatalogue(searchParams, data, storage, now = Date.now()) {
  if (!data || !Array.isArray(data.movies) || !Number.isFinite(Number(data.total))) return false;
  return safeWrite(cacheKey(searchParams), { savedAt: now, data }, storage);
}
export function readCachedCategories(storage, now = Date.now()) {
  const entry = safeRead(CATEGORY_KEY, storage);
  if (!entry || !Number.isFinite(entry.savedAt) || now - entry.savedAt > MAX_STALE_AGE_MS) return [];
  return Array.isArray(entry.categories) ? entry.categories.filter(value => typeof value === 'string') : [];
}
export function writeCachedCategories(categories, storage, now = Date.now()) {
  if (!Array.isArray(categories)) return false;
  return safeWrite(CATEGORY_KEY, { savedAt: now, categories }, storage);
}
