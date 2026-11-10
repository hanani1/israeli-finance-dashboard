/**
 * Safety class: TOUCHES PROVIDER (public login page only, no credentials; no DB access).
 *
 * Read-only: open the public login page, switch to fixed-password mode and
 * print the password/id/card inputs' HTML attributes (maxlength, pattern,
 * ng-pattern, ng-trim, etc.). Nothing is typed or submitted.
 */
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
    const flip = await page.$('#flip');
    if (flip) {
      await flip.click();
      await new Promise((r) => setTimeout(r, 1_500));
    }
    const inputs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input'))
        .filter((el) => /pwd|password|otpLoginId|LastDigits|card/i.test(`${el.id} ${el.name} ${el.getAttribute('ng-model')}`))
        .map((el) => ({
          name: el.name,
          type: el.type,
          attrs: Object.fromEntries(
            Array.from(el.attributes)
              .filter((a) => !/^(class|style|aria-|placeholder|title)/.test(a.name))
              .map((a) => [a.name, a.value]),
          ),
        })),
    );
    console.log(JSON.stringify(inputs, null, 2));
    const passwordHelp = await page.evaluate(() =>
      Array.from(document.querySelectorAll('*'))
        .map((el) => (el.childElementCount === 0 ? (el.textContent ?? '').trim() : ''))
        .filter((t) => /סיסמ/.test(t) && /\d/.test(t))
        .slice(0, 10),
    );
    console.log('password help texts:', passwordHelp);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exitCode = 1;
});
