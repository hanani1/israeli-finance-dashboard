import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import puppeteer, { type Browser } from 'puppeteer';

const MACOS_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEFAULT_PROFILE_RELATIVE_DIR = path.join('.finance-dashboard', 'isracard-chrome-profile');

export type IsracardBrowserEnvironment = {
  ISRACARD_EXECUTABLE_PATH?: string;
  ISRACARD_USER_DATA_DIR?: string;
  ISRACARD_HEADLESS?: string;
  HOME?: string;
  [key: string]: string | undefined;
};

export type IsracardBrowserLaunch = {
  executablePath: string;
  /** Persistent Chrome profile that keeps Cloudflare's cf_clearance between runs. */
  userDataDir: string;
  headless: boolean;
};

/**
 * Select a real browser only when the operator explicitly configures one, or
 * when running locally on macOS with the standard Chrome installation.
 * Docker/Linux must not guess a host path; Puppeteer's configured browser is
 * used there instead.
 */
export function resolveIsracardExecutablePath(
  environment: IsracardBrowserEnvironment,
  platform: NodeJS.Platform,
  fileExists: (path: string) => boolean = existsSync,
): string | undefined {
  const configuredPath = environment.ISRACARD_EXECUTABLE_PATH?.trim();
  if (configuredPath) {
    if (!fileExists(configuredPath)) {
      throw new Error(
        `ISRACARD_EXECUTABLE_PATH points to a missing executable: ${configuredPath}`,
      );
    }
    return configuredPath;
  }

  if (platform === 'darwin' && fileExists(MACOS_CHROME_PATH)) {
    return MACOS_CHROME_PATH;
  }

  return undefined;
}

/**
 * Decide how to launch the host browser for Isracard.
 *
 * digital.isracard.co.il is behind a Cloudflare managed challenge. A real
 * Chrome passes it by itself; a persistent user-data-dir keeps the resulting
 * clearance cookie so later runs are not challenged again. The browser is
 * headful by default because the challenge is far more reliable that way;
 * `ISRACARD_HEADLESS=true` opts into headless for unattended hosts that have
 * already been cleared. Nothing here solves or bypasses the challenge.
 *
 * Returns undefined when no host browser is available (Docker/Linux without
 * `ISRACARD_EXECUTABLE_PATH`), in which case the library's default browser
 * is used.
 */
export function resolveIsracardBrowserLaunch(
  environment: IsracardBrowserEnvironment,
  platform: NodeJS.Platform,
  fileExists: (path: string) => boolean = existsSync,
): IsracardBrowserLaunch | undefined {
  const executablePath = resolveIsracardExecutablePath(environment, platform, fileExists);
  if (!executablePath) return undefined;

  const configuredDir = environment.ISRACARD_USER_DATA_DIR?.trim();
  let userDataDir: string;
  if (configuredDir) {
    userDataDir = configuredDir;
  } else if (environment.HOME) {
    userDataDir = path.join(environment.HOME, DEFAULT_PROFILE_RELATIVE_DIR);
  } else {
    throw new Error(
      'Cannot place the Isracard Chrome profile: set ISRACARD_USER_DATA_DIR (HOME is not available).',
    );
  }

  return {
    executablePath,
    userDataDir,
    headless: environment.ISRACARD_HEADLESS?.trim().toLowerCase() === 'true',
  };
}

/**
 * Launch the host browser according to a launch plan. The caller owns the
 * returned browser and must close it. Uses a dedicated profile directory so
 * it never collides with the user's everyday Chrome profile.
 */
export async function launchIsracardBrowser(launch: IsracardBrowserLaunch): Promise<Browser> {
  mkdirSync(launch.userDataDir, { recursive: true, mode: 0o700 });
  return puppeteer.launch({
    executablePath: launch.executablePath,
    userDataDir: launch.userDataDir,
    headless: launch.headless,
    // A real window size; the library sets its own viewport per page.
    defaultViewport: null,
    args: ['--no-first-run', '--no-default-browser-check', '--window-size=1280,900'],
  });
}
