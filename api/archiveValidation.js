const ARCHIVE_METADATA_API = 'https://archive.org/metadata/';
const PLAYABLE_EXTENSIONS = new Map([
  ['mp4', 100],
  ['m4v', 95],
  ['webm', 90],
  ['ogv', 70],
  ['ogg', 65],
]);

function archiveIdentifierAndFilename(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password ||
      (host !== 'archive.org' && !host.endsWith('.archive.org'))) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (!['download', 'details', 'embed'].includes(parts[0]) || !parts[1]) return null;
  let identifier;
  let filename = null;
  try {
    identifier = decodeURIComponent(parts[1]);
    if (parts[0] === 'download' && parts.length > 2) {
      filename = decodeURIComponent(parts.slice(2).join('/'));
    } else if (parts[0] === 'details' && url.searchParams.has('file')) {
      filename = url.searchParams.get('file');
    } else if (parts[0] === 'embed' && url.searchParams.has('file')) {
      filename = url.searchParams.get('file');
    }
  } catch { return null; }
  if (!/^[a-zA-Z0-9._-]{1,200}$/.test(identifier)) return null;
  if (filename && (filename.length > 499 || filename.split('/').some(part => !part || part === '.' || part === '..'))) return null;
  return { identifier, filename };
}

function choosePlayableArchiveFile(files, requestedFilename) {
  if (!Array.isArray(files)) return null;
  const candidates = files.filter(file =>
    file && typeof file.name === 'string' && file.name.length < 500 &&
    PLAYABLE_EXTENSIONS.has(file.name.split('.').pop().toLowerCase()) &&
    (!file.source || file.source === 'original') &&
    Number.isSafeInteger(Number(file.size)) && Number(file.size) > 0
  );
  if (requestedFilename) {
    return candidates.find(file => file.name === requestedFilename) || null;
  }
  return candidates.sort((a, b) => {
    const score = file => PLAYABLE_EXTENSIONS.get(file.name.split('.').pop().toLowerCase()) +
      (Number(file.size) > 5_000_000 ? 5 : 0);
    return score(b) - score(a) || Number(b.size) - Number(a.size);
  })[0] || null;
}

export function archiveDownloadUrl(identifier, filename) {
  return 'https://archive.org/download/' + encodeURIComponent(identifier) + '/' +
    filename.split('/').map(encodeURIComponent).join('/');
}

/**
 * Resolve and verify a user-supplied Archive.org URL against live item metadata.
 * Returns a canonical direct video URL, or a safe, user-facing validation error.
 */
export async function validateArchiveVideoUrl(value, fetchImpl = fetch) {
  const parsed = archiveIdentifierAndFilename(value);
  if (!parsed) return { ok: false, error: 'Use an HTTPS Internet Archive item, details, embed, or download URL.' };
  let response;
  try {
    response = await fetchImpl(ARCHIVE_METADATA_API + encodeURIComponent(parsed.identifier), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return { ok: false, error: 'Internet Archive could not be reached. Please retry; nothing was published.' };
  }
  if (!response.ok) {
    return { ok: false, error: response.status === 404
      ? 'This Internet Archive item does not exist or is unavailable.'
      : 'Internet Archive metadata is temporarily unavailable. Please retry.' };
  }
  let metadata;
  try { metadata = await response.json(); } catch {
    return { ok: false, error: 'Internet Archive returned invalid item metadata.' };
  }
  if (metadata?.metadata?.mediatype && metadata.metadata.mediatype !== 'movies' && metadata.metadata.mediatype !== 'video') {
    return { ok: false, error: 'This Archive.org item is not a video item.' };
  }
  const file = choosePlayableArchiveFile(metadata.files, parsed.filename);
  if (!file) {
    return { ok: false, error: parsed.filename
      ? 'The selected Archive.org file is missing, empty, or not a supported video format (MP4, M4V, WebM, OGV).'
      : 'No non-empty browser-compatible video file was found in this Archive.org item.' };
  }
  return { ok: true, movieLink: archiveDownloadUrl(parsed.identifier, file.name), file: {
    name: file.name,
    size: Number(file.size),
    format: String(file.format || ''),
  } };
}
