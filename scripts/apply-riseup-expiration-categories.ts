/**
 * Safety class: WRITES DB (only with --apply; dry run by default).
 *
 * Apply the reviewed RiseUp category labels to imported expiration-gap rows.
 * Dry-run is the default; --apply is required for database writes.
 */
import { readFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { selectEligibleRows, type ComparisonReport, type ProviderReport, type RiseUpSnapshot } from '../src/lib/services/riseupExpirationGapImporter';
import { findMatchingCategory, riseUpCategoryTarget, type LocalCategory, type RiseUpCategoryTarget } from '../src/lib/services/riseupCategoryMapping';

const prisma = new PrismaClient();
const IMPORT_PREFIX = 'riseup-expiration-gap:';

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function requiredArg(name: string): string {
  const value = arg(name);
  if (!value) throw new Error(`Usage requires --${name}=PATH`);
  return value;
}

type Plan = {
  txnIdentifier: string;
  target: RiseUpCategoryTarget | null;
};

async function main(): Promise<void> {
  const inputPath = requiredArg('input');
  const comparisonPath = requiredArg('comparison');
  const reportPaths = (arg('report') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (reportPaths.length !== 2) throw new Error('Pass --report=cal-provider-check.json,discount-provider-check.json.');
  const apply = process.argv.includes('--apply');

  const snapshot = JSON.parse(await readFile(inputPath, 'utf8')) as RiseUpSnapshot;
  const comparison = JSON.parse(await readFile(comparisonPath, 'utf8')) as ComparisonReport;
  const reports = await Promise.all(reportPaths.map(async (path) => JSON.parse(await readFile(path, 'utf8')) as ProviderReport));
  const calReport = reports.find((report) => report.input && typeof report.input === 'object' && 'unmatchedVisaCal' in (report.input as object)) ?? reports[0];
  const discountReport = reports.find((report) => report.input && typeof report.input === 'object' && 'unmatchedCount' in (report.input as object)) ?? reports[1];
  if (!calReport || !discountReport) throw new Error('Could not identify Cal and Discount reports.');
  const rows = selectEligibleRows(snapshot, calReport, discountReport, comparison);
  const byId = new Map(rows.map((row) => [row.transactionId, row]));

  const imported = await prisma.transaction.findMany({
    where: { rawCategory: { startsWith: IMPORT_PREFIX }, txnIdentifier: { in: rows.map((row) => row.transactionId) } },
    select: { id: true, txnIdentifier: true, categoryId: true, categorizationSource: true },
  });
  if (imported.length !== rows.length) throw new Error(`Expected ${rows.length} imported rows; found ${imported.length}.`);

  const categories = await prisma.category.findMany({ select: { id: true, name: true, type: true, group: true } }) as LocalCategory[];
  const plans: Plan[] = imported.map((transaction) => {
    const sourceId = transaction.txnIdentifier;
    if (!sourceId) throw new Error(`Imported transaction ${transaction.id} lacks txnIdentifier.`);
    const source = byId.get(sourceId);
    if (!source) throw new Error(`Imported transaction ${sourceId} is absent from the reviewed source set.`);
    return { txnIdentifier: sourceId, target: riseUpCategoryTarget(source.categoryLabel, source.isIncome) };
  });
  const targetCounts = new Map<string, number>();
  const missingTargets = new Map<string, RiseUpCategoryTarget>();
  for (const plan of plans) {
    if (!plan.target) continue;
    const key = `${plan.target.type}|${plan.target.group}|${plan.target.name}`;
    targetCounts.set(key, (targetCounts.get(key) ?? 0) + 1);
    if (!findMatchingCategory(categories, plan.target)) missingTargets.set(key, plan.target);
  }

  const eligibleForUpdate = imported.filter((transaction) =>
    transaction.categoryId === null && transaction.categorizationSource === 'UNASSIGNED',
  );
  const summary = {
    mode: apply ? 'apply' : 'dry-run',
    importedRows: imported.length,
    eligibleForUpdate: eligibleForUpdate.length,
    assigned: plans.filter((plan) => plan.target !== null).length,
    leftUnassigned: plans.filter((plan) => plan.target === null).length,
    newCategories: missingTargets.size,
    labels: Object.fromEntries([...targetCounts.entries()].sort()),
  };

  if (apply) {
    await prisma.$transaction(async (tx) => {
      const categoryIds = new Map<string, number>();
      const existingCategories = await tx.category.findMany({ select: { id: true, name: true, type: true, group: true } }) as LocalCategory[];
      for (const target of missingTargets.values()) {
        const created = await tx.category.create({ data: target, select: { id: true } });
        categoryIds.set(`${target.type}|${target.group}|${target.name}`, created.id);
      }
      for (const transaction of imported) {
        if (transaction.categoryId !== null || transaction.categorizationSource !== 'UNASSIGNED') continue;
        const plan = plans.find((candidate) => candidate.txnIdentifier === transaction.txnIdentifier);
        if (!plan?.target) continue;
        const key = `${plan.target.type}|${plan.target.group}|${plan.target.name}`;
        const existing = findMatchingCategory(existingCategories, plan.target);
        const categoryId = existing?.id ?? categoryIds.get(key);
        if (!categoryId) throw new Error(`Could not resolve category ${key}.`);
        await tx.transaction.update({ where: { id: transaction.id }, data: { categoryId, categorizationSource: 'RULE' } });
      }
    });
  }

  console.log(JSON.stringify(summary, null, 2));
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }).finally(() => prisma.$disconnect());
