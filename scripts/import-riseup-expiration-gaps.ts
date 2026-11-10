/**
 * Safety class: WRITES DB (inserts rows only with --apply; dry run by default).
 *
 * Import the confirmed RiseUp expiration-gap rows.
 *
 * Dry-run is the default. PostgreSQL writes require --apply and are wrapped in
 * one transaction. This importer never runs categorization rules: imported
 * rows remain UNASSIGNED and existing categories are untouched.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { money } from '../src/lib/services/money';
import {
  deterministicId,
  mapRows,
  selectEligibleRows,
  summarize,
  type ProviderReport,
  type RiseUpSnapshot,
  type ComparisonReport,
} from '../src/lib/services/riseupExpirationGapImporter';

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function requiredArg(name: string): string {
  const value = arg(name);
  if (!value) throw new Error(`Usage requires --${name}=PATH`);
  return value;
}

async function main(): Promise<void> {
  const inputPath = requiredArg('input');
  const comparisonPath = requiredArg('comparison');
  const reportPaths = (arg('report') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (reportPaths.length !== 2) throw new Error('Pass --report=cal-provider-check.json,discount-provider-check.json.');
  const outputPath = arg('output');
  const apply = process.argv.includes('--apply');
  const snapshot = JSON.parse(await readFile(inputPath, 'utf8')) as RiseUpSnapshot;
  const reports = await Promise.all(reportPaths.map(async (path) => JSON.parse(await readFile(path, 'utf8')) as ProviderReport));
  const comparison = JSON.parse(await readFile(comparisonPath, 'utf8')) as ComparisonReport;
  const calReport = reports.find((report) => report.input && typeof report.input === 'object' && 'unmatchedVisaCal' in (report.input as object)) ?? reports[0];
  const discountReport = reports.find((report) => report.input && typeof report.input === 'object' && 'unmatchedCount' in (report.input as object)) ?? reports[1];
  if (!calReport || !discountReport) throw new Error('Could not identify Cal and Discount reports.');

  const selected = selectEligibleRows(snapshot, calReport, discountReport, comparison);
  const accounts = await prisma.account.findMany({
    where: { provider: { in: ['visaCal', 'discount'] } },
    select: { id: true, provider: true },
    orderBy: { id: 'asc' },
  });
  const accountIds = {
    visaCal: accounts.filter((account) => account.provider === 'visaCal'),
    discount: accounts.filter((account) => account.provider === 'discount'),
  };
  if (accountIds.visaCal.length !== 1 || accountIds.discount.length !== 1) {
    throw new Error(`Expected exactly one visaCal and one discount account; found ${accountIds.visaCal.length}/${accountIds.discount.length}.`);
  }
  const rows = mapRows(selected, { visaCal: accountIds.visaCal[0]!.id, discount: accountIds.discount[0]!.id });
  const existing = await prisma.transaction.findMany({
    where: { accountId: { in: accounts.map((account) => account.id) }, txnIdentifier: { in: rows.map((row) => row.txnIdentifier) } },
    select: { accountId: true, txnIdentifier: true },
  });
  const existingIds = new Set(existing.filter((row) => row.txnIdentifier).map((row) => `${row.accountId}|${row.txnIdentifier}`));
  const summary = summarize(rows, existingIds);
  const report = { mode: apply ? 'apply' : 'dry-run', input: inputPath, reports: reportPaths, summary, rows: rows.map((row) => ({ provider: row.provider, sourceId: row.sourceId, accountId: row.accountId, id: deterministicId(row), date: row.date.toISOString().slice(0, 10), chargedAmount: row.chargedAmount, description: row.description, flowMonth: row.flowMonth })) };
  if (outputPath) await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });

  if (apply && summary.toInsert > 0) {
    await prisma.$transaction(async (tx) => {
      for (const row of rows) {
        const id = deterministicId(row);
        await tx.transaction.upsert({
          where: { id },
          update: {},
          create: {
            id,
            accountId: row.accountId,
            txnIdentifier: row.txnIdentifier,
            date: row.date,
            processedDate: row.processedDate,
            chargedAmount: money(row.chargedAmount),
            chargedCurrency: 'ILS',
            originalAmount: null,
            originalCurrency: 'ILS',
            description: row.description,
            memo: `RiseUp expiration-gap import (${row.provider})`,
            rawCategory: row.rawCategory,
            categoryId: null,
            categorizationSource: 'UNASSIGNED',
            isTransfer: false,
            transferPairId: null,
            isCardSettlement: false,
            settlesAccountId: null,
            flowMonth: row.flowMonth,
          },
        });
      }
    });
  }
  console.log(JSON.stringify({ mode: report.mode, summary, output: outputPath ?? null }, null, 2));
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }).finally(() => prisma.$disconnect());
