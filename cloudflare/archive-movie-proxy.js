const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Range,If-Range,If-None-Match,If-Modified-Since",
  "Access-Control-Expose-Headers": "Content-Length,Content-Range,Accept-Ranges,ETag,Last-Modified,Content-Disposition,X-Cache,X-Data-Source,X-Origin-Cache,X-Stream-Proxy,X-Range-Cache,X-Range-Chunk-Bytes,X-Range-First-Chunk-Bytes"
};
const allowed = host => host === "archive.org" || host.endsWith(".archive.org");
const jsonHeaders = { ...cors, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const CATALOG_ORIGIN = "https://reelboxe.vercel.app/api/movies";
// A manual sync advances the catalogue version. Cache the tiny version pointer at the edge
// for 15 seconds so routine catalogue requests do not hit Redis on every page view.
const CATALOG_VERSION_TTL = 15;
const CATALOG_VERSION_STALE_TTL = 31_536_000;
const CATALOG_TTL = 31_536_000;
const SEARCH_CATALOG_TTL = 86_400;
const FALLBACK_TTL = 300;

function withHeaders(response, extra = {}) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function catalogCacheKeys(requestUrl, version) {
  const request = new URL(requestUrl);
  const fresh = new URL(request.origin);
  fresh.pathname = "/__edge_cache/v4/catalog/" + encodeURIComponent(version) + "/fresh";
  fresh.search = request.search;
  const stale = new URL(request.origin);
  stale.pathname = "/__edge_cache/v4/catalog/" + encodeURIComponent(version) + "/stale";
  stale.search = request.search;
  return [new Request(fresh.toString()), new Request(stale.toString())];
}

export function catalogVersionCacheKeys(requestUrl) {
  const request = new URL(requestUrl);
  const fresh = new URL(request.origin);
  fresh.pathname = "/__edge_cache/v5/catalog-version/fresh";
  const stale = new URL(request.origin);
  stale.pathname = "/__edge_cache/v5/catalog-version/stale";
  return [new Request(fresh.toString()), new Request(stale.toString())];
}

export function catalogFallbackCacheKey(requestUrl, version) {
  const request = new URL(requestUrl);
  const fallback = new URL(request.origin);
  fallback.pathname = "/__edge_cache/v4/catalog/" + encodeURIComponent(version) + "/fallback";
  fallback.search = request.search;
  return new Request(fallback.toString());
}

function archiveVideoFile(files = []) {
  return files
    .filter(file => file && typeof file.name === "string" && file.name.length < 500)
    .map(file => {
      const name = file.name.toLowerCase();
      const extension = name.split(".").pop();
      const format = String(file.format || "").toLowerCase();
      let score = 0;
      if (["mp4", "m4v", "mpeg4"].includes(extension)) {
        score = 1000;
        if (name.endsWith(".ia.mp4")) score += 240;
        else if (format.includes("h.264") || format.includes("h264")) score += 150;
        else if (/_512kb\\.mp4$/.test(name)) score += 80;
        if (file.source && file.source !== "original") score += 10;
      } else if (extension === "webm") score = 760;
      else if (extension === "ogv" || extension === "ogg") score = 620;
      return { file, score, size: Number(file.size || 0) };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || b.size - a.size)[0]?.file || null;
}

function archiveDownloadUrl(identifier, filename) {
  return "https://archive.org/download/" + encodeURIComponent(identifier) + "/" +
    filename.split("/").map(encodeURIComponent).join("/");
}

async function mapArchiveDoc(doc, resolveVideoFile) {
  const identifier = String(doc.identifier || "").trim();
  if (!/^[a-zA-Z0-9._-]{1,200}$/.test(identifier)) return null;
  let movieLink = "https://archive.org/details/" + encodeURIComponent(identifier);
  if (resolveVideoFile) {
    try {
      const metadataResponse = await fetch("https://archive.org/metadata/" + encodeURIComponent(identifier), {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(6000)
      });
      if (metadataResponse.ok) {
        const metadata = await metadataResponse.json();
        const file = archiveVideoFile(metadata.files);
        if (file) movieLink = archiveDownloadUrl(identifier, file.name);
      }
    } catch { /* The Archive.org details embed remains playable if file metadata is unavailable. */ }
  }
  return {
    id: "archive-" + identifier,
    movie_name: String(doc.title || identifier).trim().slice(0, 240),
    category: "Archive.org",
    poster: "https://archive.org/services/img/" + encodeURIComponent(identifier),
    movie_link: movieLink,
    direct_archive: movieLink.includes("/details/")
  };
}
async function archiveCatalogFallback(url) {
  const params = url.searchParams;
  if (params.get("categories") === "1") {
    return { categories: ["Archive.org"] };
  }
  const limit = Math.min(24, Math.max(1, Number.parseInt(params.get("limit") || "24", 10) || 24));
  const offset = Math.max(0, Number.parseInt(params.get("offset") || "0", 10) || 0);
  const query = String(params.get("q") || "").trim().slice(0, 100)
    .replace(/["\x5b\x5d{}:*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const searchUrl = new URL("https://archive.org/advancedsearch.php");
  searchUrl.searchParams.set("q", query ? "mediatype:movies AND (" + query + ")" : "mediatype:movies");
  searchUrl.searchParams.append("fl[]", "identifier");
  searchUrl.searchParams.append("fl[]", "title");
  searchUrl.searchParams.set("rows", String(limit));
  searchUrl.searchParams.set("page", String(Math.floor(offset / limit) + 1));
  searchUrl.searchParams.set("output", "json");
  searchUrl.searchParams.append("sort[]", "downloads desc");

  const searchResponse = await fetch(searchUrl.toString(), {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(9000)
  });
  if (!searchResponse.ok) throw new Error("Archive.org search HTTP " + searchResponse.status);
  const searchData = await searchResponse.json();
  const docs = searchData?.response?.docs || [];
  const movies = [];
  // Resolve direct video file URLs for only two results to stay within the Worker CPU budget.
  for (let index = 0; index < docs.length; index += 4) {
    const batch = await Promise.all(docs.slice(index, index + 4).map((doc, batchIndex) => mapArchiveDoc(doc, index + batchIndex < 2)));
    movies.push(...batch.filter(Boolean));
  }
  return {
    movies,
    total: Number(searchData?.response?.numFound || movies.length),
    limit,
    offset,
    source: "archive.org"
  };
}

async function cacheCatalogResponse(cache, freshKey, staleKey, body, source, ttl, ctx) {
  const baseHeaders = new Headers({
    ...cors,
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "X-Data-Source": source
  });
  const cachedResponse = new Response(body, {
    status: 200,
    headers: new Headers([...baseHeaders, ["Cache-Control", "public, max-age=" + ttl]])
  });
  ctx.waitUntil(Promise.all([
    cache.put(freshKey, cachedResponse.clone()),
    cache.put(staleKey, cachedResponse.clone())
  ]).catch(() => {}));
  return withHeaders(cachedResponse, { "X-Cache": "EDGE-MISS", "Cache-Control": "no-store" });
}

export async function readCatalogCacheVersion() {
  const versionUrl = new URL(CATALOG_ORIGIN);
  versionUrl.searchParams.set('cacheVersion', '1');
  try {
    const response = await fetch(versionUrl.toString(), {
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) return null;
    const state = await response.json();
    return state?.cacheable === true && /^[0-9]{1,24}$/.test(String(state.version))
      ? String(state.version)
      : null;
  } catch {
    return null;
  }
}

export async function resolveCachedCatalogVersion(requestUrl, cache, ctx) {
  const [freshKey, staleKey] = catalogVersionCacheKeys(requestUrl);
  try {
    const cached = await cache.match(freshKey);
    if (cached) {
      const version = (await cached.text()).trim();
      if (/^[0-9]{1,24}$/.test(version)) return version;
    }
  } catch { /* Try the origin pointer and then the long-lived stale pointer. */ }

  const version = await readCatalogCacheVersion();
  if (version) {
    const fresh = new Response(version, { headers: { "Cache-Control": "public, max-age=" + CATALOG_VERSION_TTL } });
    const stale = new Response(version, { headers: { "Cache-Control": "public, max-age=" + CATALOG_VERSION_STALE_TTL } });
    const writes = Promise.all([
      cache.put(freshKey, fresh),
      cache.put(staleKey, stale)
    ]).catch(() => {});
    if (ctx?.waitUntil) ctx.waitUntil(writes);
    else await writes;
    return version;
  }

  try {
    const stale = await cache.match(staleKey);
    if (stale) {
      const staleVersion = (await stale.text()).trim();
      if (/^[0-9]{1,24}$/.test(staleVersion)) return staleVersion;
    }
  } catch { /* Without a known version, the live Archive.org fallback remains available. */ }
  return null;
}

async function handleCatalog(request, ctx) {
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: { ...jsonHeaders, Allow: "GET, OPTIONS" } });
  }
  const url = new URL(request.url);
  const cache = caches.default;
  const version = await resolveCachedCatalogVersion(url, cache, ctx);
  const cacheEnabled = Boolean(version);
  const [freshKey, staleKey] = cacheEnabled ? catalogCacheKeys(url, version) : [null, null];
  const fallbackKey = cacheEnabled ? catalogFallbackCacheKey(url, version) : null;
  const cacheTtl = url.searchParams.get("q")?.trim() ? SEARCH_CATALOG_TTL : CATALOG_TTL;

  if (cacheEnabled) {
    try {
      const fresh = await cache.match(freshKey);
      if (fresh) return withHeaders(fresh, { 'X-Cache': 'EDGE-HIT', 'X-Movies-Cache-Version': version, 'Cache-Control': 'no-store' });
    } catch { /* Cache API failures fall through to origin/fallback. */ }
  }

  let stale = null;
  if (cacheEnabled) {
    try { stale = await cache.match(staleKey); } catch { /* The Archive.org fallback still works without cache. */ }
  }

  const originUrl = new URL(CATALOG_ORIGIN);
  originUrl.search = url.search;
  try {
    const origin = await fetch(originUrl.toString(), {
      headers: { Accept: "application/json", "Cache-Control": "no-cache", Pragma: "no-cache" },
      signal: AbortSignal.timeout(7000)
    });
    if (origin.ok) {
      const body = await origin.text();
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = null; }
      if (parsed && typeof parsed === "object") {
        const source = "database";
        const response = cacheEnabled
          ? await cacheCatalogResponse(cache, freshKey, staleKey, JSON.stringify(parsed), source, cacheTtl, ctx)
          : withHeaders(new Response(JSON.stringify(parsed), { status: 200, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } }), { "X-Cache": "BYPASS-NO-VERSION" });
        const headers = new Headers(response.headers);
        const originCache = origin.headers.get("X-Cache");
        if (originCache) headers.set("X-Origin-Cache", originCache);
        if (version) headers.set("X-Movies-Cache-Version", version);
        return new Response(response.body, { status: response.status, headers });
      }
    }
  } catch { /* Vercel/Neon/Redis quota, rate-limit, or network failure. */ }

  if (stale) return withHeaders(stale, { "X-Cache": "EDGE-STALE", "Warning": '110 - "Response is stale"', "Cache-Control": "no-store" });

  // Archive.org is an outage fallback, never the canonical catalogue. Keep it in a
  // separate short-lived key so a temporary database outage cannot poison the year-long cache.
  if (cacheEnabled) {
    try {
      const fallback = await cache.match(fallbackKey);
      if (fallback) return withHeaders(fallback, {
        "X-Cache": "ARCHIVE-FALLBACK-HIT",
        "X-Movies-Cache-Version": version,
        "Cache-Control": "no-store"
      });
    } catch { /* Continue to the live Archive.org fallback. */ }
  }

  try {
    const archiveData = await archiveCatalogFallback(url);
    const body = JSON.stringify(archiveData);
    if (cacheEnabled) {
      const fallbackResponse = new Response(body, {
        status: 200,
        headers: {
          ...cors,
          "Content-Type": "application/json; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
          "X-Data-Source": "archive.org",
          "Cache-Control": "public, max-age=" + FALLBACK_TTL
        }
      });
      ctx.waitUntil(cache.put(fallbackKey, fallbackResponse.clone()).catch(() => {}));
      return withHeaders(fallbackResponse, {
        "X-Cache": "ARCHIVE-FALLBACK",
        "X-Movies-Cache-Version": version,
        "Cache-Control": "no-store"
      });
    }
    return new Response(body, {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Cache": "BYPASS-NO-VERSION" }
    });
  } catch {
    return Response.json(
      { error: "Catalogue temporarily unavailable", movies: [], total: 0, source: "unavailable" },
      { status: 503, headers: { ...jsonHeaders, "Retry-After": "30", "X-Cache": "UNAVAILABLE" } }
    );
  }
}

