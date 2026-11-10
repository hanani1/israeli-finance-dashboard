/**
 * Safety class: TOUCHES PROVIDER, SENSITIVE (one real scrape with the stored credential; lockout risk; READ-ONLY database).
 *
 * One bounded, read-only Isracard completeness probe.
 *
 * Runs the real Isracard scraper exactly once (host Chrome + persistent
 * profile, the path ingestion uses) and keeps the provider's raw
 * DashboardMonth / CardsTransactionsList responses in memory. For every raw
 * row it reports whether the library's parser dropped it (and why), whether
 * it reached the scraper result, and whether it exists in the database.
 * Nothing is written to the database. Output is redacted: card numbers are
 * shown as their last four digits and no credential, cookie or token value
 * is captured.
 *
 * Usage:
 *   npx tsx scripts/diagnostics/isracard-completeness-probe.ts [--days 14] [--match "<merchant>,<merchant>"]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createScraper, CompanyTypes } from 'israeli-bank-scrapers';
import type { ScraperCredentials } from 'israeli-bank-scrapers';
import type { Page, HTTPResponse } from 'puppeteer';
import { decryptSecret } from '../../src/lib/security/crypto';
import { launchIsracardBrowser, resolveIsracardBrowserLaunch } from '../../src/lib/services/isracardBrowser';
import { isracardRawDropReason, type IsracardRawTxn } from '../../src/lib/services/isracardCompleteness';

try {
  process.loadEnvFile('.env');
} catch {
  // rely on environment / Keychain
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type RawResponse = { reqName: string; params: Record<string, string>; status: number; body: unknown };

const last4 = (value: unknown) => (value == null ? null : `…${String(value).slice(-4)}`);

async function main(): Promise<void> {
  const days = Number(argValue('--days') ?? 14);
  const needles = (argValue('--match') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  const prisma = new PrismaClient();
  const rows = await prisma.$queryRaw<Array<{ encryptedData: string; iv: string; authTag: string }>>`
    SELECT "encryptedData", "iv", "authTag" FROM "BankCredential" WHERE provider = 'isracard' LIMIT 1`;
  const row = rows[0];
  if (!row) throw new Error('No isracard credential stored.');
  const fields = JSON.parse(decryptSecret({ ciphertext: row.encryptedData, iv: row.iv, tag: row.authTag })) as Record<string, string>;

  const launch = resolveIsracardBrowserLaunch(process.env, process.platform);
  if (!launch) throw new Error('Probe requires host Chrome (ISRACARD_EXECUTABLE_PATH or macOS Chrome).');
  const browser = await launchIsracardBrowser(launch);

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const responses: RawResponse[] = [];

  const scraper = createScraper({
    companyId: CompanyTypes.isracard,
    startDate,
    combineInstallments: false,
    verbose: false,
    timeout: 120_000,
    defaultTimeout: 120_000,
    browser,
    preparePage: async (page: Page) => {
      page.on('response', async (response: HTTPResponse) => {
        const url = new URL(response.url());
        const reqName = url.searchParams.get('reqName') ?? '';
        if (!/ProxyRequestHandler/i.test(url.pathname)) return;
        if (!['DashboardMonth', 'CardsTransactionsList'].includes(reqName)) return;
        const params = Object.fromEntries([...url.searchParams].filter(([k]) => k !== 'reqName'));
        try {
          responses.push({ reqName, params, status: response.status(), body: await response.json() });
        } catch {
          responses.push({ reqName, params, status: response.status(), body: null });
        }
      });
    },
  });

  console.log(`[probe] one bounded Isracard scrape, startDate=${startDate.toISOString().slice(0, 10)}`);
  let result;
  try {
    result = await scraper.scrape(fields as unknown as ScraperCredentials);
  } finally {
    await browser.close().catch(() => undefined);
  }

  // Index → card suffix, from the DashboardMonth responses.
  const cardByIndex = new Map<string, string>();
  for (const r of responses.filter((x) => x.reqName === 'DashboardMonth')) {
    const charges = (r.body as { DashboardMonthBean?: { cardsCharges?: Array<{ cardIndex: string; cardNumber: string }> } })
      ?.DashboardMonthBean?.cardsCharges ?? [];
    for (const c of charges) cardByIndex.set(String(c.cardIndex), String(c.cardNumber).slice(-4));
  }

  const scraped = new Set<string>();
  for (const a of result.accounts ?? []) {
    for (const t of a.txns) scraped.add(`${a.accountNumber.slice(-4)}|${t.identifier}|${t.description}`);
  }

  const dbAccounts = await prisma.account.findMany({ where: { provider: 'isracard' }, select: { id: true, accountNumber: true } });
  const accountIdBySuffix = new Map(dbAccounts.map((a) => [a.accountNumber.slice(-4), a.id]));

  const report: Array<Record<string, unknown>> = [];
  for (const r of responses.filter((x) => x.reqName === 'CardsTransactionsList')) {
    const bean = (r.body as { CardsTransactionsListBean?: Record<string, unknown> })?.CardsTransactionsListBean ?? {};
    for (const [key, value] of Object.entries(bean)) {
      const m = /^Index(\d+)$/.exec(key);
      if (!m) continue;
      const groups = (value as { CurrentCardTransactions?: Array<{ txnIsrael?: IsracardRawTxn[]; txnAbroad?: IsracardRawTxn[] }> })
        ?.CurrentCardTransactions ?? [];
      const index = m[1] ?? '?';
      const suffix = cardByIndex.get(index) ?? `index${index}(not in DashboardMonth)`;
      for (const g of groups) {
        for (const [group, txns] of [['israel', g.txnIsrael ?? []], ['abroad', g.txnAbroad ?? []]] as const) {
          for (const t of txns) {
            const outbound = !!t.dealSumOutbound;
            const description = outbound ? t.fullSupplierNameOutbound : t.fullSupplierNameHeb;
            const voucher = outbound ? t.voucherNumberRatzOutbound : t.voucherNumberRatz;
            const identifier = voucher != null ? parseInt(String(voucher), 10) : null;
            const accountId = accountIdBySuffix.get(suffix);
            const inDb = accountId && description
              ? await prisma.transaction.count({ where: { accountId, description: String(description) } })
              : 0;
            report.push({
              month: `${r.params.year}-${r.params.month}`,
              card: suffix,
              group,
              purchaseDate: outbound ? t.fullPurchaseDateOutbound : t.fullPurchaseDate,
              paymentDate: t.fullPaymentDate ?? null,
              description,
              dealSum: outbound ? t.dealSumOutbound : t.dealSum,
              paymentSum: outbound ? t.paymentSumOutbound : t.paymentSum,
              dealSumType: t.dealSumType ?? null,
              voucher: voucher == null ? null : /^0+$/.test(String(voucher)) ? String(voucher) : last4(voucher),
              moreInfo: t.moreInfo ?? null,
              dropReason: isracardRawDropReason(t),
              inScrapeResult: scraped.has(`${suffix}|${identifier}|${description}`),
              dbRowsWithDescription: inDb,
              rawKeys: Object.keys(t).filter((k) => !/card|id$|token/i.test(k)).sort(),
            });
          }
        }
      }
    }
  }
  await prisma.$disconnect();

  const matched = report.filter((x) => needles.some((n) => String(x.description ?? '').toUpperCase().includes(n.toUpperCase())));
  const summary = {
    success: result.success,
    errorType: result.errorType,
    accounts: result.accounts?.map((a) => ({ card: last4(a.accountNumber), txns: a.txns.length })),
    requests: responses.map((r) => ({ reqName: r.reqName, month: r.params.billingDate ?? `${r.params.year}-${r.params.month}`, status: r.status })),
    cardsByIndex: Object.fromEntries(cardByIndex),
    rawRows: report.length,
    droppedByParser: report.filter((x) => x.dropReason).length,
    matched,
  };

  const outDir = path.resolve('debug-screenshots');
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `isracard-completeness-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(outFile, JSON.stringify({ summary, rows: report }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(summary, null, 2));
  console.log(`[probe] full redacted report -> ${outFile}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
