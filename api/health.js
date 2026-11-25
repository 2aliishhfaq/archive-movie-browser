import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); res.status(405).end(); return; }
  const checks = { database: false, redis: false };
  try {
    if (process.env.DATABASE_URL) {
      const sql = neon(process.env.DATABASE_URL);
      await sql`SELECT 1 AS ok`;
      checks.database = true;
    }
  } catch (error) { console.error('health-database', error.message); }
  try {
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    if (url && token) {
      const response = await fetch(url.replace(/\/+$/, ''), {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(['PING']),
        signal: AbortSignal.timeout(2500),
      });
      checks.redis = response.ok && (await response.json()).result === 'PONG';
    }
  } catch (error) { console.error('health-redis', error.message); }
  const ok = checks.database;
  const degraded = ok && !checks.redis;
  res.statusCode = ok ? 200 : 503;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ ok, degraded, service: 'archive-movie-browser-api', checks }));
}
