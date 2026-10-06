import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AbacusCounters, claimSessionCounterHit, downloadCounterKey, readLocalCounter, writeLocalCounter } from '../assets/js/lib/counters.js';

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
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ cache: 'no-store', credentials: 'omit' });
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
