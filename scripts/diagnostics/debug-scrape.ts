/**
 * Safety class: TOUCHES PROVIDER, SENSITIVE (logs in with the decrypted stored credential; no DB writes).
 *
 * One-off debug utility: run a single provider scrape with the library's
 * diagnostic options enabled (verbose logs, failure screenshot, optional
 * visible browser) to find out WHY a login times out.
 *
 * Usage:
 *   npx tsx scripts/diagnostics/debug-scrape.ts max
 *   npx tsx scripts/diagnostics/debug-scrape.ts visaCal --show     # visible browser window
 *
 * Screenshots on failure are written to ./debug-screenshots/.
 * Does NOT write anything to the database.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createScraper, CompanyTypes } from 'israeli-bank-scrapers';
import type { ScraperCredentials } from 'israeli-bank-scrapers';
import { decryptSecret } from '../../src/lib/security/crypto';

try {
  process.loadEnvFile('.env');
} catch {
  // rely on environment / Keychain
}

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const providerArg = process.argv[2];
  const showBrowser = process.argv.includes('--show');
  const useRealChrome = process.argv.includes('--real-chrome');
  const executablePath = useRealChrome
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : undefined;

  if (!providerArg || !(providerArg in CompanyTypes)) {
    console.error(
      `Usage: npx tsx scripts/diagnostics/debug-scrape.ts <provider> [--show]\n` +
        `Known providers: ${Object.keys(CompanyTypes).join(', ')}`,
    );
    process.exitCode = 1;
    return;
  }

  const credential = await prisma.bankCredential.findFirst({
    where: { provider: providerArg },
  });
  if (!credential) {
    console.error(`No stored credential for provider "${providerArg}".`);
    process.exitCode = 1;
    return;
  }

  const loginFields = JSON.parse(
    decryptSecret({
      ciphertext: credential.encryptedData,
      iv: credential.iv,
      tag: credential.authTag,
    }),
  ) as ScraperCredentials;

  const screenshotDir = path.resolve('debug-screenshots');
  mkdirSync(screenshotDir, { recursive: true });

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 30);

  console.log(
    `[debug-scrape] provider=${providerArg} showBrowser=${showBrowser} realChrome=${useRealChrome} timeout=120s startDate=${startDate.toISOString().slice(0, 10)}`,
  );
  console.log(`[debug-scrape] failure screenshots -> ${screenshotDir}`);

  const scraper = createScraper({
    companyId: CompanyTypes[providerArg as keyof typeof CompanyTypes],
    startDate,
    combineInstallments: false,
    showBrowser,
    executablePath,
    verbose: true,
    timeout: 120_000,
    storeFailureScreenShotPath: path.join(
      screenshotDir,
      `${providerArg}-${Date.now()}.png`,
    ),
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  scraper.onProgress((companyId, payload) => {
    console.log(`[progress] ${companyId}: ${payload.type}`);
  });

  const started = Date.now();
  const result = await scraper.scrape(loginFields);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  if (result.success) {
    console.log(`[debug-scrape] SUCCESS in ${seconds}s`);
    for (const account of result.accounts ?? []) {
      console.log(
        `  account ${account.accountNumber}: ${account.txns.length} txns` +
          (account.balance !== undefined ? `, balance ${account.balance}` : ''),
      );
    }
  } else {
    console.log(
      `[debug-scrape] FAILED in ${seconds}s: ${result.errorType ?? 'UNKNOWN'} ${result.errorMessage ?? ''}`,
    );
  }
}

main()
  .catch((error) => {
    console.error('[debug-scrape] crashed:', error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
