/**
 * Safety class: WRITES DB (Transaction.flowMonth only; DRY_RUN=1 for a report only).
 *
 * Backfill Transaction.flowMonth from the RiseUp CSV export.
 *
 * - Parses the RiseUp export (path from CSV_PATH,
 *   required). UTF-8 + BOM, Hebrew headers.
 * - Matches rows to Transaction records with the shared strictly one-to-one
 *   tiered matcher (src/lib/services/riseupMatcher.ts, also used by the
 *   category import): amount + date + description; exact first, then
 *   fuzzy/prefix/word-subset.
 * - Sets ONLY Transaction.flowMonth to the CSV's "שייך לתזרים חודש" — never
 *   touches categories or any other column.
 * - Safety guard: a flow month more than 2 months away from the row's
 *   calendar month is treated as a mismatch and skipped (reported).
 * - DB rows not present in the CSV keep flowMonth NULL, which the app treats
 *   as "calendar month of the transaction date".
 * - DRY_RUN=1 reports without writing.
 * - Writes ./flow-month-backfill-report.json (override with REPORT_PATH)
 */
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import type { MoneyInput } from '../src/lib/services/money';
import { localCalendarDay } from '../src/lib/services/localDay';
import { matchRiseUpRows, parseCsv, parseDmy, stripBom } from '../src/lib/services/riseupMatcher';

const prisma = new PrismaClient();
const DRY_RUN = process.env.DRY_RUN === '1';
const CSV_PATH = process.env.CSV_PATH ?? '';
if (!CSV_PATH) {
  console.error('Set CSV_PATH to the RiseUp CSV export to read.');
  process.exit(1);
}
const REPORT_PATH = process.env.REPORT_PATH ?? 'flow-month-backfill-report.json';
const FLOW_MONTH_RE = /^\d{4}-\d{2}$/;
/** Max |flowMonth - calendar month| in months before we refuse to store it. */
const MAX_MONTH_DRIFT = 2;

/** Whole months between two yyyy-MM labels (b - a). */
function monthDiff(a: string, b: string): number {
  const [ay = 0, am = 0] = a.split('-').map(Number);
  const [by = 0, bm = 0] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
}

