/**
 * Live "an administrator is online" indicator for a static site.
 *
 * There is no server to hold a session list, so presence travels over the same
 * anonymous counter service the download totals already use. An administrator
 * page sends one heartbeat per minute into a **time bucket** counter, e.g.
 * `admin-online-29654321`; the bucket index is simply
 * `floor(epochMilliseconds / 60000)`. A visitor reads the current and previous
 * bucket and shows "Admin online" when either has been hit — that means an
 * administrator's browser was here within roughly the last two minutes.
 *
 * Buckets, rather than a single shared counter, are what make this work: a
 * plain counter only ever counts up and could never tell the difference
 * between "an admin is here now" and "an admin visited in March". No name,
 * device or account detail is ever sent — the beacon carries a timestamp
 * bucket and nothing else.
 *
 * Because a heartbeat costs one request per minute, the same-device layers are
 * checked first: a timestamp in `localStorage` and a `BroadcastChannel`
 * message both make the indicator instant for administrators working in
 * several tabs, and make it work even when the counter service is unreachable.
 */

export const PRESENCE_BUCKET_MS = 60_000;
/** Current bucket plus the one before it = live window of about two minutes. */
export const PRESENCE_BUCKETS_CHECKED = 2;
export const PRESENCE_BUCKET_PREFIX = 'admin-online';
export const PRESENCE_LOCAL_KEY = 'schoolcloud.admin.presence.v1';
export const PRESENCE_CHANNEL_NAME = 'schoolcloud-presence';

/** Live window in milliseconds derived from the bucket size. */
export const PRESENCE_WINDOW_MS = PRESENCE_BUCKET_MS * PRESENCE_BUCKETS_CHECKED;

/** Bucket index for a timestamp. */
export function presenceBucketIndex(at = Date.now(), bucketMs = PRESENCE_BUCKET_MS) {
  const time = Number(at);
  const size = Number(bucketMs) > 0 ? Number(bucketMs) : PRESENCE_BUCKET_MS;
  return Math.floor((Number.isFinite(time) ? time : Date.now()) / size);
}

/** Counter key for one bucket. */
export function presenceBucketKey(bucketIndex, prefix = PRESENCE_BUCKET_PREFIX) {
  const index = Math.max(0, Math.trunc(Number(bucketIndex) || 0));
  return `${prefix}-${index}`;
}

/**
 * Bucket keys a visitor should read, newest first. The previous bucket is only
 * needed when the current one is empty, so callers can stop early.
 */
export function presenceBucketKeys(at = Date.now(), bucketMs = PRESENCE_BUCKET_MS, prefix = PRESENCE_BUCKET_PREFIX) {
  const current = presenceBucketIndex(at, bucketMs);
  const keys = [];
  for (let offset = 0; offset < PRESENCE_BUCKETS_CHECKED; offset += 1) {
    keys.push({ bucketIndex: current - offset, key: presenceBucketKey(current - offset, prefix) });
  }
  return keys;
}

/**
 * Decide whether a set of bucket readings means an administrator is online.
 * `readings` is a list of `{ bucketIndex, value }`; stale buckets and zero
 * values are ignored.
 */
export function presenceIsLive(readings, at = Date.now(), bucketMs = PRESENCE_BUCKET_MS) {
  const current = presenceBucketIndex(at, bucketMs);
  for (const reading of Array.isArray(readings) ? readings : []) {
    const index = Number(reading?.bucketIndex);
    const value = Number(reading?.value);
    if (!Number.isFinite(index) || !Number.isFinite(value) || value <= 0) continue;
    if (current - index < PRESENCE_BUCKETS_CHECKED) return true;
  }
  return false;
}

/** True when a same-device heartbeat is still inside the live window. */
export function localPresenceIsLive(lastSeenAt, at = Date.now()) {
  const seen = Number(lastSeenAt);
  const now = Number(at);
  if (!Number.isFinite(seen) || !Number.isFinite(now)) return false;
  const age = now - seen;
  return age >= 0 && age < PRESENCE_WINDOW_MS;
}

