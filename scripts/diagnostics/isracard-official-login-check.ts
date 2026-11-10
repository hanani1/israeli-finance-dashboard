/**
 * Safety class: TOUCHES PROVIDER, SENSITIVE (one real login with the stored credential; lockout risk; no DB writes).
 *
 * One bounded, login-only check of Isracard's OFFICIAL password sequence.
 *
 * israeli-bank-scrapers@6.12.1 logs in with ValidateIdData -> performLogonI
 * and sends KodMishtamesh. The public login bundle (bundles/AuthLoginJs) does
 * something different for the fixed-password form:
 *   1. ValidateIdDataNoReg  (JSON content type)  – includes `sisma` + isGoogleCaptcha
 *   2. IsRegisterNoReg      (form content type)  – { id, idType }
 *   3. performLogonI        (form content type)  – WITHOUT KodMishtamesh
 *      (the `loginDetails.userName = …` assignment is commented out on the site)
 * Every call carries the page's `__RequestVerificationToken` header.
 *
 * This script replays that sequence once through the persistent real-Chrome
 * profile, reports each step's status (secrets redacted) and stops after the
 * login answer. It never fetches transactions and never writes to the DB.
 *
 * Usage: npx tsx scripts/diagnostics/isracard-official-login-check.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { decryptSecret } from '../../src/lib/security/crypto';
import { launchIsracardBrowser, resolveIsracardBrowserLaunch } from '../../src/lib/services/isracardBrowser';

try {
  process.loadEnvFile('.env');
} catch {
  // rely on environment / Keychain
}

const LOGIN_URL = 'https://digital.isracard.co.il/personalarea/Login';
const SERVICES_URL = 'https://digital.isracard.co.il/services/ProxyRequestHandler.ashx';
const COMPANY_CODE = '11';
const COUNTRY_CODE = '212';
const ID_TYPE = '1';

type StepResult = { step: string; httpStatus: number; body: unknown };

function makeRedactor(secrets: string[]) {
  const ordered = [...new Set(secrets.filter((s) => s.length >= 4))].sort((a, b) => b.length - a.length);
  return (value: unknown): unknown => {
    let text = JSON.stringify(value);
    for (const s of ordered) text = text.split(s).join('<redacted>');
    text = text.replace(
      /("(?:userName|KodMishtamesh|fullCardNumber|idNumber|firstName|lastName)"\s*:\s*")[^"]+(")/g,
      '$1<redacted>$2',
    );
    return JSON.parse(text);
  };
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const rows = await prisma.$queryRaw<Array<{ encryptedData: string; iv: string; authTag: string }>>`
    SELECT "encryptedData", "iv", "authTag" FROM "BankCredential" WHERE provider = 'isracard' LIMIT 1`;
  await prisma.$disconnect();
  const row = rows[0];
  if (!row) throw new Error('No isracard credential stored.');
  const fields = JSON.parse(
    decryptSecret({ ciphertext: row.encryptedData, iv: row.iv, tag: row.authTag }),
  ) as { id: string; card6Digits: string; password: string };
  const redact = makeRedactor(Object.values(fields));

  const launch = resolveIsracardBrowserLaunch(process.env, process.platform);
  if (!launch) throw new Error('Requires a host browser (macOS Chrome or ISRACARD_EXECUTABLE_PATH).');
  const browser = await launchIsracardBrowser(launch);
  const steps: StepResult[] = [];
  let verdict = 'unknown';

  try {
    const page = await browser.newPage();
    const response = await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    console.log(
      `[official] login page HTTP ${response?.status()} cf-mitigated=${response?.headers()['cf-mitigated'] ?? '-'}`,
    );
    if (!response || response.status() !== 200) {
      verdict = `login page status ${response?.status()}`;
      return;
    }
    await new Promise((r) => setTimeout(r, 2_500));

    // Same page-level inputs the site's DigitalServices class reads.
    const pageConfig = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const tokenInput = document.querySelector<HTMLInputElement>('input[name="__RequestVerificationToken"]');
      return {
        hasGlobalToken: typeof w.Token === 'string',
        hasFormToken: Boolean(tokenInput?.value),
        staticURL: typeof w.staticURL === 'string' ? (w.staticURL as string) : null,
        currentLogonServiceName:
          typeof w.currentLogonServiceName === 'string' ? (w.currentLogonServiceName as string) : null,
      };
    });
    console.log('[official] page config:', JSON.stringify(pageConfig));

    // Helper executed inside the page: POST with the site's headers.
    const post = async (reqName: string, data: Record<string, unknown>, json: boolean): Promise<StepResult> => {
      const [status, text] = await page.evaluate(
        async (url: string, body: string, useJson: boolean) => {
          const w = window as unknown as Record<string, unknown>;
          const tokenInput = document.querySelector<HTMLInputElement>('input[name="__RequestVerificationToken"]');
          const token = typeof w.Token === 'string' ? (w.Token as string) : tokenInput?.value ?? '';
          const res = await fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: {
              'content-type': useJson
                ? 'application/json; charset=UTF-8'
                : 'application/x-www-form-urlencoded; charset=UTF-8',
              accept: 'application/json, text/plain, */*',
              __RequestVerificationToken: token,
            },
            body,
          });
          return [res.status, await res.text()] as [number, string];
        },
        `${SERVICES_URL}?reqName=${reqName}`,
        JSON.stringify(data),
        json,
      );
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // keep raw text (e.g. an HTML block page)
      }
      const result = { step: reqName, httpStatus: status, body: redact(body) };
      steps.push(result);
      console.log(`[official] ${reqName} -> HTTP ${status}`, JSON.stringify(result.body).slice(0, 400));
      return { step: reqName, httpStatus: status, body };
    };

    // Step 1: ValidateIdDataNoReg (getValidateIdRequest(true) on the site).
    const validate = await post(
      'ValidateIdDataNoReg',
      {
        id: fields.id,
        idType: ID_TYPE,
        cardSuffix: fields.card6Digits,
        sisma: fields.password,
        checkLevel: '1',
        companyCode: COMPANY_CODE,
        countryCode: COUNTRY_CODE,
        isGoogleCaptcha: true,
      },
      true,
    );
    const validateBody = validate.body as {
      Header?: { Status?: string };
      ValidateIdDataNoRegBean?: { returnCode?: string; message?: string };
    };
    const returnCode = validateBody?.ValidateIdDataNoRegBean?.returnCode;
    if (validateBody?.Header?.Status !== '1' || returnCode !== '1') {
      verdict = `ValidateIdDataNoReg header=${validateBody?.Header?.Status} returnCode=${returnCode}`;
      return;
    }

    // Step 2: IsRegisterNoReg.
    const registered = await post('IsRegisterNoReg', { id: fields.id, idType: ID_TYPE }, false);
    const registeredBody = registered.body as { IsRegisterNoRegBean?: { returnCode?: string } };
    const registeredCode = registeredBody?.IsRegisterNoRegBean?.returnCode;
    if (registeredCode === '7') {
      verdict = 'IsRegisterNoReg returnCode=7 (user has no password / not registered)';
      return;
    }

    // Step 3: performLogonI exactly as the site builds LoginRequest (no KodMishtamesh).
    const logon = await post(
      'performLogonI',
      {
        MisparZihuy: fields.id,
        countryCode: COUNTRY_CODE,
        idType: ID_TYPE,
        Sisma: fields.password,
        cardSuffix: fields.card6Digits,
      },
      false,
    );
    const logonBody = logon.body as { status?: string; isCaptcha?: string; message?: string };
    verdict = `performLogonI status=${logonBody?.status} isCaptcha=${logonBody?.isCaptcha}`;
  } finally {
    await browser.close();
    const outDir = path.resolve('debug-screenshots');
    mkdirSync(outDir, { recursive: true });
    const outFile = path.join(
      outDir,
      `isracard-official-login-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    );
    writeFileSync(outFile, JSON.stringify({ verdict, steps }, null, 2), { mode: 0o600 });
    console.log(`[official] verdict: ${verdict}`);
    console.log(`[official] capture -> ${outFile}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
