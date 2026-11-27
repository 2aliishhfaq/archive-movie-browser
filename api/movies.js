import { neon } from '@neondatabase/serverless';
import { timingSafeEqual } from 'node:crypto';

const CACHE_TTL = 3600;
const CACHE_VERSION_KEY = 'movies:cache-version';
const json = (res, status, body, headers = {}) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(JSON.stringify(body));
};
const validId = value => /^\d{1,18}$/.test(String(value ?? ''));
const validMovieLink = value => {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    // Movie links are opened by the visitor's player, never fetched by this API.
    // Require a public-looking HTTPS hostname and reject credentials/local hosts.
    return url.protocol === 'https:' &&
      !url.username && !url.password &&
      (host === 'archive.org' || host.endsWith('.archive.org'));
  } catch { return false; }
};
const validPoster = value => {
  if (value === null || value === '') return true;
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
};
const safeEqual = (a, b) => {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
};
const isAdmin = req => safeEqual((req.headers.authorization || '').replace(/^Bearer\s+/i, ''), process.env.MOVIES_ADMIN_TOKEN);
const redisConfig = () => ({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});
const redisReady = () => Boolean(redisConfig().url && redisConfig().token);
async function redisPipeline(commands) {
  if (!redisReady()) return null;
  const { url, token } = redisConfig();
  const response = await fetch(url.replace(/\/+$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) throw new Error('Redis HTTP ' + response.status);
  const entries = await response.json();
  const failed = entries.find(entry => entry.error);
  if (failed) throw new Error('Redis command failed: ' + failed.error);
  return entries.map(entry => entry.result);
}
async function cached(key, load) {
  if (!redisReady()) return { value: await load(), hit: false, configured: false };
  try {
    let [version] = await redisPipeline([['GET', CACHE_VERSION_KEY]]);
    if (!version) {
      await redisPipeline([['SET', CACHE_VERSION_KEY, '1', 'NX']]);
      [version] = await redisPipeline([['GET', CACHE_VERSION_KEY]]);
      version ||= '1';
    }
    const cacheKey = 'movies:v' + version + ':' + key;
    const [stored] = await redisPipeline([['GET', cacheKey]]);
    if (stored) return { value: JSON.parse(stored), hit: true, configured: true };
    const value = await load();
    await redisPipeline([['SET', cacheKey, JSON.stringify(value), 'EX', String(CACHE_TTL)]]);
    return { value, hit: false, configured: true };
  } catch (error) {
    console.error('redis-cache-bypass', error.message);
    return { value: await load(), hit: false, configured: true, degraded: true };
  }
}
async function invalidateCache() {
  if (!redisReady()) return;
  try { await redisPipeline([['INCR', CACHE_VERSION_KEY]]); }
  catch (error) { console.error('redis-invalidation-failed', error.message); }
}
async function currentCacheVersion() {
  if (!redisReady()) return { version: null, cacheable: false };
  try {
    let [version] = await redisPipeline([['GET', CACHE_VERSION_KEY]]);
    if (!version) {
      await redisPipeline([['SET', CACHE_VERSION_KEY, '1', 'NX']]);
      [version] = await redisPipeline([['GET', CACHE_VERSION_KEY]]);
    }
    return { version: String(version || '1'), cacheable: true };
  } catch (error) {
    console.error('redis-cache-version-unavailable', error.message);
    return { version: null, cacheable: false };
  }
}
function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string') { try { return Promise.resolve(req.body ? JSON.parse(req.body) : {}); } catch { return Promise.reject(new Error('Invalid JSON')); } }
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 16_384) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}
function validateMovie(body) {
  const movie_name = typeof body.movie_name === 'string' ? body.movie_name.trim() : '';
  const category = typeof body.category === 'string' ? body.category.trim() : null;
  const poster = typeof body.poster === 'string' && body.poster.trim() ? body.poster.trim() : null;
  const movie_link = typeof body.movie_link === 'string' ? body.movie_link.trim() : '';
  if (!movie_name || movie_name.length > 240) return 'movie_name is required (max 240 characters)';
  if (category && category.length > 100) return 'category is too long (max 100 characters)';
  if (!validPoster(poster)) return 'poster must be a valid HTTPS URL';
  if (!validMovieLink(movie_link)) return 'movie_link must be an HTTPS Internet Archive URL';
  return { movie_name, category: category || null, poster, movie_link };
}

function pickPlayableFile(files = []) {
  // Keep imported sources browser-friendly. AVI/MKV may be valid archive
  // downloads but are not reliably playable by native browser video elements.
  const extensions = { mp4: 100, m4v: 95, webm: 90, ogv: 70, ogg: 65 };
  return files
    .filter(file => file && typeof file.name === 'string' && file.name.length < 500)
    .map(file => {
      const ext = file.name.split('.').pop().toLowerCase();
      const size = Number(file.size || 0);
      return { file, score: (extensions[ext] || 0) + (size > 5_000_000 ? 5 : 0) };
    })
    .filter(item => item.score > 0 && (!item.file.source || item.file.source === 'original'))
    .sort((a, b) => b.score - a.score || Number(b.file.size || 0) - Number(a.file.size || 0))[0]?.file || null;
}