export function describePresence({ live = false, unknown = false, source = '', lastSeenAt = 0, at = Date.now() } = {}) {
  const age = Number(at) - Number(lastSeenAt);
  if (live) {
    return {
      label: 'Admin online',
      detail: source === 'local'
        ? 'An administrator is signed in on this device right now.'
        : 'An administrator signed in to this website within the last two minutes.',
      tone: 'online'
    };
  }
  if (unknown) {
    return {
      label: 'Admin status unknown',
      detail: 'The live-status counter could not be reached. An administrator may still be online.',
      tone: 'unknown'
    };
  }
  if (Number(lastSeenAt) > 0 && Number.isFinite(age) && age >= 0) {
    return {
      label: 'No admin online',
      detail: `The last administrator heartbeat was ${formatPresenceAge(age)} ago.`,
      tone: 'offline'
    };
  }
  return {
    label: 'No admin online',
    detail: 'No administrator heartbeat has been seen on this device yet.',
    tone: 'offline'
  };
}

export function formatPresenceAge(ms) {
  const seconds = Math.max(1, Math.round((Number(ms) || 0) / 1000));
  if (seconds < 90) return `${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

/**
 * Tracks administrator presence for one page.
 *
 * `client` is an `AbacusCounters`-like object with `get(key)` and `hit(key)`.
 * Everything else is injectable so this can be tested without a browser.
 */
export class AdminPresenceBeacon {
  constructor({
    client = null,
    storage = undefined,
    now = () => Date.now(),
    bucketMs = PRESENCE_BUCKET_MS,
    prefix = PRESENCE_BUCKET_PREFIX,
    localKey = PRESENCE_LOCAL_KEY,
    channel = undefined,
    onChange = null,
    fetchTimeoutMs = 4_000
  } = {}) {
    this.client = client;
    this.storage = storage === undefined ? defaultStorage() : storage;
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.bucketMs = Number(bucketMs) > 0 ? Number(bucketMs) : PRESENCE_BUCKET_MS;
    this.prefix = prefix;
    this.localKey = localKey;
    this.fetchTimeoutMs = Number(fetchTimeoutMs) > 0 ? Number(fetchTimeoutMs) : 4_000;
    this.onChange = typeof onChange === 'function' ? onChange : null;
    this.state = { live: false, unknown: false, source: '', lastSeenAt: this.readLocalSeen(), checkedAt: 0 };
    this._channel = channel === undefined ? this._openChannel() : channel;
    this._boundMessage = event => this._handleMessage(event);
    this._boundStorage = event => {
      if (event?.key === this.localKey) this._update({ source: 'local' });
    };
    if (this._channel?.addEventListener) this._channel.addEventListener('message', this._boundMessage);
    try { globalThis.addEventListener?.('storage', this._boundStorage); } catch { /* Storage events are optional. */ }
  }

  _openChannel() {
    try {
      // Prefer the channel implementation that belongs to the page's own
      // realm. A test or embedded runner with a window that has no
      // BroadcastChannel must not fall back to another realm's class: mixing
      // realms makes every delivered message an uncaught type error.
      const windowChannel = globalThis.window?.BroadcastChannel;
      if (globalThis.window && typeof windowChannel !== 'function') return null;
      const ChannelImpl = typeof windowChannel === 'function' ? windowChannel : globalThis.BroadcastChannel;
      if (typeof ChannelImpl !== 'function') return null;
      return new ChannelImpl(PRESENCE_CHANNEL_NAME);
    } catch {
      return null;
    }
  }

  _handleMessage(event) {
    const data = event?.data;
    if (!data || data.type !== 'admin-presence') return;
    const at = Number(data.at);
    if (!Number.isFinite(at)) return;
    this.state.lastSeenAt = Math.max(this.state.lastSeenAt, at);
    this._update({ source: 'local' });
  }

  /** Close timers/channels. Safe to call more than once. */
  close() {
    if (this._channel?.removeEventListener) this._channel.removeEventListener('message', this._boundMessage);
    try { this._channel?.close?.(); } catch { /* Already closed. */ }
    try { globalThis.removeEventListener?.('storage', this._boundStorage); } catch { /* Optional. */ }
    this._channel = null;
  }

  readLocalSeen() {
    try {
      const value = Number(this.storage?.getItem(this.localKey));
      return Number.isFinite(value) && value > 0 ? value : 0;
    } catch {
      return 0;
    }
  }

  writeLocalSeen(at = this.now()) {
    const value = Math.trunc(Number(at) || 0);
    if (value <= 0) return;
    this.state.lastSeenAt = Math.max(this.state.lastSeenAt, value);
    try { this.storage?.setItem(this.localKey, String(value)); } catch { /* Storage is optional. */ }
    this._update({ source: 'local' });
  }

  _update({ live, unknown, source } = {}) {
    const next = { ...this.state };
    if (live !== undefined) next.live = Boolean(live);
    if (unknown !== undefined) next.unknown = Boolean(unknown);
    if (source) next.source = source;
    next.checkedAt = this.now();
    // Keep the local layer authoritative: a heartbeat on this device or a
    // fresh local timestamp always means an administrator is present.
    if (localPresenceIsLive(next.lastSeenAt, this.now())) {
      next.live = true;
      next.unknown = false;
      next.source = next.source || 'local';
    }
    this.state = next;
    this.onChange?.({ ...next });
    return { ...next };
  }

  /** Snapshot for the interface, recomputed so a stale local value expires. */
  snapshot() {
    const at = this.now();
    const live = this.state.live || localPresenceIsLive(this.state.lastSeenAt, at);
    return { ...this.state, live, at };
  }

  /**
   * Send one heartbeat: hit the current bucket and mark this device. Also
   * announces to other tabs on this device, so they update instantly without
   * waiting for the next poll.
   */
  async announce() {
    const at = this.now();
    const { bucketIndex, key } = presenceBucketKeys(at, this.bucketMs, this.prefix)[0];
    this.writeLocalSeen(at);
    try { this._channel?.postMessage?.({ type: 'admin-presence', at }); } catch { /* Optional. */ }
    if (!this.client) return this.snapshot();
    try {
      await this.client.hit(key);
      this.state.unknown = false;
    } catch {
      // A blocked counter service must not stop the local indicator: the
      // heartbeat still works across this device's tabs.
    }
    return this._update({ live: true });
  }

  /**
   * Read presence from the local layers and, when needed, from the counters.
   * Returns the new state; `unknown` is true when every layer failed.
   */
  async read() {
    const at = this.now();
    if (localPresenceIsLive(this.state.lastSeenAt, at)) {
      return this._update({ live: true, unknown: false, source: 'local' });
    }
    if (!this.client) return this._update({ live: false, unknown: false, source: '' });

    const readings = [];
    let reachable = false;
    for (const { bucketIndex, key } of presenceBucketKeys(at, this.bucketMs, this.prefix)) {
      try {
        const value = await this._withTimeout(this.client.get(key));
        reachable = true;
        readings.push({ bucketIndex, value: Number(value) || 0 });
        if (Number(value) > 0) break;
      } catch {
        break;
      }
    }
    if (!reachable) return this._update({ live: false, unknown: true, source: '' });
    const live = presenceIsLive(readings, at, this.bucketMs);
    return this._update({ live, unknown: false, source: live ? 'remote' : '' });
  }

  async _withTimeout(promise) {
    if (!this.fetchTimeoutMs) return promise;
    return Promise.race([
      promise,
      new Promise((resolve, reject) => {
        setTimeout(() => reject(new Error('Presence read timed out.')), this.fetchTimeoutMs);
      })
    ]);
  }
}
