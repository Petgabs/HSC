import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AbacusCounters, claimSessionCounterHit, downloadCounterKey, downloadsFromRecord, maxCounter, normalizeStatsRecord, readLocalCounter, writeLocalCounter } from '../assets/js/lib/counters.js';
import { collectAbacusSnapshot, listTrackedAppPaths, snapshotHasChanges } from '../scripts/sync-abacus-stats.mjs';

describe('Abacus counters', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('uses stable keys for individual files and separates unrelated paths', () => {
    const key = downloadCounterKey('apps/Year 12 algebra.pdf');
    expect(key).toMatch(/^download-[a-f0-9]{8}$/);
    expect(downloadCounterKey('apps/Year 12 algebra.pdf')).toBe(key);
    expect(downloadCounterKey('apps/Year 12 calculus.pdf')).not.toBe(key);
  });

  it('claims a visitor increment once per browser session', () => {
    const values = new Map();
    const storage = {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value)
    };

    expect(claimSessionCounterHit('petgabs-hsc-schoolcloud:visitors', storage)).toBe(true);
    expect(claimSessionCounterHit('petgabs-hsc-schoolcloud:visitors', storage)).toBe(false);
    expect(values.get('schoolcloud.session-counter.petgabs-hsc-schoolcloud:visitors')).toBe('1');
  });

  it('reports an unavailable session store so callers can deduplicate in memory', () => {
    const storage = { getItem: () => { throw new Error('storage disabled'); }, setItem: vi.fn() };
    expect(claimSessionCounterHit('visitors', storage)).toBeNull();
  });

  it('uses Abacus get for reads and hit only for increments', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: 12 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: 13 }), { status: 200 }));
    const counters = new AbacusCounters({ namespace: 'school-cloud', fetchImpl });

    await expect(counters.get('visitors')).resolves.toBe(12);
    await expect(counters.hit('visitors')).resolves.toBe(13);

    expect(fetchImpl.mock.calls[0][0]).toBe('https://abacus.jasoncameron.dev/get/school-cloud/visitors');
    expect(fetchImpl.mock.calls[1][0]).toBe('https://abacus.jasoncameron.dev/hit/school-cloud/visitors');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ cache: 'no-store', credentials: 'omit', keepalive: false });
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({ cache: 'no-store', credentials: 'omit', keepalive: true });
  });

  it('invokes fetch as a bare call so browsers never throw Illegal invocation', async () => {
    // Real browser fetch rejects being called as a method of any object
    // other than its global (`client.fetch(...)` throws "Illegal invocation"
    // in Chrome/Safari/Firefox). Plain mocks do not model that, so this fetch
    // double enforces the same receiver rule to guard the regression where
    // every live Abacus read and hit failed in real browsers only.
    const fetchImpl = vi.fn(function () {
      // eslint-disable-next-line no-invalid-this
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch': Illegal invocation");
      }
      return Promise.resolve(new Response(JSON.stringify({ value: 3 }), { status: 200 }));
    });
    const counters = new AbacusCounters({ namespace: 'school-cloud', fetchImpl });

    await expect(counters.get('visitors')).resolves.toBe(3);
    await expect(counters.hit('visitors')).resolves.toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('treats a missing counter as zero without incrementing it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"error":"Key not found"}', { status: 404 }));
    const counters = new AbacusCounters({ namespace: 'school-cloud', fetchImpl });
    await expect(counters.get('download-deadbeef')).resolves.toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toContain('/get/');
  });

  it('does not retry a failed hit that might already have incremented remotely', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"error":"unavailable"}', { status: 503 }));
    const counters = new AbacusCounters({ namespace: 'school-cloud', fetchImpl });
    await expect(counters.hit('visitors')).rejects.toThrow('HTTP 503');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps safe local fallback values when storage is unavailable', () => {
    const store = new Map();
    const storage = {
      getItem: key => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value)
    };
    expect(readLocalCounter('visitors', storage)).toBe(0);
    expect(writeLocalCounter('visitors', 6, storage)).toBe(6);
    expect(readLocalCounter('visitors', storage)).toBe(6);
    expect(writeLocalCounter('visitors', -2, storage)).toBe(0);
  });
});