function safeDownloadName(requestedTitle, finalUrl, contentType) {
  const pathName = decodeURIComponent(new URL(finalUrl).pathname.split("/").pop() || "");
  const pathExtension = pathName.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase();
  const mimeExtensions = {
    "video/mp4": "mp4", "video/x-matroska": "mkv", "video/webm": "webm",
    "video/quicktime": "mov", "video/x-msvideo": "avi", "video/mpeg": "mpg", "video/ogg": "ogv"
  };
  const extension = pathExtension || mimeExtensions[(contentType || "").split(";")[0].trim().toLowerCase()] || "mp4";
  const title = (requestedTitle || "Reelbox Movie")
    .normalize("NFKC")
    .replace(/[\\\x2f?%*:|"<>]/g, " ")
    .split("")
    .filter(char => { const code = char.charCodeAt(0); return code >= 32 && code !== 127; })
    .join("")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120) || "Reelbox Movie";
  const base = title.replace(new RegExp("\\." + extension + "$", "i"), "").trim() || "Reelbox Movie";
  const filename = base + "." + extension;
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\;]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, char =>
    "%" + char.charCodeAt(0).toString(16).toUpperCase()
  );
  return "attachment; filename=\"" + asciiFallback + "\"; filename*=UTF-8''" + encoded;
}


