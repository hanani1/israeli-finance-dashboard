/**
 * Safety class: TOUCHES PROVIDER (public login page only, no credentials; no DB access).
 *
 * Read-only WAF probe for the Isracard login page.
 *
 * Mirrors the browser setup israeli-bank-scrapers@6.12.1 uses for Isracard
 * (headless Chromium, masked "HeadlessChrome" UA, detector-dom.min.js aborted)
 * and records, for every response from the provider origin: HTTP status,
 * a body classification (Cloudflare block / challenge / app page), and a
 * small allowlist of headers. It never sends credentials, never touches the
 * database and never retries.
 *
 * Usage:
 *   npx tsx scripts/diagnostics/inspect-isracard-waf.ts                # bundled Chromium
 *   npx tsx scripts/diagnostics/inspect-isracard-waf.ts --real-chrome  # host Google Chrome
 */
import { writeFileSync } from 'node:fs';
import puppeteer, { type HTTPResponse } from 'puppeteer';

const LOGIN_URL = 'https://digital.isracard.co.il/personalarea/Login';
const HEADER_ALLOWLIST = ['server', 'cf-ray', 'cf-mitigated', 'cf-cache-status', 'content-type', 'location'];

type Evidence = {
  url: string;
  status: number;
  fromServiceWorker: boolean;
  headers: Record<string, string>;
  bodyClass?: string;
  bodyBytes?: number;
};

function classifyBody(html: string): string {
  if (/Sorry, you have been blocked/i.test(html)) return 'cloudflare-block-1020';
  if (/Just a moment|cf-chl|challenge-platform|__cf_chl/i.test(html)) return 'cloudflare-managed-challenge';
  if (/turnstile/i.test(html)) return 'cloudflare-turnstile';
  if (/Attention Required! \| Cloudflare/i.test(html)) return 'cloudflare-other';
  if (/AuthLoginJs|__RequestVerificationToken|ng-app/i.test(html)) return 'isracard-login-app';
  return 'unclassified';
}

function pickHeaders(headers: Record<string, string>): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of HEADER_ALLOWLIST) {
    if (headers[name] !== undefined) picked[name] = headers[name];
  }
  return picked;
}

async function main(): Promise<void> {
  const useRealChrome = process.argv.includes('--real-chrome');
  const executablePath = useRealChrome
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : undefined;

  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const evidence: Evidence[] = [];
  const startedAt = new Date().toISOString();

  try {
    const page = await browser.newPage();

    // Same interception + UA masking the library applies in login().
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (request.url().includes('detector-dom.min.js')) void request.abort();
      else void request.continue();
    });
    const userAgent = await page.evaluate(() => navigator.userAgent);
    await page.setUserAgent(userAgent.replace('HeadlessChrome/', 'Chrome/'));

    page.on('response', (response: HTTPResponse) => {
      const url = response.url();
      if (!/isracard\.co\.il/i.test(url)) return;
      const entry: Evidence = {
        url: url.replace(/\?.*$/, '?<query-redacted>'),
        status: response.status(),
        fromServiceWorker: response.fromServiceWorker(),
        headers: pickHeaders(response.headers()),
      };
      evidence.push(entry);
      const contentType = response.headers()['content-type'] ?? '';
      if (/text\/html/i.test(contentType)) {
        response
          .text()
          .then((html) => {
            entry.bodyClass = classifyBody(html);
            entry.bodyBytes = html.length;
          })
          .catch(() => {
            entry.bodyClass = 'body-unavailable';
          });
      }
    });

    let navigationError: string | undefined;
    let mainStatus: number | undefined;
    try {
      const response = await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      mainStatus = response?.status();
    } catch (error) {
      navigationError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));

    const pageState = await page
      .evaluate(() => ({
        finalUrl: location.href,
        title: document.title,
        hasAntiForgeryForm: Boolean(document.querySelector('input[name="__RequestVerificationToken"]')),
        hasRecaptchaScript: Array.from(document.scripts).some((s) => /recaptcha/i.test(s.src)),
        hasFixedPasswordLink: Boolean(document.querySelector('#flip')),
        cookieNames: document.cookie.split(';').map((c) => c.split('=')[0]?.trim()).filter(Boolean),
      }))
      .catch((error: unknown) => ({ evaluateError: error instanceof Error ? error.message : String(error) }));

    const report = {
      startedAt,
      finishedAt: new Date().toISOString(),
      browser: useRealChrome ? 'host-google-chrome' : 'puppeteer-bundled-chromium',
      browserVersion: await browser.version(),
      userAgentMasked: (await page.evaluate(() => navigator.userAgent)).replace(/\d+\.\d+\.\d+\.\d+/g, 'x.x.x.x'),
      mainStatus,
      navigationError,
      pageState,
      responses: evidence,
    };
    const outPath = `debug-screenshots/isracard-waf-probe-${useRealChrome ? 'chrome' : 'chromium'}.json`;
    writeFileSync(outPath, JSON.stringify(report, null, 2), { mode: 0o600 });
    await page.screenshot({ path: outPath.replace(/\.json$/, '.png'), fullPage: true }).catch(() => undefined);
    console.log(JSON.stringify({ ...report, responses: undefined }, null, 2));
    console.log(`responses=${evidence.length} written to ${outPath}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
