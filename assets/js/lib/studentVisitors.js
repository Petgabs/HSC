const DEFAULT_TIMEOUT_MS = 8000;
const ACTIONS = new Set(['heartbeat', 'visit', 'activity', 'public_stats', 'admin_list', 'admin_reset']);

/** Same-origin-friendly browser client for the server-protected visitor API. */
export class StudentVisitorClient {
  constructor({
    baseUrl,
    publishableKey,
    functionName = 'hsc-visitor-data',
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS
  } = {}) {
    if (!baseUrl) throw new TypeError('A Supabase URL is required.');
    if (!publishableKey) throw new TypeError('A Supabase publishable key is required.');
    if (typeof fetchImpl !== 'function') throw new TypeError('Fetch is unavailable.');
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.publishableKey = String(publishableKey);
    this.functionName = String(functionName);
    this.fetch = (...args) => fetchImpl(...args);
    this.timeoutMs = Math.max(500, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  }

  async request(action, payload = {}) {
    if (!ACTIONS.has(action)) throw new TypeError('Unsupported visitor action.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}/functions/v1/${encodeURIComponent(this.functionName)}`, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'omit',
        headers: {
          apikey: this.publishableKey,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ...payload, action }),
        signal: controller.signal
      });
      if (response.status === 204) return {};
      let result;
      try { result = await response.json(); }
      catch { throw new Error('The visitor service returned an unreadable response.'); }
      if (!response.ok) {
        const message = typeof result?.error === 'string' ? result.error : `Visitor service returned HTTP ${response.status}.`;
        throw new Error(message);
      }
      return result && typeof result === 'object' && !Array.isArray(result) ? result : {};
    } finally {
      clearTimeout(timer);
    }
  }
}