const MAX_HLS_PLAYLIST_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const HLS_SEGMENT_TTL = 3600;
const HLS_PLAYLIST_TTL = 60;
const FMP4_FIRST_CHUNK_BYTES = 1 * 1024 * 1024;
const FMP4_RANGE_CHUNK_BYTES = 8 * 1024 * 1024;
const FMP4_RANGE_CACHE_TTL = 3600;
const FMP4_MAX_CACHEABLE_RANGE_BYTES = 32 * 1024 * 1024;

function isAllowedArchiveUrl(value) {
  try {
    const url = value instanceof URL ? value : new URL(value);
    return url.protocol === "https:" &&
      allowed(url.hostname.toLowerCase()) &&
      !url.username && !url.password &&
      (!url.port || url.port === "443");
  } catch { return false; }
}

async function fetchArchiveResource(target, init = {}) {
  let current = target instanceof URL ? new URL(target.toString()) : new URL(target);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    if (!isAllowedArchiveUrl(current)) throw new Error("Archive URL or redirect is not allowed");
    const response = await fetch(current.toString(), { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: current.toString() };
    }
    const location = response.headers.get("Location");
    if (!location) return { response, finalUrl: current.toString() };
    const next = new URL(location, current);
    try { await response.body?.cancel(); } catch {}
    if (!isAllowedArchiveUrl(next)) throw new Error("Blocked an upstream redirect outside archive.org");
    current = next;
  }
  throw new Error("Too many upstream redirects");
}

