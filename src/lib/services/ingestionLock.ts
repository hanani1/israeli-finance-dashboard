/**
 * Run-wide ingestion lock as a database lease (card #48, ADR-0021).
 *
 * Why a lease row and not `pg_try_advisory_lock`: a session-level advisory
 * lock must be released on the same connection that took it, and Prisma's
 * pool gives no connection affinity outside a transaction; a scrape run lasts
 * minutes, far too long to hold one transaction open. A lease row (holder +
 * expiresAt, renewed by a heartbeat) works over any pooled connection, needs
 * no new dependency, and cannot stay held forever: if the holder crashes or
 * is killed, the heartbeat stops and the lease expires after `ttlMs`.
 *
 * This module is pure (no Prisma import) so it can be tested with a fake
 * store; the Prisma-backed store lives in `src/lib/jobs/ingestionLease.ts`.
 */

export interface LeaseStore {
  /** Take the lease if it is free or expired. True when `holder` now owns it. */
  tryAcquire(name: string, holder: string, ttlMs: number): Promise<boolean>;
  /** Extend the caller's own lease. False when it is no longer the holder. */
  renew(name: string, holder: string, ttlMs: number): Promise<boolean>;
  /** Drop the caller's own lease; never touches another holder's lease. */
  release(name: string, holder: string): Promise<void>;
}

export type LeaseResult<T> = { acquired: true; value: T } | { acquired: false };

export interface LeaseOptions {
  name: string;
  holder: string;
  ttlMs: number;
  heartbeatMs: number;
  timers?: {
    setInterval: (fn: () => void, ms: number) => NodeJS.Timeout;
    clearInterval: (handle: NodeJS.Timeout) => void;
  };
  warn?: (message: string) => void;
}

export const INGESTION_LEASE_NAME = 'finance.ingestion';
/** Worst-case wait after a crash before another run may start. */
export const INGESTION_LEASE_TTL_MS = 10 * 60_000;
export const INGESTION_LEASE_HEARTBEAT_MS = 60_000;
export const INGESTION_ALREADY_RUNNING = 'ingestion already running';

/**
 * Run `fn` while holding the named lease, or return `{ acquired: false }`
 * without running it when another live holder owns the lease. The lease is
 * renewed every `heartbeatMs` and released in `finally`, including on throw.
 */
export async function withLease<T>(
  store: LeaseStore,
  fn: () => Promise<T>,
  options: LeaseOptions,
): Promise<LeaseResult<T>> {
  const { name, holder, ttlMs, heartbeatMs } = options;
  const timers = options.timers ?? { setInterval, clearInterval };
  const warn = options.warn ?? ((message: string) => console.warn(message));

  if (!(await store.tryAcquire(name, holder, ttlMs))) {
    return { acquired: false };
  }

  let lostReported = false;
  const heartbeat = timers.setInterval(() => {
    store.renew(name, holder, ttlMs).then(
      (stillHeld) => {
        if (!stillHeld && !lostReported) {
          lostReported = true;
          warn(`[lock] Lease ${name} was lost by ${holder} (expired while running?); another run may overlap.`);
        }
      },
      (error: unknown) => {
        warn(`[lock] Heartbeat for ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
  }, heartbeatMs);
  heartbeat.unref?.();

  try {
    return { acquired: true, value: await fn() };
  } finally {
    timers.clearInterval(heartbeat);
    try {
      await store.release(name, holder);
    } catch (error) {
      // The lease expires on its own after ttlMs; never mask fn's outcome.
      warn(`[lock] Releasing ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
