const DEFAULT_TIMEOUT_MS = 6500;

/** Repository path of the durable download-count record served by the site. */
export const DOWNLOAD_STATS_PATH = 'stats/downloads.json';

function safeSegment(value) {
  return encodeURIComponent(String(value));
}

function safeCounterValue(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

/**
 * Merge counter candidates so a display never moves backwards: the live
 * Abacus value, the last GitHub-saved record and the per-browser fallback
 * are combined with max-wins. Every layer is untrusted input, so each value
 * is sanitized before it can influence the total.
 */
export function maxCounter(...values) {
  return values.reduce((best, value) => Math.max(best, safeCounterValue(value)), 0);
}

/**
 * Normalize the durable `stats/downloads.json` record served from the same
 * origin as the site. The record is advisory: malformed shapes degrade to an
 * empty record, never to an exception, so a bad file cannot break the library.
 *
 * Returns `{ visitors, updatedAt, files }` where `files` maps a lower-cased
 * repository path to `{ path, downloads, key }`.
 */
export function normalizeStatsRecord(data) {
  const empty = { visitors: 0, updatedAt: '', files: new Map() };
  if (!data || typeof data !== 'object' || Array.isArray(data)) return empty;
  const visitors = safeCounterValue(data.visitors);
  const updatedAt = typeof data.updatedAt === 'string' ? data.updatedAt : '';
  const files = new Map();
  const rawFiles = data.files;
  if (rawFiles && typeof rawFiles === 'object' && !Array.isArray(rawFiles)) {
    for (const [rawPath, entry] of Object.entries(rawFiles)) {
      const path = String(rawPath || '').normalize('NFC').trim();
      if (!path || !/^apps\/[^/]+$/i.test(path)) continue;
      const downloads = safeCounterValue(entry?.downloads);
      const key = typeof entry?.key === 'string' && entry.key ? entry.key : downloadCounterKey(path);
      files.set(path.toLowerCase(), { path, downloads, key });
    }
  }
  return { visitors, updatedAt, files };
}

/** Look up one file's GitHub-saved download total (0 when unknown). */
export function downloadsFromRecord(record, path) {
  const key = String(path || '').normalize('NFC').toLowerCase();
  return safeCounterValue(record?.files?.get(key)?.downloads);
}

export function downloadCounterKey(path) {
  // FNV-1a produces a short, deterministic identifier while keeping the real
  // file name out of the counter URL. Collisions are unlikely for a school
  // library; include the final extension in the input to distinguish formats.
  const input = String(path || '').normalize('NFC').toLowerCase();
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `download-${hash.toString(16).padStart(8, '0')}`;
}

/**
 * Thin client for Abacus' anonymous counting API.
 *
 * `get` reads without changing a count. `hit` increments once and deliberately
 * does not retry: replaying a timed-out hit could double-count a visit/download.
 */
export class AbacusCounters {
  constructor({
    baseUrl = 'https://abacus.jasoncameron.dev',
    namespace,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS
  } = {}) {
    if (!namespace) throw new TypeError('An Abacus namespace is required.');
    if (typeof fetchImpl !== 'function') throw new TypeError('Fetch is unavailable.');
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.namespace = namespace;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  url(operation, key) {
    if (!['get', 'hit'].includes(operation)) throw new TypeError('Unsupported Abacus operation.');
    return `${this.baseUrl}/${operation}/${safeSegment(this.namespace)}/${safeSegment(key)}`;
  }

  async request(operation, key) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(this.url(operation, key), {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        // A hit changes shared state. Let the browser finish that tiny GET if
        // the page is closed immediately after the click.
        keepalive: operation === 'hit',
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });

      // An unseen counter is a normal zero value. Do not increment it as part
      // of a read; only an explicit `hit` creates/increments a counter.
      if (operation === 'get' && response.status === 404) return 0;
      if (!response.ok) throw new Error(`Abacus returned HTTP ${response.status}.`);
      const body = await response.json();
      const value = Number(body?.value);
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error('Abacus returned an invalid counter value.');
      }
      return value;
    } finally {
      clearTimeout(timer);
    }
  }

  get(key) {
    return this.request('get', key);
  }

  hit(key) {
    return this.request('hit', key);
  }
}

/**
 * Reserve one visitor hit for the current browser tab session. A null result
 * means session storage is unavailable; callers can then deduplicate in-memory
 * for the lifetime of their current page.
 */
export function claimSessionCounterHit(key, storage) {
  let sessionStore = storage;
  if (sessionStore === undefined) {
    try { sessionStore = globalThis.sessionStorage; } catch { return null; }
  }
  if (!sessionStore || typeof sessionStore.getItem !== 'function' || typeof sessionStore.setItem !== 'function') return null;

  try {
    const marker = `schoolcloud.session-counter.${String(key)}`;
    if (sessionStore.getItem(marker) === '1') return false;
    sessionStore.setItem(marker, '1');
    return true;
  } catch {
    return null;
  }
}

export function readLocalCounter(key, storage = globalThis.localStorage) {
  try {
    const value = Number(storage?.getItem(`schoolcloud.counter.${key}`));
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

export function writeLocalCounter(key, value, storage = globalThis.localStorage) {
  const safeValue = Math.max(0, Math.trunc(Number(value) || 0));
  try {
    storage?.setItem(`schoolcloud.counter.${key}`, String(safeValue));
  } catch {
    // Private browsing/storage quotas must never stop a download or page load.
  }
  return safeValue;
}
