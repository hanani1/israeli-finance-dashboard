/**
 * Safety class: WRITES DB (categoryId of matched rows, creates categories; DRY_RUN=1 for a report only).
 *
 * Import RiseUp CSV categorization into the finance-dashboard DB.
 *
 * - Parses the CSV at CSV_PATH (required; UTF-8 + BOM, Hebrew headers)
 * - Matches rows to Transaction records with the shared tiered one-to-one
 *   matcher (src/lib/services/riseupMatcher.ts): amount + date (payment/charge)
 *   + description, exact first, then fuzzy, never ambiguously.
 * - Sets Transaction.categoryId to the CSV's קטגוריה בתזרים, creating categories as needed.
 * - Writes ./csv-import-report.json (override with REPORT_PATH)
 */
import { PrismaClient, CategoryType, CategoryGroup } from '@prisma/client';
import * as fs from 'fs';
import type { MoneyInput } from '../src/lib/services/money';
import { canonicalCategoryName } from '../src/lib/services/categoryMerge';
import { localCalendarDay } from '../src/lib/services/localDay';
import { matchRiseUpRows, parseCsv, parseDmy, stripBom } from '../src/lib/services/riseupMatcher';

const prisma = new PrismaClient();
const DRY_RUN = process.env.DRY_RUN === '1';
const CSV_PATH = process.env.CSV_PATH ?? '';
if (!CSV_PATH) {
  console.error('Set CSV_PATH to the RiseUp CSV export to read.');
  process.exit(1);
}
const REPORT_PATH = process.env.REPORT_PATH ?? 'csv-import-report.json';

// ---------- types ----------
interface CsvRow {
  idx: number;
  flowMonth: string;
  merchant: string;
  paymentSource: string;
  identifier: string;
  paymentDate: string | null; // YYYY-MM-DD
  chargeDate: string | null;  // YYYY-MM-DD
  amount: number;
  category: string;
  excluded: string;
  notes: string;
  sourceType: string;
  matchedTxnId?: string;
  unmatchedReason?: string;
}
interface Txn {
  id: string;
  date: string;          // local YYYY-MM-DD of Transaction.date
  processedDate: string | null;
  chargedAmount: MoneyInput;
  description: string;
  categoryId: number | null;
}

