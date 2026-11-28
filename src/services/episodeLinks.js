/** Normalize stored multi-episode links while keeping legacy one-link records playable. */
export function normalizeEpisodeLinks(movie) {
  const raw = movie?.movie_links;
  const links = Array.isArray(raw) ? raw : [];
  const normalized = links.map((entry, index) => ({
    label: typeof entry?.label === 'string' && entry.label.trim() ? entry.label.trim() : `Episode ${index + 1}`,
    url: typeof entry?.url === 'string' ? entry.url.trim() : '',
  })).filter(entry => entry.url);
  if (normalized.length) return normalized;
  return movie?.movie_link ? [{ label: 'Full Movie', url: movie.movie_link }] : [];
}

export function parseEpisodeLinksJson(value) {
  let parsed;
  try { parsed = JSON.parse(value); }
  catch { return { ok: false, error: 'JSON format valid nahi. Array paste karein.' }; }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 100) {
    return { ok: false, error: '1 se 100 episode links ka JSON array zaroori hai.' };
  }
  const seen = new Set();
  for (const [index, item] of parsed.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        typeof item.label !== 'string' || !item.label.trim() || item.label.trim().length > 80 ||
        typeof item.url !== 'string' || !/^https:\/\/([a-z0-9-]+\.)*archive\.org\//i.test(item.url.trim())) {
      return { ok: false, error: `Episode ${index + 1}: label aur HTTPS archive.org URL required hain.` };
    }
    if (seen.has(item.url.trim())) return { ok: false, error: `Episode ${index + 1}: duplicate URL.` };
    seen.add(item.url.trim());
  }
  return { ok: true, links: parsed.map(item => ({ label: item.label.trim(), url: item.url.trim() })) };
}
