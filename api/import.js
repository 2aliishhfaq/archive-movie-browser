import { neon } from '@neondatabase/serverless';
import { timingSafeEqual } from 'node:crypto';

const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
};

const authorized = req => {
  const expected = Buffer.from(String(process.env.MOVIES_ADMIN_TOKEN || ''));
  const header = String(req.headers.authorization || '').trim();
  const receivedValue = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : header;
  const received = Buffer.from(receivedValue);
  return expected.length > 0 && expected.length === received.length && timingSafeEqual(expected, received);
};

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 8192) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function pickPlayableFile(files = []) {
  const extensions = { mp4: 100, m4v: 95, webm: 80, ogv: 65, ogg: 60, mov: 50, mpg: 40, mpeg: 40, mkv: 35 };
  return files
    .filter(file => file && typeof file.name === 'string' && file.name.length < 500)
    .map(file => {
      const ext = file.name.split('.').pop().toLowerCase();
      const score = extensions[ext] || 0;
      const size = Number(file.size || 0);
      return { file, score: score + (size > 5_000_000 ? 5 : 0) };
    })
    .filter(item => item.score > 0 && (!item.file.source || item.file.source === 'original'))
    .sort((a, b) => b.score - a.score || Number(b.file.size || 0) - Number(a.file.size || 0))[0]?.file || null;
}

function archiveDownloadUrl(identifier, filename) {
  const encodedName = filename.split('/').map(encodeURIComponent).join('/');
  return 'https://archive.org/download/' + encodeURIComponent(identifier) + '/' + encodedName;
}

function categoryFromMetadata(metadata, requestedCategory) {
  if (requestedCategory) return requestedCategory.slice(0, 100);
  const subject = metadata.subject;
  const first = Array.isArray(subject) ? subject[0] : subject;
  return typeof first === 'string' && first.trim() ? first.trim().slice(0, 100) : 'Feature Films';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { error: 'Method not allowed' });
  }
  if (!authorized(req)) return json(res, 401, { error: 'Admin authorization required' });
  if (!process.env.DATABASE_URL) return json(res, 503, { error: 'Database is not configured' });

  let body;
  try { body = await readBody(req); }
  catch (error) { return json(res, error.message === 'Body too large' ? 413 : 400, { error: error.message }); }

  const requestedQuery = typeof body.query === 'string' ? body.query.trim().slice(0, 120) : '';
  const category = typeof body.category === 'string' ? body.category.trim().slice(0, 100) : '';
  const limit = Math.min(5, Math.max(1, Number.parseInt(body.limit, 10) || 5));
  const searchQuery = requestedQuery
    ? 'mediatype:movies AND (' + requestedQuery.replaceAll('"', '').replaceAll('[', ' ').replaceAll(']', ' ').replaceAll('{', ' ').replaceAll('}', ' ').replaceAll(':', ' ').replaceAll('*', ' ').split(' ').filter(Boolean).join(' ') + ')'
    : 'mediatype:movies AND collection:feature_films';

  const searchUrl = new URL('https://archive.org/advancedsearch.php');
  searchUrl.searchParams.set('q', searchQuery);
  searchUrl.searchParams.append('fl[]', 'identifier');
  searchUrl.searchParams.append('fl[]', 'title');
  searchUrl.searchParams.append('rows', String(limit));
  searchUrl.searchParams.append('page', '1');
  searchUrl.searchParams.append('output', 'json');
  searchUrl.searchParams.append('sort[]', 'downloads desc');

  try {
    const searchResponse = await fetch(searchUrl, { signal: AbortSignal.timeout(9000) });
    if (!searchResponse.ok) throw new Error('Internet Archive search returned HTTP ' + searchResponse.status);
    const searchData = await searchResponse.json();
    const docs = searchData?.response?.docs || [];
    if (!docs.length) return json(res, 200, { imported: [], importedCount: 0, skippedCount: 0, totalFound: 0, message: 'No matching Internet Archive films were found.' });

    const sql = neon(process.env.DATABASE_URL, { fetchOptions: { signal: AbortSignal.timeout(8000) } });
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
        const movieCategory = categoryFromMetadata(metadata, category);
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

    if (imported.length) {
      const restUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
      const restToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
      if (restUrl && restToken) {
        try {
          while (restUrl.endsWith('/')) restUrl = restUrl.slice(0, -1);
          const response = await fetch(restUrl, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + restToken, 'Content-Type': 'application/json' },
            body: JSON.stringify(['INCR', 'movies:cache-version']),
            signal: AbortSignal.timeout(2500),
          });
          if (!response.ok) console.error('archive-import-cache-invalidation', response.status);
        } catch (error) { console.error('archive-import-cache-invalidation', error.message); }
      }
    }

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
