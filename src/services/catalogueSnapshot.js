function normalizeCategory(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function buildCatalogueResponse(snapshot, options = {}) {
  const movies = Array.isArray(snapshot?.movies) ? snapshot.movies : [];
  const { id, q = '', category = '', limit = 24, offset = 0, categoriesOnly = false } = options;

  if (id !== undefined) {
    const movie = /^\d{1,18}$/.test(String(id))
      ? movies.find(item => String(item.id) === String(id)) || null
      : null;
    return { movie };
  }

  if (categoriesOnly) {
    const categories = new Map();
    for (const movie of movies) {
      const value = typeof movie.category === 'string' ? movie.category.trim().replace(/\s+/g, ' ') : '';
      const normalized = normalizeCategory(value);
      if (normalized && !categories.has(normalized)) categories.set(normalized, value);
    }
    return { categories: [...categories.values()].sort((a, b) => a.localeCompare(b)) };
  }

  const search = String(q).trim().toLowerCase();
  const normalizedCategory = normalizeCategory(category);
  const filtered = movies.filter(movie =>
    (!search || String(movie.movie_name || '').toLowerCase().includes(search)) &&
    (!normalizedCategory || normalizeCategory(movie.category) === normalizedCategory)
  );
  return {
    movies: filtered.slice(offset, offset + limit),
    total: filtered.length,
    limit,
    offset,
  };
}
