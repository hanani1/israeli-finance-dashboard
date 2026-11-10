/**
 * Card #53: one effective-flow-month predicate shared by the monthly
 * breakdown, the monthly transaction list and budget pacing. Budgets used to
 * bucket spend by calendar month while the breakdown used the RiseUp flow
 * month, so a Jan-31 purchase assigned to February counted in January's
 * budget but February's breakdown.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Prisma } from '@prisma/client';
import { effectiveFlowMonth, effectiveFlowMonthWhere } from './flowMonth';
import { monthlyBreakdownWhere } from './analyticsService';
import { budgetSpendWhere } from './budgetService';
import { buildTransactionWhere } from './transactionService';

interface Row {
  flowMonth: string | null;
  date: Date;
}

/** Minimal evaluator for the flow-month part of a TransactionWhereInput. */
function matches(where: Prisma.TransactionWhereInput, row: Row): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;
    if (key === 'AND') {
      const parts = (Array.isArray(value) ? value : [value]) as Prisma.TransactionWhereInput[];
      if (!parts.every((p) => matches(p, row))) return false;
    } else if (key === 'OR') {
      if (!(value as Prisma.TransactionWhereInput[]).some((p) => matches(p, row))) return false;
    } else if (key === 'flowMonth') {
      if (value === null) {
        if (row.flowMonth !== null) return false;
      } else if (typeof value === 'string') {
        if (row.flowMonth !== value) return false;
      } else {
        const list = (value as { in: string[] }).in;
        if (row.flowMonth === null || !list.includes(row.flowMonth)) return false;
      }
    } else if (key === 'date') {
      const range = value as { gte?: Date; lt?: Date };
      if (range.gte && row.date < range.gte) return false;
      if (range.lt && row.date >= range.lt) return false;
    }
    // Every other key is not part of the month predicate.
  }
  return true;
}

// Israel-local midnights around month edges (UTC+2 in winter, UTC+3 in summer).
const DATES = [
  new Date('2026-01-30T22:00:00.000Z'), // Jan 31 local
  new Date('2026-01-31T22:00:00.000Z'), // Feb 1 local
  new Date('2026-02-14T22:00:00.000Z'),
  new Date('2026-02-27T22:00:00.000Z'), // Feb 28 local
  new Date('2026-02-28T22:00:00.000Z'), // Mar 1 local
  new Date('2026-07-31T21:00:00.000Z'), // Aug 1 local
  new Date('2026-08-30T21:00:00.000Z'), // Aug 31 local
];
const STORED = [null, '2026-01', '2026-02', '2026-03', '2026-08', '2026-09'];
const ROWS: Row[] = DATES.flatMap((date) => STORED.map((flowMonth) => ({ flowMonth, date })));

test('effectiveFlowMonthWhere matches exactly the rows whose effective flow month is in the labels', () => {
  for (const labels of [['2026-02'], ['2026-08'], ['2026-01', '2026-02', '2026-03']]) {
    const where = effectiveFlowMonthWhere(labels);
    for (const row of ROWS) {
      assert.equal(
        matches(where, row),
        labels.includes(effectiveFlowMonth(row.flowMonth, row.date)),
        `${labels.join(',')} vs ${row.flowMonth ?? 'null'} @ ${row.date.toISOString()}`,
      );
    }
  }
});

test('budget spend, monthly breakdown and the flow-month transaction list share one month predicate', () => {
  const label = '2026-02';
  const budget = budgetSpendWhere({ label, categoryIds: [1, 2] });
  const breakdown = monthlyBreakdownWhere([label], {});
  const list = buildTransactionWhere({ flowMonth: label });
  for (const row of ROWS) {
    const expected = effectiveFlowMonth(row.flowMonth, row.date) === label;
    assert.equal(matches(budget, row), expected, `budget ${row.flowMonth ?? 'null'} @ ${row.date.toISOString()}`);
    assert.equal(matches(breakdown, row), expected, `breakdown ${row.flowMonth ?? 'null'} @ ${row.date.toISOString()}`);
    assert.equal(matches(list, row), expected, `list ${row.flowMonth ?? 'null'} @ ${row.date.toISOString()}`);
  }
});

test('budget spend keeps its non-month filters (negative ILS spend, no transfers/settlements/refunds)', () => {
  const where = budgetSpendWhere({ label: '2026-02', categoryIds: [7], userId: 'u1' });
  assert.deepEqual(where.chargedAmount, { lt: 0 });
  assert.equal(where.isTransfer, false);
  assert.equal(where.isCardSettlement, false);
  assert.equal(where.isRefund, false);
  assert.equal(where.chargedCurrency, 'ILS');
  assert.deepEqual(where.categoryId, { in: [7] });
  assert.deepEqual(where.account, { userId: 'u1' });
  // No calendar-month date window any more — the month lives in the shared predicate.
  assert.equal(where.date, undefined);
});