function streamingHeaders(upstream, request, extra = {}) {
  const headers = new Headers();
  for (const name of [
    "content-type", "content-length", "content-range", "accept-ranges",
    "etag", "last-modified", "expires", "cache-control", "vary"
  ]) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  for (const [name, value] of Object.entries(cors)) headers.set(name, value);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Stream-Proxy", "archive-range");
  if (request.headers.has("Range") || [206, 304, 416].includes(upstream.status)) {
    headers.set("Cache-Control", "private, no-store");
  }
  for (const [name, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null) headers.set(name, value);
  }
  return headers;
}

async function readBoundedText(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("HLS playlist exceeds the size limit");
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function hlsResourceUrl(requestUrl, targetUrl) {
  const proxy = new URL("/hls", requestUrl);
  proxy.searchParams.set("url", targetUrl.toString());
  return proxy.toString();
}

function rewriteHlsPlaylist(text, playlistUrl, requestUrl) {
  const rewrite = rawUri => {
    if (!rawUri || /^(?:data:|skd:|urn:)/i.test(rawUri)) return rawUri;
    try {
      const resolved = new URL(rawUri, playlistUrl);
      return isAllowedArchiveUrl(resolved) ? hlsResourceUrl(requestUrl, resolved) : rawUri;
    } catch { return rawUri; }
  };
  return text.split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith("#")) {
      return line.replace(/URI="([^"]+)"/gi, (_match, uri) => 'URI="' + rewrite(uri) + '"');
    }
    return rewrite(trimmed);
  }).join("\n");
}

function isHlsPlaylist(target, contentType) {
  return /\.m3u8?$/i.test(target.pathname) ||
    /(?:mpegurl|vnd\.apple\.mpegurl)/i.test(contentType || "");
}

function isCacheableHlsSegment(target) {
  return /\.(?:ts|m4s|aac|vtt|mp4|cmfv|cmfa)$/i.test(target.pathname);
}

