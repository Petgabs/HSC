import { describe, expect, it, vi } from 'vitest';
import {
  AdminPresenceBeacon, PRESENCE_BUCKET_MS, PRESENCE_LOCAL_KEY, PRESENCE_WINDOW_MS, describePresence,
  formatPresenceAge, localPresenceIsLive, presenceBucketIndex, presenceBucketKey, presenceBucketKeys,
  presenceIsLive
} from '../assets/js/lib/presence.js';

const MINUTE = 60_000;

function fakeStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: key => { store.delete(key); },
    dump: () => Object.fromEntries(store)
  };
}

function fakeClient({ values = {}, failReads = false, failHits = false } = {}) {
  return {
    hits: [],
    reads: [],
    async hit(key) {
      if (failHits) throw new Error('counter unavailable');
      this.hits.push(key);
      values[key] = (Number(values[key]) || 0) + 1;
      return values[key];
    },
    async get(key) {
      this.reads.push(key);
      if (failReads) throw new Error('counter unavailable');
      return Number(values[key]) || 0;
    }
  };
}

describe('presence time buckets', () => {
  it('maps a timestamp to a stable one-minute bucket key', () => {
    const at = 1_770_000_000_000;
    const index = presenceBucketIndex(at);
    expect(index).toBe(Math.floor(at / PRESENCE_BUCKET_MS));
    expect(presenceBucketKey(index)).toBe(`admin-online-${index}`);
    // Same bucket for the whole minute.
    expect(presenceBucketIndex(at + 59_999)).toBe(index);
    expect(presenceBucketIndex(at + 60_000)).toBe(index + 1);
  });

  it('reads the current bucket and the one before it, newest first', () => {
    const keys = presenceBucketKeys(1_770_000_000_000);
    expect(keys).toHaveLength(2);
    expect(keys[0].bucketIndex).toBe(keys[1].bucketIndex + 1);
    expect(keys[0].key.endsWith(`-${keys[0].bucketIndex}`)).toBe(true);
  });

  it('is live only when a recent bucket has a heartbeat', () => {
    const at = 1_770_000_000_000;
    const current = presenceBucketIndex(at);
    expect(presenceIsLive([{ bucketIndex: current, value: 3 }], at)).toBe(true);
    expect(presenceIsLive([{ bucketIndex: current - 1, value: 1 }], at)).toBe(true);
    // Three buckets old: outside the two-minute window.
    expect(presenceIsLive([{ bucketIndex: current - 2, value: 9 }], at)).toBe(false);
    expect(presenceIsLive([{ bucketIndex: current, value: 0 }], at)).toBe(false);
    expect(presenceIsLive([], at)).toBe(false);
    expect(presenceIsLive(null, at)).toBe(false);
    expect(presenceIsLive([{ bucketIndex: 'x', value: 'y' }], at)).toBe(false);
  });

  it('expires the same-device heartbeat after the live window', () => {
    const at = 1_000_000;
    expect(localPresenceIsLive(at - 1_000, at)).toBe(true);
    expect(localPresenceIsLive(at - PRESENCE_WINDOW_MS + 1, at)).toBe(true);
    expect(localPresenceIsLive(at - PRESENCE_WINDOW_MS, at)).toBe(false);
    expect(localPresenceIsLive(0, at)).toBe(false);
    expect(localPresenceIsLive('nope', at)).toBe(false);
  });

  it('describes the three states without leaking any identity', () => {
    expect(describePresence({ live: true, source: 'remote' })).toMatchObject({ label: 'Admin online', tone: 'online' });
    expect(describePresence({ live: true, source: 'local' }).detail).toContain('this device');
    expect(describePresence({ live: false, unknown: true })).toMatchObject({ label: 'Admin status unknown', tone: 'unknown' });
    const offline = describePresence({ live: false, lastSeenAt: Date.now() - 5 * MINUTE, at: Date.now() });
    expect(offline.label).toBe('No admin online');
    expect(offline.detail).toContain('last administrator heartbeat');
    expect(JSON.stringify(describePresence({ live: true }))).not.toMatch(/hsc-admin|@|token/i);
  });

  it('formats heartbeat ages', () => {
    expect(formatPresenceAge(20_000)).toBe('20 seconds');
    expect(formatPresenceAge(5 * MINUTE)).toBe('5 minutes');
    expect(formatPresenceAge(3 * 60 * MINUTE)).toBe('3 hours');
    expect(formatPresenceAge(3 * 24 * 60 * MINUTE)).toBe('3 days');
  });
});