// ---------- types ----------
interface CsvRow {
  idx: number;
  flowMonth: string;
  merchant: string;
  paymentDate: string | null; // YYYY-MM-DD
  chargeDate: string | null; // YYYY-MM-DD
  amount: number;
  matchedTxnId?: string;
  unmatchedReason?: string;
}
interface Txn {
  id: string;
  date: string; // local YYYY-MM-DD of Transaction.date
  calendarMonth: string; // UTC yyyy-MM of Transaction.date (app fallback semantics)
  processedDate: string | null;
  chargedAmount: MoneyInput;
  description: string;
  flowMonth: string | null;
  matched?: boolean;
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
    paymentDate: col('תאריך התשלום'),
    chargeDate: col('תאריך החיוב בחשבון'),
    amount: col('סכום'),
  };

  const rows: CsvRow[] = [];
  for (let i = 1; i < allRows.length; i++) {
    const r = allRows[i];
    if (!r || r.length < header.length - 1) continue;
    const amount = parseFloat(r[C.amount] ?? '');
    if (Number.isNaN(amount)) continue;
    const flowMonth = r[C.flowMonth]?.trim() ?? '';
    rows.push({
      idx: i,
      flowMonth,
      merchant: r[C.merchant]?.trim() ?? '',
      paymentDate: parseDmy(r[C.paymentDate] ?? ''),
      chargeDate: parseDmy(r[C.chargeDate] ?? ''),
      amount,
    });
  }
  console.log(`Parsed ${rows.length} CSV data rows from ${CSV_PATH}`);

  // ---------- load DB ----------
  const dbTxns = await prisma.transaction.findMany({
    select: {
      id: true, date: true, processedDate: true, chargedAmount: true,
      description: true, flowMonth: true,
    },
  });
  const txns: Txn[] = dbTxns.map((t) => ({
    id: t.id,
    date: localCalendarDay(t.date),
    calendarMonth: localCalendarDay(t.date).slice(0, 7), // Israeli month, like calendarFlowMonth
    processedDate: t.processedDate ? localCalendarDay(t.processedDate) : null,
    chargedAmount: t.chargedAmount,
    description: t.description,
    flowMonth: t.flowMonth,
  }));
  console.log(`Loaded ${txns.length} DB transactions`);

  // ---------- tiered one-to-one matching (shared matcher, same as the category import) ----------
  const result = matchRiseUpRows(
    rows.map((r) => ({ key: r.idx, amount: r.amount, paymentDate: r.paymentDate, chargeDate: r.chargeDate, description: r.merchant, source: r })),
    txns.map((t) => ({ ...t, amount: t.chargedAmount, source: t })),
  );
  for (const m of result.matches) {
    m.row.source.matchedTxnId = m.txn.id;
    m.txn.source.matched = true;
  }
  for (const u of result.unmatched) u.row.source.unmatchedReason = u.reason;

  const matched = rows.filter((r) => r.matchedTxnId);
  const unmatched = rows.filter((r) => !r.matchedTxnId);
  console.log(`Matched: ${matched.length}, Unmatched CSV rows: ${unmatched.length}`);

  // ---------- apply flowMonth (only) ----------
  const txnById = new Map(txns.map((t) => [t.id, t]));
  let updated = 0;
  let unchanged = 0;
  let sameAsCalendar = 0;
  const skippedInvalid: CsvRow[] = [];
  const skippedDrift: { txnId: string; flowMonth: string; calendarMonth: string }[] = [];

  for (const r of matched) {
    const t = txnById.get(r.matchedTxnId!)!;
    if (!FLOW_MONTH_RE.test(r.flowMonth)) {
      skippedInvalid.push(r);
      continue;
    }
    const drift = Math.abs(monthDiff(t.calendarMonth, r.flowMonth));
    if (drift > MAX_MONTH_DRIFT) {
      skippedDrift.push({ txnId: t.id, flowMonth: r.flowMonth, calendarMonth: t.calendarMonth });
      continue;
    }
    if (r.flowMonth === t.calendarMonth) sameAsCalendar += 1;
    if (t.flowMonth === r.flowMonth) {
      unchanged += 1;
      continue;
    }
    if (!DRY_RUN) {
      await prisma.transaction.update({
        where: { id: t.id },
        data: { flowMonth: r.flowMonth },
      });
    }
    updated += 1;
  }

  const dbUnmatchedCount = txns.filter((t) => !t.matched).length;

  const report = {
    generatedAt: new Date().toISOString(),
    dry_run: DRY_RUN,
    csv_path: CSV_PATH,
    total_csv_rows: rows.length,
    total_db_transactions: txns.length,
    matched_total: matched.length,
    flow_month_updated: updated,
    flow_month_unchanged: unchanged,
    flow_month_equal_to_calendar_month: sameAsCalendar,
    skipped_invalid_flow_month: skippedInvalid.length,
    skipped_month_drift_gt2: skippedDrift,
    csv_unmatched_count: unmatched.length,
    db_rows_without_flow_month: dbUnmatchedCount,
    note: 'DB rows not matched keep flowMonth NULL — the app falls back to the calendar month of the transaction date.',
    csv_unmatched_sample: unmatched.slice(0, 50).map((r) => ({
      flow_month: r.flowMonth,
      merchant: r.merchant,
      payment_date: r.paymentDate,
      amount: r.amount,
      reason: r.unmatchedReason ?? 'no DB transaction with matching amount+date+description',
    })),
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
  console.log(`Report written to ${REPORT_PATH}`);
  console.log(JSON.stringify({
    dry_run: DRY_RUN,
    matched: matched.length,
    flow_month_updated: updated,
    flow_month_unchanged: unchanged,
    skipped_invalid_flow_month: skippedInvalid.length,
    skipped_month_drift_gt2: skippedDrift.length,
    csv_unmatched: unmatched.length,
  }, null, 2));
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
