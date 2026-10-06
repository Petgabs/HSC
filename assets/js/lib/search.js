function normalize(value) {
  return String(value || '').toLocaleLowerCase('en-AU').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

export function searchResources(items, query = '') {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [...items];
  return items.filter(item => {
    const searchable = normalize([
      item.name, item.fileName, item.description, item.meta?.subject,
      item.meta?.topic, item.meta?.owner, item.meta?.department,
      item.meta?.resourceType, ...(item.meta?.tags || []), ...(item.meta?.years || []).map(year => `year ${year}`)
    ].join(' '));
    return terms.every(term => searchable.includes(term));
  });
}

export function sortResources(items, sort = 'newest') {
  const result = [...items];
  const title = (item) => String(item.name || item.fileName || '').toLocaleLowerCase('en-AU');
  if (sort === 'title') return result.sort((a, b) => title(a).localeCompare(title(b)));
  if (sort === 'downloads') return result.sort((a, b) => (Number(b.downloads) || 0) - (Number(a.downloads) || 0) || title(a).localeCompare(title(b)));
  if (sort === 'oldest') return result.sort((a, b) => Date.parse(a.addedAt || 0) - Date.parse(b.addedAt || 0));
  return result.sort((a, b) => Date.parse(b.addedAt || 0) - Date.parse(a.addedAt || 0) || title(a).localeCompare(title(b)));
}