describe('administrator presence beacon', () => {
  it('heartbeats into the current bucket and marks the device', async () => {
    const at = 1_770_000_000_000;
    const storage = fakeStorage();
    const client = fakeClient();
    const beacon = new AdminPresenceBeacon({ client, storage, channel: null, now: () => at });

    await beacon.announce();

    const expectedKey = presenceBucketKeys(at)[0].key;
    expect(client.hits).toEqual([expectedKey]);
    expect(storage.dump()[PRESENCE_LOCAL_KEY]).toBe(String(at));
    expect(beacon.snapshot().live).toBe(true);
  });

  it('shows online from the same-device timestamp without touching the network', async () => {
    const storage = fakeStorage({ [PRESENCE_LOCAL_KEY]: String(Date.now() - 5_000) });
    const client = fakeClient();
    const beacon = new AdminPresenceBeacon({ client, storage, channel: null });
    await beacon.read();
    expect(beacon.snapshot()).toMatchObject({ live: true, source: 'local', unknown: false });
    expect(client.reads).toEqual([]);
  });

  it('reads the current bucket, then the previous one only when needed', async () => {
    const at = 1_770_000_000_000;
    const { bucketIndex, key } = presenceBucketKeys(at)[0];
    const client = fakeClient({ values: { [key]: 2 } });
    const beacon = new AdminPresenceBeacon({ client, storage: fakeStorage(), channel: null, now: () => at });

    await beacon.read();
    expect(client.reads).toEqual([key]);
    expect(beacon.snapshot().live).toBe(true);

    const older = presenceBucketKey(bucketIndex - 1);
    const second = fakeClient({ values: { [older]: 4 } });
    const beacon2 = new AdminPresenceBeacon({ client: second, storage: fakeStorage(), channel: null, now: () => at });
    await beacon2.read();
    expect(second.reads).toEqual([key, older]);
    expect(beacon2.snapshot().live).toBe(true);
  });

  it('reports unknown when the counter service cannot be reached', async () => {
    const client = fakeClient({ failReads: true });
    const beacon = new AdminPresenceBeacon({ client, storage: fakeStorage(), channel: null, now: () => Date.now() });
    await beacon.read();
    expect(beacon.snapshot()).toMatchObject({ live: false, unknown: true });
    expect(describePresence(beacon.snapshot()).label).toBe('Admin status unknown');
  });

  it('reports offline when every recent bucket is empty', async () => {
    const client = fakeClient();
    const beacon = new AdminPresenceBeacon({ client, storage: fakeStorage(), channel: null, now: () => 1_770_000_000_000 });
    await beacon.read();
    expect(beacon.snapshot()).toMatchObject({ live: false, unknown: false });
    expect(beacon.snapshot().live).toBe(false);
  });

  it('keeps working on this device when a heartbeat cannot be published', async () => {
    const storage = fakeStorage();
    const client = fakeClient({ failHits: true });
    const beacon = new AdminPresenceBeacon({ client, storage, channel: null, now: () => Date.now() });
    await expect(beacon.announce()).resolves.toBeTruthy();
    expect(beacon.snapshot().live).toBe(true);
  });

  it('shares presence with other tabs on the same device', async () => {
    const messages = [];
    const channel = {
      addEventListener: (type, handler) => { if (type === 'message') channel.handler = handler; },
      removeEventListener: () => { channel.handler = null; },
      postMessage: message => messages.push(message),
      close: () => {}
    };
    const listener = vi.fn();
    const updated = { ...channel, addEventListener: (type, handler) => { if (type === 'message') channel.handler = handler; } };
    const beacon = new AdminPresenceBeacon({ client: null, storage: fakeStorage(), channel, now: () => Date.now() });
    beacon.onChange = listener;
    await beacon.announce();
    expect(messages[0]).toMatchObject({ type: 'admin-presence' });

    // A second tab receives the broadcast and turns live instantly.
    const other = new AdminPresenceBeacon({ client: null, storage: fakeStorage(), channel: updated, now: () => Date.now() });
    channel.handler({ data: messages[0] });
    expect(other.snapshot().live).toBe(true);
    other.close();
    beacon.close();
  });

  it('closes channels and listeners cleanly', () => {
    const close = vi.fn();
    const channel = { addEventListener: () => {}, removeEventListener: () => {}, postMessage: () => {}, close };
    const beacon = new AdminPresenceBeacon({ client: null, storage: fakeStorage(), channel });
    beacon.close();
    expect(close).toHaveBeenCalled();
    expect(() => beacon.close()).not.toThrow();
  });
});
