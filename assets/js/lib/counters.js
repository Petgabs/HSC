const DEFAULT_TIMEOUT_MS = 6500;

function safeSegment(value) {
  return encodeURIComponent(String(value));
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