async function handleHls(request, ctx) {
  if (!["GET", "HEAD"].includes(request.method)) {
    return Response.json({ error: "Method not allowed" }, {
      status: 405, headers: { ...jsonHeaders, Allow: "GET, HEAD, OPTIONS" }
    });
  }
  const url = new URL(request.url);
  const raw = url.searchParams.get("url");
  if (!raw || raw.length > 8192) {
    return Response.json({ error: "Provide a valid ?url=https://archive.org/... address" }, {
      status: 400, headers: jsonHeaders
    });
  }
  let target;
  try { target = new URL(raw); } catch {
    return Response.json({ error: "Invalid upstream URL" }, { status: 400, headers: jsonHeaders });
  }
  if (!isAllowedArchiveUrl(target)) {
    return Response.json({ error: "Only HTTPS Internet Archive hosts are allowed" }, {
      status: 403, headers: jsonHeaders
    });
  }

  const hasRange = request.headers.has("Range");
  const cache = caches.default;
  const cacheKey = new Request(request.url, { method: "GET" });
  const cacheableCandidate = request.method === "GET" && !hasRange;
  if (cacheableCandidate) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) return withHeaders(cached, { "X-Cache": "HLS-HIT" });
    } catch {}
  }

  const upstreamHeaders = new Headers();
  for (const name of ["Range", "If-Range", "If-None-Match", "If-Modified-Since"]) {
    const value = request.headers.get(name);
    if (value) upstreamHeaders.set(name, value);
  }
  let fetched;
  try {
    fetched = await fetchArchiveResource(target, { method: request.method, headers: upstreamHeaders });
  } catch {
    return Response.json({ error: "Archive stream could not be reached safely" }, {
      status: 502, headers: { ...jsonHeaders, "X-Stream-Error": "upstream" }
    });
  }

  const upstream = fetched.response;
  const finalUrl = new URL(fetched.finalUrl);
  const contentType = upstream.headers.get("Content-Type") || "";
  if (request.method === "HEAD" || !upstream.ok || !isHlsPlaylist(finalUrl, contentType)) {
    const headers = streamingHeaders(upstream, request);
    if (cacheableCandidate && request.method === "GET" && upstream.status === 200 &&
        isCacheableHlsSegment(finalUrl) &&
        Number(upstream.headers.get("Content-Length") || 0) > 0 &&
        Number(upstream.headers.get("Content-Length")) <= 32 * 1024 * 1024 &&
        !upstream.headers.has("Set-Cookie")) {
      headers.set("Cache-Control", "public, max-age=" + HLS_SEGMENT_TTL);
      const response = new Response(upstream.body, { status: upstream.status, headers });
      try {
        const clone = response.clone();
        ctx.waitUntil(cache.put(cacheKey, clone).catch(() => {}));
      } catch {}
      return withHeaders(response, { "X-Cache": "HLS-MISS" });
    }
    return new Response(request.method === "HEAD" ? null : upstream.body, {
      status: upstream.status, statusText: upstream.statusText, headers
    });
  }

  const length = Number(upstream.headers.get("Content-Length") || 0);
  if (length > MAX_HLS_PLAYLIST_BYTES) {
    try { await upstream.body?.cancel(); } catch {}
    return Response.json({ error: "HLS playlist exceeds the size limit" }, {
      status: 502, headers: jsonHeaders
    });
  }
  let playlist;
  try { playlist = await readBoundedText(upstream, MAX_HLS_PLAYLIST_BYTES); } catch {
    return Response.json({ error: "Could not read HLS playlist" }, { status: 502, headers: jsonHeaders });
  }
  const rewritten = rewriteHlsPlaylist(playlist, finalUrl, url);
  const isVod = /#EXT-X-ENDLIST(?:\r?\n|$)/.test(rewritten);
  const headers = new Headers({
    ...cors,
    "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "X-Stream-Proxy": "archive-hls",
    "X-Cache": isVod ? "HLS-VOD-MISS" : "HLS-LIVE-BYPASS",
    "Cache-Control": isVod ? "public, max-age=" + HLS_PLAYLIST_TTL : "no-store"
  });
  const response = new Response(rewritten, { status: upstream.status, headers });
  if (cacheableCandidate && isVod) {
    try {
      const clone = response.clone();
      ctx.waitUntil(cache.put(cacheKey, clone).catch(() => {}));
    } catch {}
  }
  return response;
}


