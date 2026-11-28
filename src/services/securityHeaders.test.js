import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const workerOrigin = 'https://archive-movie-proxy.2aliishhfaq.workers.dev';

const vercelConfig = JSON.parse(await readFile(new URL('vercel.json', root), 'utf8'));
const fallbackHeaders = await readFile(new URL('public/_headers', root), 'utf8');

function directive(csp, name) {
  return csp.split(';').map(part => part.trim()).find(part => part.startsWith(name + ' ')) || '';
}

test('Vercel applies security headers to the SPA and permits the Archive video proxy', () => {
  const rule = vercelConfig.headers?.find(entry => entry.source === '/(.*)');
  assert.ok(rule, 'a catch-all Vercel headers rule must cover application routes');
  const headers = Object.fromEntries(rule.headers.map(({ key, value }) => [key.toLowerCase(), value]));
  const csp = headers['content-security-policy'] || '';

  assert.ok(directive(csp, 'script-src').includes('https://cdn.jsdelivr.net'));
  assert.ok(directive(csp, 'connect-src').includes(workerOrigin));
  assert.ok(directive(csp, 'connect-src').includes('https://archive.org'));
  assert.ok(directive(csp, 'media-src').includes(workerOrigin));
  assert.ok(directive(csp, 'frame-src').includes('https://archive.org'));
  assert.ok(csp.includes("frame-ancestors 'none'"));
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['x-frame-options'], 'DENY');
  assert.equal(headers['referrer-policy'], 'strict-origin-when-cross-origin');
});

test('static-host fallback headers keep the same Archive proxy permissions', () => {
  const cspLine = fallbackHeaders.split('\n').find(line => line.trimStart().startsWith('Content-Security-Policy:')) || '';
  assert.ok(directive(cspLine.replace(/^\s*Content-Security-Policy:\s*/, ''), 'connect-src').includes(workerOrigin));
  assert.ok(directive(cspLine.replace(/^\s*Content-Security-Policy:\s*/, ''), 'media-src').includes(workerOrigin));
  assert.match(fallbackHeaders, /X-Content-Type-Options: nosniff/);
  assert.match(fallbackHeaders, /X-Frame-Options: DENY/);
});
