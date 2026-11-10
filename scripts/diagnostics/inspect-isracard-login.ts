/**
 * Safety class: TOUCHES PROVIDER (public login page only, no credentials; no DB access).
 *
 * Load the public Isracard login page in host Google Chrome (headless, masked
 * webdriver flag), save the AuthLoginJs bundle to /tmp and print the page's
 * controls and the provider responses it triggered. Nothing is typed.
 *
 * Usage: npx tsx scripts/diagnostics/inspect-isracard-login.ts
 */
import puppeteer from 'puppeteer';
import { writeFileSync } from 'node:fs';

const executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function main(): Promise<void> {
  const browser = await puppeteer.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage();
  const userAgent = await page.evaluate(() => navigator.userAgent);
  await page.setUserAgent(userAgent.replace('HeadlessChrome/', 'Chrome/'));
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const interestingResponses: Array<{ url: string; status: number; contentType?: string }> = [];
  page.on('response', (response) => {
    const url = response.url();
    if (/isracard|recaptcha|glassbox|detector|login/i.test(url)) {
      interestingResponses.push({
        url,
        status: response.status(),
        contentType: response.headers()['content-type'],
      });
    }
  });

  await page.goto('https://digital.isracard.co.il/personalarea/Login', {
    waitUntil: 'domcontentloaded',
    timeout: 120_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 5_000));

  const authBundleUrl = await page.evaluate(() =>
    Array.from(document.scripts)
      .map((script) => script.src)
      .find((src) => src.includes('/bundles/AuthLoginJs')),
  );
  if (!authBundleUrl) throw new Error('AuthLoginJs bundle not found');
  const authBundle = await page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(`Auth bundle HTTP ${response.status}`);
    return response.text();
  }, authBundleUrl);
  writeFileSync('/tmp/isracard-auth-login-browser.js', authBundle, { mode: 0o600 });
  console.log(`AUTH_BUNDLE ${authBundleUrl} bytes=${authBundle.length}`);

  const before = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    controls: Array.from(document.querySelectorAll('a,button,input,select,label'))
      .map((el) => ({
        tag: el.tagName,
        id: el.id,
        name: el.getAttribute('name'),
        type: el.getAttribute('type'),
        text: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 120),
        placeholder: el.getAttribute('placeholder'),
        ngClick: el.getAttribute('ng-click'),
        visible: Boolean((el as HTMLElement).offsetWidth || (el as HTMLElement).offsetHeight),
      }))
      .filter((x) => /סיסמ|כניסה|זהות|כרטיס|דרכון|flip|login|password|user/i.test(
        [x.id, x.name, x.type, x.text, x.placeholder, x.ngClick].filter(Boolean).join(' '),
      )),
    scripts: Array.from(document.scripts).map((s) => s.src).filter(Boolean),
    recaptcha: Boolean(document.querySelector('iframe[src*="recaptcha"], .g-recaptcha, [data-sitekey]')),
  }));
  console.log('BEFORE', JSON.stringify(before, null, 2));

  const flip = await page.$('#flip');
  if (!flip) throw new Error('Could not find #flip fixed-password control');
  await flip.click();
  await new Promise((resolve) => setTimeout(resolve, 2_000));

  const after = await page.evaluate(() => ({
    controls: Array.from(document.querySelectorAll('a,button,input,select,label'))
      .map((el) => ({
        tag: el.tagName,
        id: el.id,
        name: el.getAttribute('name'),
        type: el.getAttribute('type'),
        text: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 120),
        placeholder: el.getAttribute('placeholder'),
        ngModel: el.getAttribute('ng-model'),
        ngClick: el.getAttribute('ng-click'),
        visible: Boolean((el as HTMLElement).offsetWidth || (el as HTMLElement).offsetHeight),
      }))
      .filter((x) => x.visible),
    forms: Array.from(document.forms).map((form) => ({
      id: form.id,
      name: form.getAttribute('name'),
      action: form.action,
      method: form.method,
      html: form.outerHTML.slice(0, 12_000),
    })),
    cookies: document.cookie.split(';').map((part) => part.split('=')[0]?.trim()).filter(Boolean),
    localStorageKeys: Object.keys(localStorage),
    sessionStorageKeys: Object.keys(sessionStorage),
    recaptcha: Boolean(document.querySelector('iframe[src*="recaptcha"], .g-recaptcha, [data-sitekey]')),
  }));
  console.log('AFTER', JSON.stringify(after, null, 2));
  console.log('RESPONSES', JSON.stringify(interestingResponses, null, 2));
  await page.screenshot({ path: 'debug-screenshots/isracard-fixed-password-form.png', fullPage: true });
} finally {
  await browser.close();
}
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});