function parseExplicitByteRange(value) {
  const match = /^bytes=(\d+)-(\d*)$/i.exec(String(value || "").trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] === "" ? null : Number(match[2]);
  if (!Number.isSafeInteger(start) || start < 0 || (end !== null && (!Number.isSafeInteger(end) || end < start))) return null;
  if (end !== null && end - start + 1 > FMP4_MAX_CACHEABLE_RANGE_BYTES) return null;
  return { start, end };
}

function parseContentRange(value) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(String(value || "").trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || total <= end) return null;
  return { start, end, total };
}

/* global FixedLengthStream */
// Identity stream: declares an exact HTTP byte length without buffering or changing the bytes.
function withFixedLengthStream(body, length) {
  const FixedLength = typeof FixedLengthStream === "function" ? FixedLengthStream : null;
  if (!body || !FixedLength || !Number.isSafeInteger(length) || length < 0) return body;
  const fixed = new FixedLength(length);
  body.pipeTo(fixed.writable).catch(() => {});
  return fixed.readable;
}

export async function createFmp4CacheBlock(request) {
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
  const url = new URL(request.url);
  const raw = url.searchParams.get("url");
  if (!raw || raw.length > 8192) return new Response("Invalid Archive source", { status: 400, headers: { "Cache-Control": "no-store" } });
  let target;
  try { target = new URL(raw); } catch { return new Response("Invalid Archive source", { status: 400, headers: { "Cache-Control": "no-store" } }); }
  if (!isAllowedArchiveUrl(target)) return new Response("Archive host is not allowed", { status: 403, headers: { "Cache-Control": "no-store" } });
  const chunkStart = Number(url.searchParams.get("start"));
  if (!Number.isSafeInteger(chunkStart) || chunkStart < 0 || (chunkStart === 0 ? false : chunkStart < FMP4_FIRST_CHUNK_BYTES || (chunkStart - FMP4_FIRST_CHUNK_BYTES) % FMP4_RANGE_CHUNK_BYTES !== 0)) {
    return new Response("Invalid aligned byte block", { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const chunkBytes = chunkStart === 0 ? FMP4_FIRST_CHUNK_BYTES : FMP4_RANGE_CHUNK_BYTES;
  const chunkEnd = chunkStart + chunkBytes - 1;
  const upstreamHeaders = new Headers({ Range: "bytes=" + chunkStart + "-" + chunkEnd, "Accept-Encoding": "identity" });
  let fetched;
  try { fetched = await fetchArchiveResource(target, { method: "GET", headers: upstreamHeaders }); } catch {
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "X-Range-Cache-Bypass": "upstream-unavailable" } });
  }
  const upstream = fetched.response;
  const range = parseContentRange(upstream.headers.get("Content-Range"));
  const expectedEnd = range ? Math.min(chunkEnd, range.total - 1) : -1;
  const rawType = (upstream.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  const pathIsMp4 = /\.(?:mp4|m4v|mpeg4)$/i.test(target.pathname);
  const isMp4 = rawType === "video/mp4" || (rawType === "application/octet-stream" && pathIsMp4);
  if (upstream.status !== 206 || !range || range.start !== chunkStart || range.end !== expectedEnd || !isMp4 || upstream.headers.has("Set-Cookie")) {
    try { await upstream.body?.cancel(); } catch {}
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "X-Range-Cache-Bypass": "upstream-range-unavailable" } });
  }
  const headers = new Headers({
    "Content-Type": "video/mp4",
    "Content-Length": String(range.end - range.start + 1),
    "Cache-Control": "public, max-age=" + FMP4_RANGE_CACHE_TTL,
    "X-Range-Chunk-Start": String(chunkStart),
    "X-Range-Chunk-Length": String(range.end - range.start + 1),
    "X-Range-Total": String(range.total)
  });
  const etag = upstream.headers.get("ETag");
  const lastModified = upstream.headers.get("Last-Modified");
  if (etag) headers.set("ETag", etag);
  if (lastModified) headers.set("Last-Modified", lastModified);
  return new Response(upstream.body, { status: 200, headers });
}

