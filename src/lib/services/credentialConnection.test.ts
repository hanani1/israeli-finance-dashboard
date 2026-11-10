import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shouldKeepCredentialAfterSync } from './credentialConnection';

test('keeps a credential only after its single-credential sync succeeds', () => {
  assert.equal(
    shouldKeepCredentialAfterSync({ credentialsProcessed: 1, errors: [] }),
    true,
  );
});

test('does not keep a credential when its sync reports an error', () => {
  assert.equal(
    shouldKeepCredentialAfterSync({
      credentialsProcessed: 0,
      errors: ['Scrape failed for provider isracard: INVALID_PASSWORD'],
    }),
    false,
  );
});

// --- Deferring the initial sync to the host -----------------------------------
// Isracard sits behind a Cloudflare bot score: the library's headless Chromium
// in Docker is challenged (403) or rate-limited on DashboardMonth (429), while
// the host's real Chrome with a persistent profile succeeds. When the web app
// runs without a host browser, saving an Isracard credential must not run the
// initial sync inline; the host sync imports it instead.
import { decideInitialSync } from './credentialConnection';

test('defers the Isracard initial sync when no host browser is available', () => {
  assert.deepEqual(decideInitialSync('isracard', undefined), {
    mode: 'deferred',
    reason:
      'Isracard requires the host browser; the first import runs with the next host sync (npm run sync:once).',
  });
});

test('runs the Isracard initial sync inline when a host browser launch plan exists', () => {
  assert.deepEqual(
    decideInitialSync('isracard', { executablePath: '/chrome', userDataDir: '/p', headless: false }),
    { mode: 'inline' },
  );
});

test('runs other providers inline regardless of host browser availability', () => {
  assert.deepEqual(decideInitialSync('max', undefined), { mode: 'inline' });
  assert.deepEqual(decideInitialSync('visaCal', undefined), { mode: 'inline' });
});

// --- Initial sync skipped by the run-wide ingestion lock (card #48) -----------
// If another run holds the lock, the new credential was never verified: roll
// it back like a failed sync, but tell the caller to retry (409), not that the
// login failed (400).
import { initialSyncOutcome } from './credentialConnection';

test('initial sync outcome: keep after a clean single-credential sync', () => {
  assert.equal(initialSyncOutcome({ credentialsProcessed: 1, errors: [] }), 'keep');
});

test('initial sync outcome: failed when the sync reports an error', () => {
  assert.equal(
    initialSyncOutcome({ credentialsProcessed: 0, errors: ['INVALID_PASSWORD'] }),
    'failed',
  );
});

test('initial sync outcome: busy when skipped because ingestion is already running', () => {
  assert.equal(
    initialSyncOutcome({ credentialsProcessed: 0, errors: [], skipped: 'ingestion already running' }),
    'busy',
  );
  assert.equal(
    shouldKeepCredentialAfterSync({ credentialsProcessed: 0, errors: [], skipped: 'ingestion already running' }),
    false,
  );
});
