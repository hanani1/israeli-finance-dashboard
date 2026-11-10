/**
 * Safety class: TOUCHES PROVIDER (public login page only, no credentials; no DB access).
 *
 * Read-only: load the public Isracard login page in a browser and print the
 * inline JS globals that configure the login flow (service names, captcha
 * flags, handler URL). Anti-forgery tokens and site keys are redacted.
 */
import puppeteer from 'puppeteer';

const LOGIN_URL = 'https://digital.isracard.co.il/personalarea/Login';
const GLOBALS = [
  'currentLogonServiceName',
  'googleRecaptchaV3SiteKey',
  'isDevEnvironment',
  'useFraudMonitorReportService',
  'companyServiceCode',
  'servicePort',
  'urlRedirect',
  'isCaptchaRequired',
  'captchaRequired',
  'captchaRequiredPassword',
  'handlerUrl',
  'IsLoginWith4CardSuffix',
];

async function main(): Promise<void> {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const ua = await page.evaluate(() => navigator.userAgent);
    await page.setUserAgent(ua.replace('HeadlessChrome/', 'Chrome/'));
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 3_000));

    const inline = await page.evaluate(() =>
      Array.from(document.scripts)
        .filter((s) => !s.src)
        .map((s) => s.textContent ?? ''),
    );
    const joined = inline.join('\n');
    for (const name of GLOBALS) {
      const re = new RegExp(`(?:var|let|const)?\\s*\\b${name}\\b\\s*=\\s*([^;\\n]{1,160})`, 'g');
      const values = new Set<string>();
      for (const m of joined.matchAll(re)) values.add((m[1] ?? '').trim());
      const redacted = [...values].map((v) =>
        /SiteKey|Token/i.test(name) ? v.replace(/[A-Za-z0-9_-]{20,}/g, '<redacted>') : v,
      );
      console.log(`${name}: ${redacted.length ? redacted.join(' | ') : '<not found>'}`);
    }
    const handler = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const keys = Object.keys(w).filter((k) =>
        /logon|captcha|recaptcha|servicePort|handlerUrl|companyServiceCode|fraud/i.test(k),
      );
      return keys.map((k) => `${k}=${typeof w[k] === 'string' ? String(w[k]).replace(/[A-Za-z0-9_-]{20,}/g, '<redacted>') : typeof w[k]}`);
    });
    console.log('window globals:', handler);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exitCode = 1;
});