function archiveDownloadUrl(identifier, filename) {
  return 'https://archive.org/download/' + encodeURIComponent(identifier) + '/' +
    filename.split('/').map(encodeURIComponent).join('/');
}

async function importArchiveMovies(body, sql, res) {
  const requestedQuery = typeof body.query === 'string' ? body.query.trim().slice(0, 120) : '';
  const category = typeof body.category === 'string' ? body.category.trim().slice(0, 100) : '';
  const limit = Math.min(5, Math.max(1, Number.parseInt(body.limit, 10) || 5));
  const safeQuery = requestedQuery
    .replaceAll('"', '')
    .replaceAll('[', ' ').replaceAll(']', ' ')
    .replaceAll('{', ' ').replaceAll('}', ' ')
    .replaceAll(':', ' ').replaceAll('*', ' ')
    .split(' ').filter(Boolean).join(' ');
  const searchQuery = safeQuery
    ? 'mediatype:movies AND (' + safeQuery + ')'
    : 'mediatype:movies AND collection:feature_films';

  const searchUrl = new URL('https://archive.org/advancedsearch.php');
  searchUrl.searchParams.set('q', searchQuery);
  searchUrl.searchParams.append('fl[]', 'identifier');
  searchUrl.searchParams.append('fl[]', 'title');
  searchUrl.searchParams.set('rows', String(limit));
  searchUrl.searchParams.set('page', '1');
  searchUrl.searchParams.set('output', 'json');
  searchUrl.searchParams.append('sort[]', 'downloads desc');

  try {
    const searchResponse = await fetch(searchUrl, { signal: AbortSignal.timeout(9000) });
    if (!searchResponse.ok) throw new Error('Internet Archive search HTTP ' + searchResponse.status);
    const searchData = await searchResponse.json();
    const docs = searchData?.response?.docs || [];
    if (!docs.length) {
      return json(res, 200, { imported: [], importedCount: 0, skippedCount: 0, totalFound: 0, message: 'No matching Internet Archive films were found.' });
    }

    const seen = new Set();
    const processed = await Promise.all(docs.map(async doc => {
      const identifier = String(doc.identifier || '').trim();
      if (!/^[a-zA-Z0-9._-]{1,200}$/.test(identifier) || seen.has(identifier)) return null;
      seen.add(identifier);
      try {
        const metadataResponse = await fetch('https://archive.org/metadata/' + encodeURIComponent(identifier), {
          signal: AbortSignal.timeout(7000),
        });
        if (!metadataResponse.ok) return null;
        const metadataData = await metadataResponse.json();
        const metadata = metadataData.metadata || {};
        const mediaFile = pickPlayableFile(metadataData.files);
        if (!mediaFile) return null;

        const movieLink = archiveDownloadUrl(identifier, mediaFile.name);
        const existing = await sql`SELECT id FROM public.movies WHERE movie_link = ${movieLink} LIMIT 1`;
        if (existing.length) return null;

        const title = String(metadata.title || doc.title || identifier).trim().slice(0, 240);
        const poster = 'https://archive.org/services/img/' + encodeURIComponent(identifier);
        const rawSubject = metadata.subject;
        const firstSubject = Array.isArray(rawSubject) ? rawSubject[0] : rawSubject;
        const movieCategory = category || (typeof firstSubject === 'string' && firstSubject.trim()
          ? firstSubject.trim().slice(0, 100) : 'Feature Films');
        const rows = await sql`INSERT INTO public.movies (movie_name, category, poster, movie_link)
          VALUES (${title}, ${movieCategory}, ${poster}, ${movieLink})
          RETURNING id, movie_name, category, poster, movie_link`;
        return rows[0] || null;
      } catch (error) {
        console.error('archive-import-item-failed', identifier, error.message);
        return null;
      }
    }));

    const imported = processed.filter(Boolean);
    const skippedCount = docs.length - imported.length;
    if (imported.length) await invalidateCache();
    return json(res, 200, {
      imported,
      importedCount: imported.length,
      skippedCount,
      totalFound: docs.length,
      message: imported.length ? 'Internet Archive films imported successfully.' : 'No new playable films were imported. Existing records and unsupported formats were skipped.',
    });
  } catch (error) {
    console.error('archive-import-failed', error.message);
    return json(res, 502, { error: 'Internet Archive import failed. Please retry in a moment.' });
  }
}

