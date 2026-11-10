import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveIsracardExecutablePath } from './isracardBrowser';

test('uses an explicitly configured Isracard browser executable', () => {
  assert.equal(
    resolveIsracardExecutablePath(
      { ISRACARD_EXECUTABLE_PATH: '/opt/google/chrome' },
      'linux',
      (path) => path === '/opt/google/chrome',
    ),
    '/opt/google/chrome',
  );
});

test('fails clearly when the configured Isracard browser does not exist', () => {
  assert.throws(
    () => resolveIsracardExecutablePath(
      { ISRACARD_EXECUTABLE_PATH: '/missing/chrome' },
      'linux',
      () => false,
    ),
    /ISRACARD_EXECUTABLE_PATH points to a missing executable: \/missing\/chrome/,
  );
});

test('uses the installed macOS Chrome fallback when available', () => {
  assert.equal(
    resolveIsracardExecutablePath(
      {},
      'darwin',
      (path) => path === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  );
});

test('does not invent a host-browser path in Docker/Linux', () => {
  assert.equal(resolveIsracardExecutablePath({}, 'linux', () => false), undefined);
});

// --- Persistent real-browser profile (Cloudflare managed challenge) ---
// The Isracard login page sits behind a Cloudflare managed challenge that a
// real Chrome passes on its own. A persistent user-data-dir keeps the
// resulting cf_clearance cookie between runs, so the scraper never has to
// solve anything itself.
import { resolveIsracardBrowserLaunch } from './isracardBrowser';

test('launches the host browser headful with a persistent profile when a host browser is available', () => {
  assert.deepEqual(
    resolveIsracardBrowserLaunch(
      { HOME: '/Users/me' },
      'darwin',
      (path) => path === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ),
    {
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      userDataDir: '/Users/me/.finance-dashboard/isracard-chrome-profile',
      headless: false,
    },
  );
});

test('honours an explicit ISRACARD_USER_DATA_DIR', () => {
  assert.equal(
    resolveIsracardBrowserLaunch(
      { HOME: '/Users/me', ISRACARD_EXECUTABLE_PATH: '/opt/google/chrome', ISRACARD_USER_DATA_DIR: '/srv/profile' },
      'linux',
      (path) => path === '/opt/google/chrome',
    )?.userDataDir,
    '/srv/profile',
  );
});

test('allows forcing headless via ISRACARD_HEADLESS=true for unattended hosts', () => {
  assert.equal(
    resolveIsracardBrowserLaunch(
      { HOME: '/Users/me', ISRACARD_HEADLESS: 'true' },
      'darwin',
      (path) => path === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    )?.headless,
    true,
  );
});

test('returns no launch plan in Docker/Linux without a configured browser', () => {
  assert.equal(resolveIsracardBrowserLaunch({ HOME: '/root' }, 'linux', () => false), undefined);
});

test('fails clearly when HOME is unavailable and no profile dir is configured', () => {
  assert.throws(
    () =>
      resolveIsracardBrowserLaunch(
        {},
        'darwin',
        (path) => path === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ),
    /ISRACARD_USER_DATA_DIR/,
  );
});
