import type { IsracardBrowserLaunch } from '@/lib/services/isracardBrowser';

export interface CredentialSyncResult {
  credentialsProcessed: number;
  errors: string[];
  /** Set when the run-wide ingestion lock was held by another run. */
  skipped?: string;
}

/** A connection is visible only when its one-credential initial sync succeeded. */
export function shouldKeepCredentialAfterSync(sync: CredentialSyncResult): boolean {
  return initialSyncOutcome(sync) === 'keep';
}

/**
 * keep: verified, show the connection. failed: the sync ran and failed.
 * busy: another ingestion run held the lock, so the credential was never
 * tried; roll it back like a failure but ask the user to retry later.
 */
export function initialSyncOutcome(sync: CredentialSyncResult): 'keep' | 'failed' | 'busy' {
  if (sync.skipped) return 'busy';
  return sync.credentialsProcessed === 1 && sync.errors.length === 0 ? 'keep' : 'failed';
}

export type InitialSyncDecision =
  | { mode: 'inline' }
  | { mode: 'deferred'; reason: string };

export const ISRACARD_DEFERRED_REASON =
  'Isracard requires the host browser; the first import runs with the next host sync (npm run sync:once).';

/**
 * Decide whether saving a credential should run its initial full-history sync
 * in the web process right away.
 *
 * Isracard is behind a Cloudflare bot score. The library's headless Chromium
 * (what the Docker web/worker containers have) is either challenged on the
 * login page (HTTP 403) or rate-limited on DashboardMonth (HTTP 429,
 * "Automation detected and blocked"), whereas the host's real Chrome with a
 * persistent profile completes a full-history import cleanly. So when no host
 * browser launch plan exists, the credential is saved and its first import is
 * left to the host-run sync instead of failing and rolling back.
 */
export function decideInitialSync(
  provider: string,
  isracardLaunch: IsracardBrowserLaunch | undefined,
): InitialSyncDecision {
  if (provider === 'isracard' && !isracardLaunch) {
    return { mode: 'deferred', reason: ISRACARD_DEFERRED_REASON };
  }
  return { mode: 'inline' };
}