export default async function handler(req, res) {
  const method = req.method || 'GET';
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) {
    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return json(res, 405, { error: 'Method not allowed' });
  }
  if (method !== 'GET' && !isAdmin(req)) return json(res, 401, { error: 'Admin authorization required' });
  // The Cloudflare catalogue edge reads this tiny, uncached version before
  // looking up its own cache. A successful admin mutation increments the
  // Redis version, instantly moving all catalogue requests to a fresh key.
  if (method === 'GET' && req.query?.cacheVersion === '1') {
    const state = await currentCacheVersion();
    return json(res, 200, state, {
      'Cache-Control': 'no-store, max-age=0',
      'X-Movies-Cache-Version': state.version || 'uncacheable'
    });
  }
  if (!process.env.DATABASE_URL) return json(res, 503, { error: 'Database is not configured' });
  const sql = neon(process.env.DATABASE_URL, { fetchOptions: { signal: AbortSignal.timeout(8000) } });
  try {
    if (method === 'GET') {
      const adminView = req.query?.admin === '1';
      if (adminView && !isAdmin(req)) return json(res, 401, { error: 'Admin authorization required' });
      const id = req.query?.id;
      const q = String(req.query?.q || '').trim().slice(0, 100);
      const category = String(req.query?.category || '').trim().slice(0, 100);
      const limit = Math.min(adminView ? 500 : 100, Math.max(1, Number.parseInt(req.query?.limit, 10) || 24));
      const offset = Math.max(0, Number.parseInt(req.query?.offset, 10) || 0);
      const key = JSON.stringify({ id: id || null, q, category, limit, offset, categories: req.query?.categories === '1' });
      const result = await cached((adminView ? 'admin:' : '') + key, async () => {
        if (id !== undefined) {
          if (!validId(id)) return { movie: null };
          const rows = await sql`SELECT id, movie_name, category, poster, movie_link FROM public.movies WHERE id = ${String(id)} LIMIT 1`;
          return { movie: rows[0] || null };
        }
        if (req.query?.categories === '1') {
          const rows = await sql`SELECT DISTINCT ON (LOWER(REGEXP_REPLACE(BTRIM(category), '[[:space:]]+', ' ', 'g'))) REGEXP_REPLACE(BTRIM(category), '[[:space:]]+', ' ', 'g') AS category
            FROM public.movies
            WHERE category IS NOT NULL AND BTRIM(category) <> ''
            ORDER BY LOWER(REGEXP_REPLACE(BTRIM(category), '[[:space:]]+', ' ', 'g')) ASC, REGEXP_REPLACE(BTRIM(category), '[[:space:]]+', ' ', 'g') ASC`;
          return { categories: rows.map(row => row.category) };
        }
        const rows = await sql`SELECT id, movie_name, category, poster, movie_link FROM public.movies WHERE (${q} = '' OR movie_name ILIKE ${'%' + q + '%'}) AND (${category} = '' OR LOWER(REGEXP_REPLACE(BTRIM(category), '[[:space:]]+', ' ', 'g')) = LOWER(REGEXP_REPLACE(BTRIM(${category}), '[[:space:]]+', ' ', 'g'))) ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`;
        const countRows = await sql`SELECT COUNT(*)::bigint AS total FROM public.movies WHERE (${q} = '' OR movie_name ILIKE ${'%' + q + '%'}) AND (${category} = '' OR LOWER(REGEXP_REPLACE(BTRIM(category), '[[:space:]]+', ' ', 'g')) = LOWER(REGEXP_REPLACE(BTRIM(${category}), '[[:space:]]+', ' ', 'g')))`;
        return { movies: rows, total: Number(countRows[0]?.total || 0), limit, offset };
      });
      const dynamicCategoryView = req.query?.categories === '1' || Boolean(category);
      return json(res, 200, result.value, {
        'X-Cache': result.hit ? 'HIT' : result.degraded ? 'BYPASS-ERROR' : result.configured ? 'MISS' : 'DISABLED',
        'Cache-Control': adminView || dynamicCategoryView
          ? 'no-store'
          : 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600, stale-if-error=86400',
      });
    }
    if (method === 'POST') {
      const body = await readBody(req);
      if (body.action === 'import') return await importArchiveMovies(body, sql, res);
      const movie = validateMovie(body);
      if (typeof movie === 'string') return json(res, 400, { error: movie });
      const rows = await sql`INSERT INTO public.movies (movie_name, category, poster, movie_link) VALUES (${movie.movie_name}, ${movie.category}, ${movie.poster}, ${movie.movie_link}) RETURNING id, movie_name, category, poster, movie_link`;
      await invalidateCache();
      return json(res, 201, { movie: rows[0] });
    }
    const body = await readBody(req);
    if (!validId(body.id)) return json(res, 400, { error: 'A valid numeric id is required' });
    if (method === 'PUT') {
      const movie = validateMovie(body);
      if (typeof movie === 'string') return json(res, 400, { error: movie });
      const rows = await sql`UPDATE public.movies SET movie_name = ${movie.movie_name}, category = ${movie.category}, poster = ${movie.poster}, movie_link = ${movie.movie_link} WHERE id = ${String(body.id)} RETURNING id, movie_name, category, poster, movie_link`;
      if (!rows.length) return json(res, 404, { error: 'Movie not found' });
      await invalidateCache();
      return json(res, 200, { movie: rows[0] });
    }
    const rows = await sql`DELETE FROM public.movies WHERE id = ${String(body.id)} RETURNING id`;
    if (!rows.length) return json(res, 404, { error: 'Movie not found' });
    await invalidateCache();
    return json(res, 200, { deleted: true, id: String(rows[0].id) });
  } catch (error) {
    console.error('movies-api-error', error.message);
    return json(res, 503, { error: 'Movie service temporarily unavailable' }, { 'Retry-After': '30' });
  }
}
