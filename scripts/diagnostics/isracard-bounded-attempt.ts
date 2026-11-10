/**
 * Safety class: TOUCHES PROVIDER, SENSITIVE (one real login with the stored credential; lockout risk; no DB writes).
 *
 * One bounded, read-only Isracard login/scrape attempt with network evidence.
 *
 * Runs the real israeli-bank-scrapers Isracard scraper exactly once and hooks
 * the Puppeteer page it uses to record every request/response against the
 * provider origin: URL, HTTP status, allowlisted headers, request stage and a
 * redacted body (password/ID/card/token values replaced). Nothing is written
 * to the database; the credential is read with a column-scoped query so the
 * script works even if local migrations lag behind the Prisma client.
 *
 * Usage:
 *   npx tsx scripts/diagnostics/isracard-bounded-attempt.ts                 # library's bundled Chromium (headless)
 *   npx tsx scripts/diagnostics/isracard-bounded-attempt.ts --profile       # host Chrome, headful, persistent profile
 *                                                               # (the exact path ingestion uses)
 *   npx tsx scripts/diagnostics/isracard-bounded-attempt.ts --real-chrome   # host Chrome via executablePath, no profile
 *   add --show to make the library's own browser visible
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createScraper, CompanyTypes } from 'israeli-bank-scrapers';
import type { ScraperCredentials } from 'israeli-bank-scrapers';
import type { Page, HTTPRequest, HTTPResponse } from 'puppeteer';
import { decryptSecret } from '../../src/lib/security/crypto';
import {
  launchIsracardBrowser,
  resolveIsracardBrowserLaunch,
  resolveIsracardExecutablePath,
} from '../../src/lib/services/isracardBrowser';

try {
  process.loadEnvFile('.env');
} catch {
  // rely on environment / Keychain
}

const HEADER_ALLOWLIST = [
  'server',
  'cf-ray',
  'cf-mitigated',
  'cf-cache-status',
  'content-type',
  'location',
  'x-frame-options',
];

type Captured = {
  seq: number;
  at: string;
  method: string;
  url: string;
  resourceType: string;
  requestHeadersSubset?: Record<string, string>;
  requestBody?: string;
  status?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  failure?: string;
};

function pick(headers: Record<string, string>, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) if (headers[n] !== undefined) out[n] = headers[n];
  return out;
}

function makeRedactor(secrets: string[]) {
  const ordered = [...new Set(secrets.filter((s) => s.length >= 4))].sort((a, b) => b.length - a.length);
  return (text: string): string => {
    let out = text;
    for (const s of ordered) out = out.split(s).join('<redacted>');
    out = out.replace(/(__RequestVerificationToken["']?\s*[:=]\s*["']?)[A-Za-z0-9_-]{20,}/gi, '$1<redacted>');
    out = out.replace(/("(?:Sisma|sisma|password|MisparZihuy|KodMishtamesh|userName|cardSuffix|card6Digits|instanceId|token)"\s*:\s*")[^"]*(")/gi, '$1<redacted>$2');
    out = out.replace(/((?:Sisma|sisma|password|MisparZihuy|KodMishtamesh|userName|cardSuffix|instanceId)=)[^&\s]*/gi, '$1<redacted>');
    return out;
  };
}