async function main() {
  const raw = fs.readFileSync(CSV_PATH, 'utf8');
  const allRows = parseCsv(raw);
  const header = (allRows[0] ?? []).map(stripBom);
  const col = (name: string) => {
    const i = header.findIndex((h) => h.trim() === name);
    if (i === -1) throw new Error(`Missing column: ${name}`);
    return i;
  };
  const C = {
    flowMonth: col('שייך לתזרים חודש'),
    merchant: col('שם העסק'),
    paymentSource: col('אמצעי התשלום'),
    identifier: col('אמצעי זיהוי התשלום'),
    paymentDate: col('תאריך התשלום'),
    chargeDate: col('תאריך החיוב בחשבון'),
    amount: col('סכום'),
    category: col('קטגוריה בתזרים'),
    excluded: col('האם מוחרג מהתזרים?'),
    notes: col('הערות'),
    sourceType: col('סוג מקור'),
  };

  const rows: CsvRow[] = [];
  for (let i = 1; i < allRows.length; i++) {
    const r = allRows[i];
    if (!r || r.length < header.length - 1) continue; // skip malformed/empty
    const amount = parseFloat(r[C.amount] ?? '');
    if (Number.isNaN(amount)) continue;
    rows.push({
      idx: i,
      flowMonth: r[C.flowMonth]?.trim() ?? '',
      merchant: r[C.merchant]?.trim() ?? '',
      paymentSource: r[C.paymentSource]?.trim() ?? '',
      identifier: r[C.identifier]?.trim() ?? '',
      paymentDate: parseDmy(r[C.paymentDate] ?? ''),
      chargeDate: parseDmy(r[C.chargeDate] ?? ''),
      amount,
      category: (r[C.category] ?? '').trim(),
      excluded: r[C.excluded]?.trim() ?? '',
      notes: r[C.notes]?.trim() ?? '',
      sourceType: r[C.sourceType]?.trim() ?? '',
    });
  }
  console.log(`Parsed ${rows.length} CSV data rows`);

  // ---------- load DB ----------
  const dbTxns = await prisma.transaction.findMany({
    select: {
      id: true, date: true, processedDate: true, chargedAmount: true,
      description: true, categoryId: true,
    },
  });
  const txns: Txn[] = dbTxns.map((t) => ({
    id: t.id,
    date: localCalendarDay(t.date),
    processedDate: t.processedDate ? localCalendarDay(t.processedDate) : null,
    chargedAmount: t.chargedAmount,
    description: t.description,
    categoryId: t.categoryId,
  }));
  console.log(`Loaded ${txns.length} DB transactions`);

  // ---------- tiered one-to-one matching (shared matcher) ----------
  const result = matchRiseUpRows(
    rows.map((r) => ({ key: r.idx, amount: r.amount, paymentDate: r.paymentDate, chargeDate: r.chargeDate, description: r.merchant, source: r })),
    txns.map((t) => ({ ...t, amount: t.chargedAmount })),
  );
  for (const m of result.matches) m.row.source.matchedTxnId = m.txn.id;
  for (const u of result.unmatched) u.row.source.unmatchedReason = u.reason;

  const matched = rows.filter((r) => r.matchedTxnId);
  const unmatched = rows.filter((r) => !r.matchedTxnId);
  console.log(`Matched: ${matched.length}, Unmatched: ${unmatched.length}`);

  // ---------- category resolution ----------
  const cats = await prisma.category.findMany();
  const usage = await prisma.transaction.groupBy({ by: ['categoryId'], _count: { _all: true } });
  const usageMap = new Map<number, number>(
    usage.filter((u) => u.categoryId !== null).map((u) => [u.categoryId as number, u._count._all]),
  );

  const categoriesCreated: { id: number; name: string; type: string; group: string }[] = [];
  const NEW_COLORS = ['#f59e0b', '#06b6d4', '#8b5cf6', '#ef4444', '#84cc16', '#f43f5e',
    '#3b82f6', '#10b981', '#a16207', '#7c2d12', '#155e75', '#4c1d95'];
  let colorIdx = 0;

  // name -> list of categories (may exist in multiple groups)
  const catByName = new Map<string, typeof cats>();
  for (const c of cats) {
    if (!catByName.has(c.name)) catByName.set(c.name, []);
    catByName.get(c.name)!.push(c);
  }

  async function resolveCategory(rawName: string, amount: number): Promise<number> {
    const wantIncome = amount >= 0;
    // Retired (merged) names resolve to their target — never recreate them.
    const name = canonicalCategoryName(rawName, wantIncome ? 'INCOME' : 'EXPENSE');
    const list = catByName.get(name) ?? [];
    if (list.length > 0) {
      // prefer type matching the transaction sign
      const signMatched = list.filter((c) =>
        wantIncome ? c.type === 'INCOME' : c.type === 'EXPENSE');
      const pick = (signMatched.length > 0 ? signMatched : list)
        .slice()
        .sort((a, b) => (usageMap.get(b.id) ?? 0) - (usageMap.get(a.id) ?? 0) || a.id - b.id)[0];
      if (pick) return pick.id;
    }
    // create new category
    const isIncome = name.includes('הכנס') || name.includes('הכנסה');
    const type: CategoryType = isIncome ? 'INCOME' : 'EXPENSE';
    const recurringNames = new Set(['מים']);
    const group: CategoryGroup = isIncome ? 'INCOME'
      : recurringNames.has(name) ? 'RECURRING_EXPENSE' : 'VARIABLE_EXPENSE';
    const created = DRY_RUN
      ? { id: -(categoriesCreated.length + 1), name, type, group, color: '' } as (typeof cats)[number]
      : await prisma.category.create({
          data: { name, type, group, color: NEW_COLORS[colorIdx++ % NEW_COLORS.length] },
        });
    catByName.set(name, [created]);
    categoriesCreated.push({ id: created.id, name, type, group });
    console.log(`Created category #${created.id} "${name}" (${type}/${group})`);
    return created.id;
  }

  // ---------- apply updates ----------
  const txnById = new Map(txns.map((t) => [t.id, t]));
  let matchedUpdated = 0;
  let matchedUnchanged = 0;
  let skippedNoCategory = 0;

  for (const r of matched) {
    if (!r.category) { skippedNoCategory++; continue; }
    const catId = await resolveCategory(r.category, r.amount);
    const t = txnById.get(r.matchedTxnId!)!;
    if (t.categoryId === catId) {
      matchedUnchanged++;
    } else {
      if (!DRY_RUN) {
        await prisma.transaction.update({
          where: { id: t.id },
          data: { categoryId: catId, categorizationSource: 'MANUAL' },
        });
      }
      matchedUpdated++;
    }
  }

  // ---------- report ----------
  const report = {
    generatedAt: new Date().toISOString(),
    csv_path: CSV_PATH,
    total_csv_rows: rows.length,
    total_db_transactions: txns.length,
    matched_total: matched.length,
    matched_updated: matchedUpdated,
    matched_unchanged: matchedUnchanged,
    matched_skipped_empty_category: skippedNoCategory,
    categories_created: categoriesCreated,
    matched: matched.map((r) => ({
      txn_id: r.matchedTxnId,
      merchant: r.merchant,
      payment_date: r.paymentDate,
      amount: r.amount,
      category: r.category,
    })),
    unmatched_count: unmatched.length,
    unmatched: unmatched.map((r) => ({
      flow_month: r.flowMonth,
      merchant: r.merchant,
      payment_source: r.paymentSource,
      identifier: r.identifier,
      payment_date: r.paymentDate,
      amount: r.amount,
      category: r.category,
      source_type: r.sourceType,
      reason_unmatched: r.unmatchedReason ?? 'unknown',
    })),
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nReport written to ${REPORT_PATH}`);
  console.log(JSON.stringify({
    total_csv_rows: rows.length,
    matched_updated: matchedUpdated,
    matched_unchanged: matchedUnchanged,
    matched_skipped_empty_category: skippedNoCategory,
    unmatched: unmatched.length,
    categories_created: categoriesCreated.map((c) => c.name),
  }, null, 2));
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
