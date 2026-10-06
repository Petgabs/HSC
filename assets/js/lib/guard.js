/**
 * Repeated-click and rate-limit protection for administrator actions.
 *
 * The website is a static deployment with no server, so this guard cannot stop
 * a determined attacker; what it does do is keep honest mistakes cheap. It
 * prevents double submissions (the classic double-click on **Publish**), keeps
 * a runaway client from hammering the GitHub API, slows down password guessing
 * against the administrator gate, and — because the record survives reloads in
 * `localStorage` — keeps a lockout in force even if the page is refreshed
 * mid-attempt.
 *
 * Two layers are provided:
 *
 *   - a sliding-window rate limiter per action (`RateLimiter`), and
 *   - a small in-flight lock (`createExclusiveRunner`) that stops a second
 *     click of the same action while the first one is still running.
 *
 * Everything here is pure and dependency-injected so it can be unit tested
 * without a browser.
 */

export const RATE_LIMIT_STORAGE_KEY = 'schoolcloud.guard.limits.v1';

/**
 * Default rules per administrator action. `limit` attempts are allowed per
 * `windowMs`; once the limit is reached the action is blocked for `cooldownMs`.
 * `penaltyMs` is the extra delay applied after each *failed* attempt (used for
 * the sign-in gates) and `maxPenaltyMs` caps that delay.
 */
export const ADMIN_ACTION_LIMITS = Object.freeze({
  login: Object.freeze({ limit: 5, windowMs: 10 * 60_000, cooldownMs: 60_000, penaltyMs: 400, maxPenaltyMs: 4_000, label: 'sign-in' }),
  master: Object.freeze({ limit: 5, windowMs: 10 * 60_000, cooldownMs: 60_000, penaltyMs: 400, maxPenaltyMs: 4_000, label: 'master-password unlock' }),
  upload: Object.freeze({ limit: 8, windowMs: 5 * 60_000, cooldownMs: 20_000, label: 'upload' }),
  delete: Object.freeze({ limit: 12, windowMs: 5 * 60_000, cooldownMs: 8_000, label: 'delete' }),
  sync: Object.freeze({ limit: 6, windowMs: 5 * 60_000, cooldownMs: 30_000, label: 'count sync' }),
  settings: Object.freeze({ limit: 10, windowMs: 5 * 60_000, cooldownMs: 8_000, label: 'settings save' }),
  token: Object.freeze({ limit: 8, windowMs: 10 * 60_000, cooldownMs: 20_000, label: 'token' }),
  verify: Object.freeze({ limit: 20, windowMs: 5 * 60_000, cooldownMs: 5_000, label: 'verification' }),
  refresh: Object.freeze({ limit: 12, windowMs: 5 * 60_000, cooldownMs: 5_000, label: 'refresh' }),
  account: Object.freeze({ limit: 4, windowMs: 15 * 60_000, cooldownMs: 120_000, label: 'administrator account change' })
});

const MAX_TRACKED_ACTIONS = 40;
const MAX_TRACKED_HITS = 200;

function safeNow(now) {
  const value = Number(now());
  return Number.isFinite(value) ? value : Date.now();
}

