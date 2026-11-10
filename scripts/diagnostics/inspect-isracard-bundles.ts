/**
 * Safety class: TOUCHES PROVIDER (public login page only, no credentials; no DB access).
 *
 * Read-only: download the public Isracard login JS bundles through a browser
 * session and extract the request contract the official site uses for
 * ValidateIdData / performLogonI (field names, headers, captcha usage).
 * No credentials are used; nothing is written to the database.
 */
import { writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer';

const LOGIN_URL = 'https://digital.isracard.co.il/personalarea/Login';

async function main(): Promise<void> {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const ua = await page.evaluate(() => navigator.userAgent);
    await page.setUserAgent(ua.replace('HeadlessChrome/', 'Chrome/'));
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 3_000));

    const bundleUrls = await page.evaluate(() =>
      Array.from(document.scripts)
        .map((s) => s.src)
        .filter((src) => /digital\.isracard\.co\.il\/bundles\//i.test(src)),
    );
    console.log('bundles:', bundleUrls.map((u) => u.replace(/\?.*/, '')));

    for (const url of bundleUrls) {
      const name = url.match(/bundles\/([A-Za-z0-9]+)/)?.[1] ?? 'bundle';
      const text = await page.evaluate(async (u) => {
        const res = await fetch(u, { credentials: 'include' });
        return res.ok ? res.text() : `__HTTP_${res.status}__`;
      }, url);
      const out = `/tmp/isracard-bundle-${name}.js`;
      writeFileSync(out, text, { mode: 0o600 });
      console.log(`${name}: ${text.length} bytes -> ${out}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exitCode = 1;
});
