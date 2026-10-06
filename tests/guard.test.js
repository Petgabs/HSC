import { describe, expect, it, vi } from 'vitest';
import { ADMIN_ACTION_LIMITS, RATE_LIMIT_STORAGE_KEY, RateLimiter, createExclusiveRunner, formatRetryAfter } from '../assets/js/lib/guard.js';

function fakeStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: key => { store.delete(key); },
    dump: () => Object.fromEntries(store)
  };
}

describe('administrator action rate limiting', () => {
  it('allows the configured number of attempts, then blocks with a cooldown', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter({ storage: null, now: () => now, limits: { upload: { limit: 3, windowMs: 60_000, cooldownMs: 30_000, label: 'upload' } } });

    expect(limiter.attempt('upload')).toMatchObject({ allowed: true, remaining: 2 });
    expect(limiter.attempt('upload').allowed).toBe(true);
    expect(limiter.attempt('upload').allowed).toBe(true);

    const blocked = limiter.attempt('upload');
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('limit');
    expect(blocked.retryAfterMs).toBe(30_000);
    expect(limiter.blockedFor('upload')).toBe(30_000);

    // The cooldown expires on its own.
    now += 30_001;
    expect(limiter.attempt('upload').allowed).toBe(true);
  });

  it('slides the window so old clicks stop counting', () => {
    let now = 0;
    const limiter = new RateLimiter({ storage: null, now: () => now, limits: { delete: { limit: 2, windowMs: 10_000, cooldownMs: 5_000 } } });
    limiter.attempt('delete');
    now = 6_000;
    limiter.attempt('delete');
    now = 11_000;
    // The first attempt has aged out of the window.
    expect(limiter.attempt('delete').allowed).toBe(true);
  });

  it('slows repeated password guesses without locking out the right password', () => {
    const limiter = new RateLimiter({ storage: null, now: () => 0, limits: { login: ADMIN_ACTION_LIMITS.login } });
    const first = limiter.penalize('login');
    const second = limiter.penalize('login');
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    // The penalty is a delay for the caller to apply, not an immediate block.
    expect(limiter.blockedFor('login')).toBe(0);
    expect(limiter.attempt('login').allowed).toBe(true);

    limiter.reset('login');
    expect(limiter.penalize('login')).toBe(first);
  });

  it('keeps a lockout in force across a reload', () => {
    const storage = fakeStorage();
    let now = 5_000_000;
    const rules = { sync: { limit: 1, windowMs: 60_000, cooldownMs: 60_000, label: 'count sync' } };
    const first = new RateLimiter({ storage, now: () => now, limits: rules });
    expect(first.attempt('sync').allowed).toBe(true);
    expect(first.attempt('sync').allowed).toBe(false);
    expect(storage.dump()[RATE_LIMIT_STORAGE_KEY]).toContain('blockedUntil');

    const reloaded = new RateLimiter({ storage, now: () => now, limits: rules });
    expect(reloaded.blockedFor('sync')).toBe(60_000);
    const verdict = reloaded.attempt('sync');
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('cooldown');

    now += 60_001;
    expect(new RateLimiter({ storage, now: () => now, limits: rules }).attempt('sync').allowed).toBe(true);
  });

  it('treats unlisted actions as unlimited and unknown actions safely', () => {
    const limiter = new RateLimiter({ storage: null, limits: {} });
    for (let index = 0; index < 50; index += 1) expect(limiter.attempt('anything').allowed).toBe(true);
    expect(limiter.rule('nope')).toBeNull();
    expect(limiter.label('nope')).toBe('nope');
  });

  it('renders a repeated-click countdown for the interface', () => {
    const limiter = new RateLimiter({ storage: null, now: () => 0, limits: { token: { limit: 1, windowMs: 1_000, cooldownMs: 12_000, label: 'token' } } });
    limiter.attempt('token');
    limiter.attempt('token');
    expect(limiter.blockedActions().token).toBe(12_000);
    expect(formatRetryAfter(12_000)).toBe('12 seconds');
    expect(formatRetryAfter(60_000)).toBe('1 minute');
    expect(formatRetryAfter(0)).toBe('1 second');
  });

  it('clears its history when local data is cleared', () => {
    const storage = fakeStorage();
    const limiter = new RateLimiter({ storage, now: () => 0, limits: { upload: { limit: 1, cooldownMs: 60_000, windowMs: 60_000 } } });
    limiter.attempt('upload');
    limiter.attempt('upload');
    expect(limiter.blockedFor('upload')).toBeGreaterThan(0);
    limiter.clear();
    expect(limiter.blockedFor('upload')).toBe(0);
    expect(storage.dump()).toEqual({});
  });

  it('ignores malformed stored state instead of throwing', () => {
    const storage = fakeStorage({ [RATE_LIMIT_STORAGE_KEY]: 'not json{' });
    const limiter = new RateLimiter({ storage, now: () => 0, limits: ADMIN_ACTION_LIMITS });
    expect(limiter.blockedFor('upload')).toBe(0);
    expect(() => limiter.attempt('upload')).not.toThrow();
  });

  it('keeps repeated clicks of one action from overlapping', async () => {
    const runner = createExclusiveRunner();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const first = runner.run('upload', async () => { await gate; return 'first'; });
    expect(runner.isRunning('upload')).toBe(true);
    await expect(runner.run('upload', async () => 'second')).resolves.toBeUndefined();
    release();
    await expect(first).resolves.toBe('first');
    expect(runner.isRunning('upload')).toBe(false);
    // A released action can run again.
    await expect(runner.run('upload', async () => 'third')).resolves.toBe('third');
  });

  it('reserves a key for an inline flow and releases it afterwards', () => {
    const runner = createExclusiveRunner();
    expect(runner.begin('upload')).toBe(true);
    expect(runner.begin('upload')).toBe(false);
    expect(runner.isRunning('upload')).toBe(true);
    runner.end('upload');
    expect(runner.isRunning('upload')).toBe(false);
    expect(runner.begin('upload')).toBe(true);
  });

  it('tracks in-flight actions separately from their rate limit', () => {
    const limiter = new RateLimiter({ storage: null, limits: ADMIN_ACTION_LIMITS });
    expect(limiter.begin('upload')).toBe(true);
    expect(limiter.begin('upload')).toBe(false);
    limiter.end('upload');
    expect(limiter.begin('upload')).toBe(true);
  });
});