function storageOrNull(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function safeParse(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Human-friendly "wait N seconds" text used in the interface and notifications.
 */
export function formatRetryAfter(ms) {
  const seconds = Math.max(1, Math.ceil((Number(ms) || 0) / 1000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export class RateLimiter {
  constructor({
    limits = ADMIN_ACTION_LIMITS,
    storage = undefined,
    storageKey = RATE_LIMIT_STORAGE_KEY,
    now = () => Date.now()
  } = {}) {
    this.limits = limits || {};
    this.storage = storageOrNull(storage);
    this.storageKey = storageKey;
    this.now = typeof now === 'function' ? now : () => Date.now();
    /** action -> ascending list of attempt timestamps */
    this.hits = new Map();
    /** action -> timestamp the action becomes available again */
    this.blockedUntil = new Map();
    /** action -> consecutive failure count (drives the progressive delay) */
    this.failures = new Map();
    /** actions currently running, so a repeat click cannot start a second run */
    this.inFlight = new Set();
    this.restore();
  }

  rule(action) {
    const rule = this.limits?.[action];
    if (!rule) return null;
    return { limit: Math.max(1, Number(rule.limit) || 1), windowMs: Math.max(0, Number(rule.windowMs) || 0), cooldownMs: Math.max(1_000, Number(rule.cooldownMs) || 1_000), penaltyMs: Math.max(0, Number(rule.penaltyMs) || 0), maxPenaltyMs: Math.max(0, Number(rule.maxPenaltyMs) || 0), label: rule.label || action };
  }

  label(action) {
    return this.rule(action)?.label || action;
  }

  /** Drop attempt timestamps that have fallen out of the sliding window. */
  prune(action, now) {
    const rule = this.rule(action);
    if (!rule) return [];
    const hits = (this.hits.get(action) || []).filter(at => Number.isFinite(at) && now - at < rule.windowMs);
    this.hits.set(action, hits.slice(-MAX_TRACKED_HITS));
    return this.hits.get(action);
  }

  /** Milliseconds the action is still blocked for (0 when it may run). */
  blockedFor(action) {
    const now = safeNow(this.now);
    const until = Number(this.blockedUntil.get(action)) || 0;
    return Math.max(0, until - now);
  }

  /**
   * Ask whether `action` may run now. An allowed attempt is recorded
   * immediately, so two synchronous clicks cannot both pass.
   *
   * @returns {{ allowed: boolean, retryAfterMs: number, remaining: number, limit: number, reason: string }}
   */
  attempt(action) {
    const rule = this.rule(action);
    const now = safeNow(this.now);
    if (!rule) return { allowed: true, retryAfterMs: 0, remaining: Infinity, limit: Infinity, reason: 'unlimited' };

    const blocked = this.blockedFor(action);
    if (blocked > 0) {
      return { allowed: false, retryAfterMs: blocked, remaining: 0, limit: rule.limit, reason: 'cooldown' };
    }

    const hits = this.prune(action, now);
    if (hits.length >= rule.limit) {
      // Pause the action, and start its next window fresh: once the cooldown
      // has passed the administrator gets a full set of attempts again instead
      // of being locked out instantly by the attempts that caused the pause.
      this.blockedUntil.set(action, now + rule.cooldownMs);
      this.hits.set(action, []);
      this.persist();
      return { allowed: false, retryAfterMs: rule.cooldownMs, remaining: 0, limit: rule.limit, reason: 'limit' };
    }

    hits.push(now);
    this.hits.set(action, hits);
    this.trimActions();
    this.persist();
    return { allowed: true, retryAfterMs: 0, remaining: Math.max(0, rule.limit - hits.length), limit: rule.limit, reason: 'ok' };
  }

  /**
   * Record a failed attempt. The caller can await the returned delay before
   * telling the user the password was wrong, which slows guessing down without
   * ever locking a correct password out.
   *
   * @returns {number} milliseconds to wait before responding
   */
  penalize(action) {
    const rule = this.rule(action);
    const now = safeNow(this.now);
    if (!rule) return 0;
    const failures = Math.min(20, (this.failures.get(action) || 0) + 1);
    this.failures.set(action, failures);
    const delay = Math.min(rule.maxPenaltyMs || rule.penaltyMs, rule.penaltyMs * failures);
    // The penalty is returned for the caller to wait out *before* answering.
    // It deliberately does not set a lockout: a correct password supplied right
    // after a typo must still work, it is only made slower to guess.
    this.persist();
    return delay;
  }

  /** Clear the failure counter after a successful action. */
  reset(action) {
    const hadFailure = this.failures.delete(action);
    const wasBlocked = this.blockedUntil.delete(action);
    this.hits.delete(action);
    if (hadFailure || wasBlocked) this.persist();
  }

  /** Mark an action as running; returns false when it is already running. */
  begin(action) {
    if (this.inFlight.has(action)) return false;
    this.inFlight.add(action);
    return true;
  }

  end(action) {
    this.inFlight.delete(action);
  }

  isRunning(action) {
    return this.inFlight.has(action);
  }

  /** Snapshot of the currently blocked actions, used to render countdowns. */
  blockedActions() {
    const result = {};
    for (const action of this.blockedUntil.keys()) {
      const remaining = this.blockedFor(action);
      if (remaining > 0) result[action] = remaining;
    }
    return result;
  }

  trimActions() {
    if (this.hits.size <= MAX_TRACKED_ACTIONS) return;
    const oldest = [...this.hits.entries()].sort((a, b) => (a[1].at(-1) || 0) - (b[1].at(-1) || 0));
    for (const [action] of oldest.slice(0, this.hits.size - MAX_TRACKED_ACTIONS)) this.hits.delete(action);
  }

  persist() {
    if (!this.storage?.setItem) return;
    const payload = { version: 1, hits: {}, blockedUntil: {}, failures: {} };
    for (const [action, hits] of this.hits) if (hits.length) payload.hits[action] = hits.slice(-20);
    for (const [action, until] of this.blockedUntil) if (Number(until) > 0) payload.blockedUntil[action] = Number(until);
    for (const [action, count] of this.failures) if (count > 0) payload.failures[action] = count;
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(payload));
    } catch {
      // Storage can be full or disabled; the in-memory guard keeps working.
    }
  }

  restore() {
    if (!this.storage?.getItem) return;
    const payload = safeParse(this.storage.getItem(this.storageKey));
    if (!payload) return;
    const now = safeNow(this.now);
    for (const [action, hits] of Object.entries(payload.hits || {})) {
      if (!Array.isArray(hits)) continue;
      const clean = hits.map(Number).filter(at => Number.isFinite(at) && now - at < Math.max(0, Number(this.rule(action)?.windowMs) || 0));
      if (clean.length) this.hits.set(action, clean.slice(-20));
    }
    for (const [action, until] of Object.entries(payload.blockedUntil || {})) {
      const value = Number(until);
      if (Number.isFinite(value) && value > now) this.blockedUntil.set(action, value);
    }
    for (const [action, count] of Object.entries(payload.failures || {})) {
      const value = Number(count);
      if (Number.isFinite(value) && value > 0) this.failures.set(action, Math.min(20, Math.trunc(value)));
    }
  }

  /** Forget all history — used by "Clear local settings" on the dashboard. */
  clear() {
    this.hits.clear();
    this.blockedUntil.clear();
    this.failures.clear();
    this.inFlight.clear();
    if (this.storage?.removeItem) {
      try { this.storage.removeItem(this.storageKey); } catch { /* Storage is optional. */ }
    }
  }
}

/**
 * Wrap an async function so only one run per key is ever in flight. A second
 * call resolves to `undefined` instead of starting duplicate work or throwing.
 */
export function createExclusiveRunner() {
  const running = new Set();
  return {
    isRunning: key => running.has(key),
    /** Reserve the key; false when a run is already in flight. */
    begin(key) {
      if (running.has(key)) return false;
      running.add(key);
      return true;
    },
    end(key) {
      running.delete(key);
    },
    async run(key, task) {
      if (running.has(key)) return undefined;
      running.add(key);
      try {
        return await task();
      } finally {
        running.delete(key);
      }
    }
  };
}
