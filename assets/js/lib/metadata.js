import { SUPPORTED_EXTENSIONS } from '../config.js';

const SUBJECT_PATTERNS = [
  [/\b(mathematics|maths|math|hsc\s*m(?:athematics)?\s*advanced|2u|3u|4u|5u)\b/i, 'Mathematics'],
  [/\b(eald|english|literacy)\b/i, 'EALD/English'],
  [/\b(cal|community\s+and\s+family)\b/i, 'CAL'],
  [/\b(business\s+studies|business)\b/i, 'BS'],
  [/\b(visual\s+arts|art)\b/i, 'VA'],
  [/\b(physics)\b/i, 'PHY'],
  [/\b(modern\s+history|history)\b/i, 'MEX']
];

export function extensionOf(filename) {
  const match = String(filename || '').toLowerCase().match(/\.[a-z0-9]+$/);
  return match ? match[0] : '';
}

export function isSupportedFile(filename) {
  const value = String(filename || '');
  return Boolean(value) && !/[\\/\u0000-\u001f\u007f]/.test(value) &&
    value !== '.' && value !== '..' && SUPPORTED_EXTENSIONS.includes(extensionOf(value));
}

export function inferMetadata(filename, curated = {}) {
  const cleanName = String(filename || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const fullName = String(filename || '');
  const inferredSubject = SUBJECT_PATTERNS.find(([pattern]) => pattern.test(fullName))?.[1] || 'Others';
  const yearMatches = [...fullName.matchAll(/\b(?:year\s*)?(9|10|11|12)\b/gi)]
    .map(match => Number(match[1]))
    .filter((year, index, list) => list.indexOf(year) === index);
  const tags = curated.tags ?? curated.keywords ?? [];
  const years = Array.isArray(curated.years)
    ? curated.years.map(Number).filter(year => Number.isInteger(year) && year >= 7 && year <= 12)
    : yearMatches;

  return {
    title: String(curated.title || cleanName || fullName),
    description: String(curated.description || ''),
    subject: String(curated.subject || inferredSubject),
    years,
    tags: Array.isArray(tags) ? tags.map(tag => String(tag).trim()).filter(Boolean) : [],
    topic: String(curated.topic || ''),
    kind: extensionOf(filename).slice(1),
    resourceType: String(curated.resourceType || ''),
    language: String(curated.language || 'English'),
    owner: String(curated.owner || ''),
    department: String(curated.department || ''),
    academicYear: String(curated.academicYear || ''),
    visibility: String(curated.visibility || 'public'),
    version: String(curated.version || ''),
    reviewDate: String(curated.reviewDate || ''),
    licence: String(curated.licence || ''),
    accessibility: String(curated.accessibility || ''),
    addedAt: String(curated.addedAt || '')
  };
}

function isTrustedDownloadUrl(value) {
  try {
    const url = new URL(value, globalThis.location?.href || 'https://schoolcloud.invalid/');
    const sameOrigin = Boolean(globalThis.location && url.origin === globalThis.location.origin);
    const allowedRemote = url.protocol === 'https:' && (
      url.hostname === 'github.com' ||
      url.hostname === 'raw.githubusercontent.com' ||
      url.hostname.endsWith('.github.io')
    );
    return (sameOrigin && ['http:', 'https:'].includes(url.protocol)) || allowedRemote;
  } catch {
    return false;
  }
}

export function normalizeLibraryEntry(file, curated = {}) {
  const fileName = String(file?.name || file?.path?.split('/').pop() || '');
  const path = String(file?.path || (fileName ? `apps/${fileName}` : ''));
  if (!fileName || !/^apps\/[^/]+$/.test(path) || !isSupportedFile(fileName)) return null;
  const downloadUrl = String(file?.download_url || file?.downloadUrl || path);
  if (!isTrustedDownloadUrl(downloadUrl)) return null;
  const meta = inferMetadata(fileName, curated);
  const id = path.normalize('NFC').toLowerCase();
  return {
    id,
    name: meta.title,
    title: meta.title,
    fileName,
    path,
    sha: String(file?.sha || ''),
    size: Number(file?.size) || 0,
    downloadUrl,
    url: downloadUrl,
    description: meta.description,
    teacherName: meta.owner,
    addedAt: meta.addedAt || String(file?.addedAt || ''),
    source: 'github',
    type: 'file',
    meta
  };
}

export function metadataFromLibrary(library) {
  if (!library || typeof library !== 'object' || Array.isArray(library)) return {};
  const result = new Map();
  for (const [key, value] of Object.entries(library)) {
    if (key.startsWith('_') || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const pathKey = key.startsWith('apps/') ? key : `apps/${key}`;
    result.set(pathKey, value);
    result.set(key.split('/').pop(), value);
  }
  return result;
}
