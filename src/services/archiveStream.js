export const ARCHIVE_STREAM_PROXY = 'https://archive-movie-proxy.2aliishhfaq.workers.dev';
export const FMP4_RANGE_CHUNK_BYTES = 8 * 1024 * 1024;

const ARCHIVE_HOST = host => host === 'archive.org' || host.endsWith('.archive.org');
const FMP4_EXTENSION = /\.(?:mp4|m4v|mpeg4)$/i;

/**
 * Route public Internet Archive MP4 files through the range-aware edge proxy.
 * Keep non-Archive URLs untouched; the Worker intentionally only allows archive.org.
 */
export function getArchiveStreamUrl(source) {
  try {
    const target = new URL(source);
    if (target.protocol !== 'https:' || !ARCHIVE_HOST(target.hostname.toLowerCase())) return source;
    if (!FMP4_EXTENSION.test(target.pathname)) return source;
    const proxy = new URL('/stream', ARCHIVE_STREAM_PROXY);
    proxy.searchParams.set('url', target.toString());
    return proxy.toString();
  } catch {
    return source;
  }
}

export function isFmp4FileName(name) {
  return typeof name === 'string' && FMP4_EXTENSION.test(name);
}