describe('automatic Abacus-to-GitHub snapshots', () => {
  it('discovers supported, top-level files from the published apps directory', () => {
    const paths = listTrackedAppPaths();
    expect(paths).toContain('apps/Sydney Girls 2026 w. sol.pdf');
    expect(paths.every(path => /^apps\/[^/]+\.(?:html?|pdf|docx?|xlsx?|pptx?)$/i.test(path))).toBe(true);
  });

  it('snapshots the visitor and each file total, preserving saved values on read failure', async () => {
    const previous = {
      namespace: 'petgabs-hsc-schoolcloud',
      updatedAt: '2026-10-01T00:00:00.000Z',
      visitors: 40,
      files: {
        'apps/Practice.pdf': { downloads: 8, key: downloadCounterKey('apps/Practice.pdf') }
      }
    };
    const counters = {
      get: vi.fn()
        .mockResolvedValueOnce(41)
        .mockResolvedValueOnce(9)
        .mockRejectedValueOnce(new Error('offline'))
    };
    const onReadError = vi.fn();
    const snapshot = await collectAbacusSnapshot({
      paths: ['apps/Practice.pdf', 'apps/New worksheet.pdf'],
      counters,
      previousRecord: previous,
      requestIntervalMs: 0,
      onReadError
    });

    expect(snapshot).toMatchObject({ visitors: 41, namespace: 'petgabs-hsc-schoolcloud' });
    expect(snapshot.files['apps/Practice.pdf']).toMatchObject({ downloads: 9 });
    expect(snapshot.files['apps/New worksheet.pdf']).toMatchObject({ downloads: 0 });
    expect(counters.get.mock.calls.map(([key]) => key)).toEqual([
      'visitors',
      downloadCounterKey('apps/Practice.pdf'),
      downloadCounterKey('apps/New worksheet.pdf')
    ]);
    expect(onReadError).toHaveBeenCalledTimes(1);
    expect(snapshotHasChanges(previous, snapshot)).toBe(true);
  });

  it('does not write another cloud commit when totals have not changed', async () => {
    const previous = {
      namespace: 'petgabs-hsc-schoolcloud',
      visitors: 4,
      files: {
        'apps/Practice.pdf': { downloads: 2, key: downloadCounterKey('apps/Practice.pdf') }
      }
    };
    const snapshot = await collectAbacusSnapshot({
      paths: ['apps/Practice.pdf'],
      counters: { get: vi.fn().mockResolvedValueOnce(4).mockResolvedValueOnce(2) },
      previousRecord: previous,
      requestIntervalMs: 0
    });
    expect(snapshotHasChanges(previous, snapshot)).toBe(false);
  });
});

describe('GitHub-saved download record', () => {
  it('merges counter layers with max-wins and sanitizes untrusted values', () => {
    expect(maxCounter(0, 7, 3)).toBe(7);
    expect(maxCounter(-5, Number.NaN, undefined, '12')).toBe(12);
    expect(maxCounter()).toBe(0);
    expect(maxCounter(2.9, 'not-a-number')).toBe(0);
  });

  it('normalizes a valid stats record and matches files case-insensitively', () => {
    const record = normalizeStatsRecord({
      namespace: 'petgabs-hsc-schoolcloud',
      updatedAt: '2026-10-06T05:15:00.000Z',
      visitors: 41,
      files: {
        'apps/Year 12 algebra.pdf': { downloads: 8, key: 'download-abc12345' },
        '../escape.pdf': { downloads: 999 },
        'apps/notes.txt': { downloads: '7' }
      }
    });
    expect(record.visitors).toBe(41);
    expect(record.updatedAt).toBe('2026-10-06T05:15:00.000Z');
    expect(record.files.size).toBe(2);
    expect(downloadsFromRecord(record, 'apps/YEAR 12 ALGEBRA.pdf')).toBe(8);
    expect(downloadsFromRecord(record, 'apps/notes.txt')).toBe(7);
    expect(downloadsFromRecord(record, 'apps/missing.pdf')).toBe(0);
    expect(downloadsFromRecord(null, 'apps/Year 12 algebra.pdf')).toBe(0);
  });

  it('degrades malformed records to an empty record instead of throwing', () => {
    for (const bad of [null, undefined, 42, 'nope', [], { files: [] }, { visitors: -3, files: null }]) {
      const record = normalizeStatsRecord(bad);
      expect(record.visitors).toBe(0);
      expect(record.files.size).toBe(0);
    }
    expect(downloadsFromRecord(normalizeStatsRecord({}), 'apps/a.pdf')).toBe(0);
  });
});