async function main(): Promise<void> {
  const useRealChrome = process.argv.includes('--real-chrome');
  const useProfile = process.argv.includes('--profile');
  const showBrowser = process.argv.includes('--show');
  const prisma = new PrismaClient();
  const rows = await prisma.$queryRaw<Array<{ encryptedData: string; iv: string; authTag: string }>>`
    SELECT "encryptedData", "iv", "authTag" FROM "BankCredential" WHERE provider = 'isracard' LIMIT 1`;
  const txnCountBefore = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM "Transaction"`;
  await prisma.$disconnect();
  const row = rows[0];
  if (!row) throw new Error('No isracard credential stored.');

  const fields = JSON.parse(
    decryptSecret({ ciphertext: row.encryptedData, iv: row.iv, tag: row.authTag }),
  ) as Record<string, string>;
  const redact = makeRedactor(Object.values(fields));

  const outDir = path.resolve('debug-screenshots');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `isracard-attempt-${stamp}.json`);

  const captured: Captured[] = [];
  const bySeq = new Map<HTTPRequest, Captured>();
  let seq = 0;

  const executablePath = useRealChrome
    ? resolveIsracardExecutablePath({ ISRACARD_EXECUTABLE_PATH: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }, process.platform)
    : undefined;
  const launchPlan = useProfile ? resolveIsracardBrowserLaunch(process.env, process.platform) : undefined;
  if (useProfile && !launchPlan) throw new Error('--profile requires a host browser (ISRACARD_EXECUTABLE_PATH or macOS Chrome).');
  const externalBrowser = launchPlan ? await launchIsracardBrowser(launchPlan) : undefined;
  const browserLabel = launchPlan
    ? `host-chrome-profile(${launchPlan.headless ? 'headless' : 'headful'})`
    : useRealChrome ? 'host-chrome' : 'bundled-chromium';

  const startDate = new Date();
  const fullHistory = process.argv.includes("--full-history");
  if (fullHistory) startDate.setFullYear(1970, 0, 1);
  else startDate.setDate(startDate.getDate() - 14);

  const scraper = createScraper({
    companyId: CompanyTypes.isracard,
    startDate,
    combineInstallments: false,
    verbose: true,
    timeout: 120_000,
    defaultTimeout: 120_000,
    ...(externalBrowser
      ? { browser: externalBrowser }
      : { showBrowser, executablePath, args: ['--no-sandbox', '--disable-setuid-sandbox'] }),
    // Hook the page before login() runs so we see the provider exchange.
    preparePage: async (page: Page) => {
      page.on('request', (request: HTTPRequest) => {
        const url = request.url();
        if (!/isracard\.co\.il|americanexpress\.co\.il/i.test(url)) return;
        const entry: Captured = {
          seq: ++seq,
          at: new Date().toISOString(),
          method: request.method(),
          url: url.replace(/(reqName=[A-Za-z]+)[^#]*/, '$1'),
          resourceType: request.resourceType(),
        };
        if (/ProxyRequestHandler|\/ocp\//i.test(url)) {
          entry.requestHeadersSubset = pick(request.headers(), ['content-type', 'accept', 'origin', 'referer', 'x-requested-with']);
          if (request.headers()['__requestverificationtoken']) entry.requestHeadersSubset.__RequestVerificationToken = '<present>';
          const body = request.postData();
          if (body) entry.requestBody = redact(body).slice(0, 2000);
        }
        captured.push(entry);
        bySeq.set(request, entry);
      });
      page.on('response', async (response: HTTPResponse) => {
        const entry = bySeq.get(response.request());
        if (!entry) return;
        entry.status = response.status();
        entry.responseHeaders = pick(response.headers(), HEADER_ALLOWLIST);
        const url = response.url();
        const ct = response.headers()['content-type'] ?? '';
        if (/ProxyRequestHandler|\/ocp\//i.test(url) || (/text\/html/i.test(ct) && response.status() !== 200)) {
          try {
            const text = await response.text();
            entry.responseBody = redact(text).slice(0, 4000);
          } catch (error) {
            entry.responseBody = `<unavailable: ${error instanceof Error ? error.message : String(error)}>`;
          }
        }
      });
      page.on('requestfailed', (request: HTTPRequest) => {
        const entry = bySeq.get(request);
        if (entry) entry.failure = request.failure()?.errorText;
      });
    },
  });

  console.log(`[attempt] browser=${browserLabel} profile=${launchPlan?.userDataDir ?? '-'} startDate=${startDate.toISOString().slice(0, 10)}`);
  const startedAt = new Date().toISOString();
  let result;
  try {
    result = await scraper.scrape(fields as unknown as ScraperCredentials);
  } finally {
    await externalBrowser?.close();
  }
  const finishedAt = new Date().toISOString();

  const prisma2 = new PrismaClient();
  const txnCountAfter = await prisma2.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM "Transaction"`;
  await prisma2.$disconnect();

  const summary = {
    startedAt,
    finishedAt,
    browser: browserLabel,
    success: result.success,
    errorType: result.errorType,
    errorMessage: result.errorMessage ? redact(result.errorMessage) : undefined,
    accounts: result.accounts?.map((a) => ({ accountNumber: `…${a.accountNumber.slice(-4)}`, txns: a.txns.length })),
    dbTransactionCount: { before: Number(txnCountBefore[0]?.n ?? -1), after: Number(txnCountAfter[0]?.n ?? -1) },
    providerExchanges: captured.filter((c) => /ProxyRequestHandler|\/ocp\//i.test(c.url)),
    nonOkResponses: captured.filter((c) => c.status !== undefined && c.status >= 400),
    totalCaptured: captured.length,
  };
  writeFileSync(outFile, JSON.stringify({ summary, all: captured }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(summary, null, 2));
  console.log(`[attempt] full capture -> ${outFile}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
