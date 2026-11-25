import { neon } from '@neondatabase/serverless';
import { timingSafeEqual } from 'node:crypto';
import { Redis } from '@upstash/redis';

const TABLE = 'public.movies';
const CACHE_TTL = 300;
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
    return url.protocol === 'https:' && (url.hostname === 'archive.org' || url.hostname.endsWith('.archive.org'));
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
let redisClient;
function getRedis() {
  if (!redisReady()) return null;
  if (!redisClient) redisClient = new Redis(redisConfig());
  return redisClient;
}
async function cached(key, load) {
  const redis = getRedis();
  if (!redis) return { value: await load(), hit: false, configured: false };
  try {
    let version = await redis.get(CACHE_VERSION_KEY);
    if (!version) {
      await redis.set(CACHE_VERSION_KEY, '1', { nx: true });
      version = await redis.get(CACHE_VERSION_KEY) || '1';
    }
    const cacheKey = 'movies:v' + version + ':' + key;
    const stored = await redis.get(cacheKey);
    if (stored !== null && stored !== undefined) return { value: stored, hit: true, configured: true };
    const value = await load();
    await redis.set(cacheKey, value, { ex: CACHE_TTL });
    return { value, hit: false, configured: true };
  } catch (error) {
    console.error('redis-cache-bypass', error.message);
    return { value: await load(), hit: false, configured: true, degraded: true };
  }
}
async function invalidateCache() {
  const redis = getRedis();
  if (!redis) return;
  try { await redis.incr(CACHE_VERSION_KEY); }
  catch (error) { console.error('redis-invalidation-failed', error.message); }
}
function readBody(req) {
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
export default async function handler(req, res) {
  const method = req.method || 'GET';
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) {
    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return json(res, 405, { error: 'Method not allowed' });
  }
  if (method !== 'GET' && !isAdmin(req)) return json(res, 401, { error: 'Admin authorization required' });
  if (!process.env.DATABASE_URL) return json(res, 503, { error: 'Database is not configured' });
  const sql = neon(process.env.DATABASE_URL, { fetchOptions: { signal: AbortSignal.timeout(8000) } });
  try {
    if (method === 'GET') {
      const id = req.query?.id;
      const q = String(req.query?.q || '').trim().slice(0, 100);
      const category = String(req.query?.category || '').trim().slice(0, 100);
      const limit = Math.min(100, Math.max(1, Number.parseInt(req.query?.limit, 10) || 24));
      const offset = Math.max(0, Number.parseInt(req.query?.offset, 10) || 0);
      const key = JSON.stringify({ id: id || null, q, category, limit, offset });
      const result = await cached(key, async () => {
        if (id !== undefined) {
          if (!validId(id)) return { movie: null };
          const rows = await sql`SELECT id, movie_name, category, poster, movie_link FROM ${sql.unsafe(TABLE)} WHERE id = ${String(id)} LIMIT 1`;
          return { movie: rows[0] || null };
        }
        if (req.query?.categories === '1') {
          const rows = await sql`SELECT DISTINCT category FROM ${sql.unsafe(TABLE)} WHERE category IS NOT NULL AND category <> '' ORDER BY category ASC`;
          return { categories: rows.map(row => row.category) };
        }
        const rows = await sql`SELECT id, movie_name, category, poster, movie_link FROM ${sql.unsafe(TABLE)} WHERE (${q} = '' OR movie_name ILIKE ${'%' + q + '%'}) AND (${category} = '' OR category = ${category}) ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`;
        const countRows = await sql`SELECT COUNT(*)::bigint AS total FROM ${sql.unsafe(TABLE)} WHERE (${q} = '' OR movie_name ILIKE ${'%' + q + '%'}) AND (${category} = '' OR category = ${category})`;
        return { movies: rows, total: Number(countRows[0]?.total || 0), limit, offset };
      });
      return json(res, 200, result.value, { 'X-Cache': result.hit ? 'HIT' : result.degraded ? 'BYPASS-ERROR' : result.configured ? 'MISS' : 'DISABLED' });
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const movie = validateMovie(body);
      if (typeof movie === 'string') return json(res, 400, { error: movie });
      const rows = await sql`INSERT INTO ${sql.unsafe(TABLE)} (movie_name, category, poster, movie_link) VALUES (${movie.movie_name}, ${movie.category}, ${movie.poster}, ${movie.movie_link}) RETURNING id, movie_name, category, poster, movie_link`;
      await invalidateCache();
      return json(res, 201, { movie: rows[0] });
    }
    const body = await readBody(req);
    if (!validId(body.id)) return json(res, 400, { error: 'A valid numeric id is required' });
    if (method === 'PUT') {
      const movie = validateMovie(body);
      if (typeof movie === 'string') return json(res, 400, { error: movie });
      const rows = await sql`UPDATE ${sql.unsafe(TABLE)} SET movie_name = ${movie.movie_name}, category = ${movie.category}, poster = ${movie.poster}, movie_link = ${movie.movie_link} WHERE id = ${String(body.id)} RETURNING id, movie_name, category, poster, movie_link`;
      if (!rows.length) return json(res, 404, { error: 'Movie not found' });
      await invalidateCache();
      return json(res, 200, { movie: rows[0] });
    }
    const rows = await sql`DELETE FROM ${sql.unsafe(TABLE)} WHERE id = ${String(body.id)} RETURNING id`;
    if (!rows.length) return json(res, 404, { error: 'Movie not found' });
    await invalidateCache();
    return json(res, 200, { deleted: true, id: String(rows[0].id) });
  } catch (error) {
    console.error('movies-api-error', error.message);
    return json(res, 500, { error: 'Movie service temporarily unavailable' });
  }
}
