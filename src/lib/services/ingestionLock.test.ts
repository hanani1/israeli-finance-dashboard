import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withLease, type LeaseStore } from './ingestionLock';

/**
 * In-memory lease store with an injectable clock. It mirrors the SQL contract
 * of the Prisma store: acquiring succeeds when no lease exists or the existing
 * one has expired; renew/release only act on the caller's own lease.
 */
function fakeStore(nowRef: { now: number }) {
  const leases = new Map<string, { holder: string; expiresAt: number }>();
  const calls: string[] = [];
  const store: LeaseStore = {
    async tryAcquire(name, holder, ttlMs) {
      calls.push(`acquire:${holder}`);
      const current = leases.get(name);
      if (current && current.expiresAt > nowRef.now) return false;
      leases.set(name, { holder, expiresAt: nowRef.now + ttlMs });
      return true;
    },
    async renew(name, holder, ttlMs) {
      calls.push(`renew:${holder}`);
      const current = leases.get(name);
      if (!current || current.holder !== holder) return false;
      current.expiresAt = nowRef.now + ttlMs;
      return true;
    },
    async release(name, holder) {
      calls.push(`release:${holder}`);
      if (leases.get(name)?.holder === holder) leases.delete(name);
    },
  };
  return { store, leases, calls };
}

const NAME = 'finance.ingestion';
const noTimers = { setInterval: () => 0 as unknown as NodeJS.Timeout, clearInterval: () => {} };

test('runs the callback and releases the lease when it is free', async () => {
  const clock = { now: 0 };
  const { store, leases, calls } = fakeStore(clock);
  const result = await withLease(store, async () => 42, {
    name: NAME,
    holder: 'a',
    ttlMs: 1000,
    heartbeatMs: 100,
    timers: noTimers,
  });
  assert.deepEqual(result, { acquired: true, value: 42 });
  assert.equal(leases.size, 0);
  assert.deepEqual(calls, ['acquire:a', 'release:a']);
});

test('skips without running the callback when another holder has a live lease', async () => {
  const clock = { now: 0 };
  const { store, leases } = fakeStore(clock);
  await store.tryAcquire(NAME, 'other', 1000);
  let ran = false;
  const result = await withLease(
    store,
    async () => {
      ran = true;
    },
    { name: NAME, holder: 'a', ttlMs: 1000, heartbeatMs: 100, timers: noTimers },
  );
  assert.deepEqual(result, { acquired: false });
  assert.equal(ran, false);
  // The live holder's lease is untouched.
  assert.equal(leases.get(NAME)?.holder, 'other');
});

test('releases the lease in finally when the callback throws', async () => {
  const clock = { now: 0 };
  const { store, leases, calls } = fakeStore(clock);
  await assert.rejects(
    withLease(
      store,
      async () => {
        throw new Error('scrape exploded');
      },
      { name: NAME, holder: 'a', ttlMs: 1000, heartbeatMs: 100, timers: noTimers },
    ),
    /scrape exploded/,
  );
  assert.equal(leases.size, 0);
  assert.equal(calls.at(-1), 'release:a');
});

test('recovers a stale lease left behind by a crashed holder', async () => {
  const clock = { now: 0 };
  const { store, leases } = fakeStore(clock);
  // A crashed run acquired and never released or renewed.
  await store.tryAcquire(NAME, 'crashed', 1000);
  clock.now = 1001;
  const result = await withLease(store, async () => 'ok', {
    name: NAME,
    holder: 'a',
    ttlMs: 1000,
    heartbeatMs: 100,
    timers: noTimers,
  });
  assert.deepEqual(result, { acquired: true, value: 'ok' });
  assert.equal(leases.size, 0);
});

test('heartbeat keeps a long run alive past the TTL and stops after release', async () => {
  const clock = { now: 0 };
  const { store, leases } = fakeStore(clock);
  let tick: (() => void) | null = null;
  let cleared = false;
  const timers = {
    setInterval: (fn: () => void) => {
      tick = fn;
      return 1 as unknown as NodeJS.Timeout;
    },
    clearInterval: () => {
      cleared = true;
    },
  };
  let competitor: boolean | null = null;
  await withLease(
    store,
    async () => {
      // Three heartbeats over 2.5 TTLs: the lease must never look stale.
      for (let i = 0; i < 5; i += 1) {
        clock.now += 500;
        tick!();
        await new Promise((resolve) => setImmediate(resolve));
      }
      competitor = await store.tryAcquire(NAME, 'b', 1000);
    },
    { name: NAME, holder: 'a', ttlMs: 1000, heartbeatMs: 300, timers },
  );
  assert.equal(competitor, false);
  assert.equal(cleared, true);
  assert.equal(leases.size, 0);
});

test('a failing heartbeat or release does not crash the run', async () => {
  const clock = { now: 0 };
  const { store } = fakeStore(clock);
  let tick: (() => void) | null = null;
  const warnings: string[] = [];
  const flaky: LeaseStore = {
    tryAcquire: store.tryAcquire,
    renew: async () => {
      throw new Error('db blip');
    },
    release: async () => {
      throw new Error('db gone');
    },
  };
  const result = await withLease(
    flaky,
    async () => {
      tick!();
      await new Promise((resolve) => setImmediate(resolve));
      return 'done';
    },
    {
      name: NAME,
      holder: 'a',
      ttlMs: 1000,
      heartbeatMs: 100,
      timers: {
        setInterval: (fn: () => void) => {
          tick = fn;
          return 1 as unknown as NodeJS.Timeout;
        },
        clearInterval: () => {},
      },
      warn: (message) => warnings.push(message),
    },
  );
  assert.deepEqual(result, { acquired: true, value: 'done' });
  assert.equal(warnings.length, 2);
});

test('warns when the heartbeat finds the lease was lost', async () => {
  const clock = { now: 0 };
  const { store, leases } = fakeStore(clock);
  let tick: (() => void) | null = null;
  const warnings: string[] = [];
  await withLease(
    store,
    async () => {
      // e.g. the laptop slept past the TTL and another run took over.
      leases.set(NAME, { holder: 'b', expiresAt: 10_000 });
      tick!();
      await new Promise((resolve) => setImmediate(resolve));
    },
    {
      name: NAME,
      holder: 'a',
      ttlMs: 1000,
      heartbeatMs: 100,
      timers: {
        setInterval: (fn: () => void) => {
          tick = fn;
          return 1 as unknown as NodeJS.Timeout;
        },
        clearInterval: () => {},
      },
      warn: (message) => warnings.push(message),
    },
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /lost/);
  // Release must not delete the new holder's lease.
  assert.equal(leases.get(NAME)?.holder, 'b');
});