async function loadFmp4RangeBlock(request, target, ctx, chunkStart) {
  try {
    const blockUrl = new URL("/__fmp4_cache_block_v3", request.url);
    blockUrl.searchParams.set("url", target.toString());
    blockUrl.searchParams.set("start", String(chunkStart));
    const blockRequest = new Request(blockUrl.toString(), { method: "GET" });
    const response = await ctx.exports.Fmp4RangeCache.fetch(blockRequest);
    if (response.status !== 200) { try { await response.body?.cancel(); } catch {} return null; }
    const total = Number(response.headers.get("X-Range-Total"));
    const length = Number(response.headers.get("X-Range-Chunk-Length") || response.headers.get("Content-Length"));
    if (!Number.isSafeInteger(total) || total <= chunkStart || !Number.isSafeInteger(length) || length < 1 || length > (chunkStart === 0 ? FMP4_FIRST_CHUNK_BYTES : FMP4_RANGE_CHUNK_BYTES)) {
      try { await response.body?.cancel(); } catch {}
      return null;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== length) return null;
    return {
      bytes, total, chunkStart,
      contentType: response.headers.get("Content-Type") || "video/mp4",
      etag: response.headers.get("ETag"),
      lastModified: response.headers.get("Last-Modified"),
      cacheStatus: response.headers.get("CF-Cache-Status") === "HIT" ? "HIT" : "MISS"
    };
  } catch { return null; }
}

function fmp4RangeBody(request, target, ctx, firstBlock, start, end) {
  let cursor = start;
  let nextBlock = firstBlock;
  return new ReadableStream({
    async pull(controller) {
      try {
        if (cursor > end) { controller.close(); return; }
        const chunkStart = cursor < FMP4_FIRST_CHUNK_BYTES
          ? 0
          : FMP4_FIRST_CHUNK_BYTES + Math.floor((cursor - FMP4_FIRST_CHUNK_BYTES) / FMP4_RANGE_CHUNK_BYTES) * FMP4_RANGE_CHUNK_BYTES;
        const block = nextBlock && nextBlock.chunkStart === chunkStart
          ? nextBlock
          : await loadFmp4RangeBlock(request, target, ctx, chunkStart);
        nextBlock = null;
        if (!block || !block.bytes) throw new Error("Archive.org could not provide a complete aligned fMP4 byte block");
        const offset = cursor - chunkStart;
        if (offset < 0 || offset >= block.bytes.byteLength) throw new Error("fMP4 chunk offset is outside the cached block");
        const count = Math.min(end - cursor + 1, block.bytes.byteLength - offset);
        if (count < 1) throw new Error("fMP4 chunk returned no requested bytes");
        controller.enqueue(block.bytes.subarray(offset, offset + count));
        cursor += count;
        if (cursor > end) controller.close();
      } catch (error) { controller.error(error); }
    }
  });
}

async function handleFmp4Range(request, target, ctx) {
  if (request.method !== "GET" || request.headers.has("If-Range") ||
      request.headers.has("If-None-Match") || request.headers.has("If-Modified-Since")) return null;

  const requested = parseExplicitByteRange(request.headers.get("Range"));
  if (!requested || new URL(request.url).searchParams.get("download") === "1") return null;

  const firstChunkStart = requested.start < FMP4_FIRST_CHUNK_BYTES
    ? 0
    : FMP4_FIRST_CHUNK_BYTES + Math.floor((requested.start - FMP4_FIRST_CHUNK_BYTES) / FMP4_RANGE_CHUNK_BYTES) * FMP4_RANGE_CHUNK_BYTES;
  const firstBlock = await loadFmp4RangeBlock(request, target, ctx, firstChunkStart);
  if (!firstBlock) return null;

  if (firstBlock.passthrough) {
    const upstream = firstBlock.passthrough;
    const headers = streamingHeaders(upstream, request);
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
  }

  const total = firstBlock.total;
  if (requested.start >= total) {
    return new Response(null, {
      status: 416,
      headers: {
        ...cors,
        "Accept-Ranges": "bytes",
        "Content-Range": "bytes */" + total,
        "Content-Length": "0",
        "Cache-Control": "private, no-store",
        "X-Stream-Proxy": "fmp4-range-cache"
      }
    });
  }

  // For open-ended browser ranges, advertise the full remaining representation.
  // The response body pulls a 1 MiB startup block, then 8 MiB blocks on demand.
  const end = requested.end === null ? total - 1 : Math.min(requested.end, total - 1);
  const responseHeaders = new Headers({
    ...cors,
    "Content-Type": "video/mp4",
    "Content-Length": String(end - requested.start + 1),
    "Content-Range": "bytes " + requested.start + "-" + end + "/" + total,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "X-Stream-Proxy": "fmp4-range-cache",
    "X-Range-Cache": firstBlock.cacheStatus || "HIT",
    "X-Range-Chunk-Bytes": String(FMP4_RANGE_CHUNK_BYTES),
    "X-Range-First-Chunk-Bytes": String(FMP4_FIRST_CHUNK_BYTES)
  });
  if (firstBlock.etag) responseHeaders.set("ETag", firstBlock.etag);
  if (firstBlock.lastModified) responseHeaders.set("Last-Modified", firstBlock.lastModified);

  const responseLength = end - requested.start + 1;
  const body = fmp4RangeBody(request, target, ctx, firstBlock, requested.start, end);
  // FixedLengthStream is an identity stream: it preserves the exact HTTP length while
  // propagating backpressure and cancellation to the on-demand block reader.
  return new Response(withFixedLengthStream(body, responseLength), {
    status: 206,
    headers: responseHeaders
  });
}

