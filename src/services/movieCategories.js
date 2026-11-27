/**
 * Convert category labels from the catalogue into a stable, friendly list.
 * Blank labels are omitted; whitespace/case-only duplicates collapse to one item.
 */
export function normalizeMovieCategories(values) {
  if (!Array.isArray(values)) return [];

  const unique = new Map();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const label = value.trim().replace(/\s+/g, ' ');
    if (!label) continue;
    const key = label.toLocaleLowerCase('en');
    if (!unique.has(key)) unique.set(key, label);
  }

  return [...unique.values()].sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true })
  );
}
