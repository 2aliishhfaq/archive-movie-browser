#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
const base = process.env.BASE_URL;
const catalogueUrl = process.env.CATALOGUE_URL;
const concurrency = Number(process.env.CONCURRENCY || 5);
const requests = Number(process.env.REQUESTS || 40);
if (!base) throw new Error('Set BASE_URL to a Vercel preview deployment.');
const origin = new URL(base);
if (origin.protocol !== 'https:' || origin.hostname === 'reelboxe.vercel.app') throw new Error('Safety stop: BASE_URL must be an HTTPS preview host, never production.');
if (!origin.hostname.endsWith('.vercel.app')) throw new Error('Safety stop: BASE_URL must be a Vercel preview deployment host.');
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) throw new Error('CONCURRENCY must be between 1 and 10.');
if (!Number.isInteger(requests) || requests < 1 || requests > 100) throw new Error('REQUESTS must be between 1 and 100.');
const targets = [
  { name: 'static-shell', url: new URL('/', origin).href, json: false },
  { name: 'public-catalogue', url: new URL('/api/movies?limit=24&edgeCache=1', origin).href, json: true },
];
if (catalogueUrl) {
  const edge = new URL(catalogueUrl);
  if (edge.protocol !== 'https:' || edge.hostname !== 'archive-movie-proxy.2aliishhfaq.workers.dev') throw new Error('CATALOGUE_URL must be the configured Reelbox catalogue Worker URL.');
  targets.push({ name: 'edge-catalogue', url: new URL('/catalog?limit=24', edge).href, json: true });
}
const samples = [];
let next = 0;
const started = performance.now();
async function worker() {
  while (next < requests) {
    const target = targets[next++ % targets.length];
    const begin = performance.now();
    try {
      const response = await fetch(target.url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      const body = await response.text();
      if (!response.ok) throw new Error('HTTP ' + response.status);
      if (target.json) {
        const parsed = JSON.parse(body);
        if (!Array.isArray(parsed.movies) && !Array.isArray(parsed.categories)) throw new Error('Unexpected catalogue payload');
      }
      samples.push({ name: target.name, ms: performance.now() - begin, bytes: Buffer.byteLength(body), status: response.status, cache: response.headers.get('x-cache') || response.headers.get('x-vercel-cache') || response.headers.get('cf-cache-status') || 'n/a' });
    } catch (error) { samples.push({ name: target.name, ms: performance.now() - begin, error: error.message }); }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, worker));
const elapsed = performance.now() - started;
const successful = samples.filter(sample => !sample.error);
const failures = samples.length - successful.length;
const sorted = successful.map(sample => sample.ms).sort((a, b) => a - b);
const percentile = p => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] : null;
const average = sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null;
console.log(JSON.stringify({
  target: origin.hostname, requests, concurrency: Math.min(concurrency, requests), elapsedMs: Math.round(elapsed),
  requestsPerSecond: Number((successful.length / (elapsed / 1000)).toFixed(2)), success: successful.length, failures,
  averageMs: average === null ? null : Math.round(average),
  p50Ms: percentile(0.5) === null ? null : Math.round(percentile(0.5)),
  p95Ms: percentile(0.95) === null ? null : Math.round(percentile(0.95)),
  cacheStatuses: Object.fromEntries([...new Set(successful.map(sample => sample.cache))].map(status => [status, successful.filter(sample => sample.cache === status).length])),
  errors: samples.filter(sample => sample.error).slice(0, 10),
}, null, 2));
if (failures) process.exitCode = 1;