async function handleStreamProxy(request, ctx) {
  if (!["GET", "HEAD"].includes(request.method)) {
    return Response.json({ error: "Method not allowed" }, {
      status: 405, headers: { ...jsonHeaders, Allow: "GET, HEAD, OPTIONS" }
    });
  }
  const url = new URL(request.url);
  const raw = url.searchParams.get("url");
  if (!raw || raw.length > 8192) {
    return Response.json({ error: "Provide ?url=https://archive.org/download/..." }, {
      status: 400, headers: jsonHeaders
    });
  }
  let target;
  try { target = new URL(raw); } catch {
    return Response.json({ error: "Invalid URL" }, { status: 400, headers: jsonHeaders });
  }
  if (!isAllowedArchiveUrl(target)) {
    return Response.json({ error: "Only HTTPS Internet Archive hosts are allowed" }, {
      status: 403, headers: jsonHeaders
    });
  }
  // Exact client ranges are served from 8 MiB aligned edge-cache blocks.
  try {
    const cachedRange = await handleFmp4Range(request, target, ctx);
    if (cachedRange) return cachedRange;
  } catch { /* Cache optimization must not block direct Range passthrough. */ }
  const headers = new Headers();
  for (const name of ["Range", "If-Range", "If-None-Match", "If-Modified-Since"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  let fetched;
  try {
    fetched = await fetchArchiveResource(target, { method: request.method, headers });
  } catch {
    return Response.json({ error: "Archive stream could not be reached safely" }, {
      status: 502, headers: { ...jsonHeaders, "X-Stream-Error": "upstream" }
    });
  }
  const upstream = fetched.response;
  const responseHeaders = streamingHeaders(upstream, request);
  if (url.searchParams.get("download") === "1" && upstream.ok) {
    responseHeaders.set("Content-Disposition", safeDownloadName(
      url.searchParams.get("filename"), fetched.finalUrl, responseHeaders.get("Content-Type")
    ));
    responseHeaders.set("Cache-Control", "private, no-store");
  } else if (!request.headers.has("Range") && upstream.status === 200) {
    responseHeaders.set("Cache-Control", upstream.headers.get("Cache-Control") || "public, max-age=300");
  }
  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: upstream.status, statusText: upstream.statusText, headers: responseHeaders
  });
}

function healthResponse() {
  return Response.json({
    ok: true, service: "archive-movie-proxy", status: "ready",
    catalogueCache: true, archiveFallback: true,
    rangeStreaming: true, fmp4RangeCache: true, rangeChunkBytes: FMP4_RANGE_CHUNK_BYTES, firstRangeChunkBytes: FMP4_FIRST_CHUNK_BYTES, hlsProxy: true, secureArchiveAllowlist: true
  }, { headers: jsonHeaders });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if ((url.pathname === "/health" || url.pathname === "/") && ["GET", "HEAD"].includes(request.method) &&
        (url.pathname === "/health" || !url.searchParams.has("url"))) {
      const health = healthResponse();
      return request.method === "HEAD" ? new Response(null, { status: 200, headers: health.headers }) : health;
    }
    if (url.pathname === "/catalog") return handleCatalog(request, ctx);
    if (url.pathname === "/hls") return handleHls(request, ctx);
    if (url.pathname === "/stream" || url.pathname === "/") return handleStreamProxy(request, ctx);

    return Response.json({ error: "Not found" }, { status: 404, headers: jsonHeaders });
  }
};