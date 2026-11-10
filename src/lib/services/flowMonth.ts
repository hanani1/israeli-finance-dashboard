/**
 * Flow-month helpers (pure, unit-tested; Prisma is a type-only import).
 *
 * A transaction's *effective flow month* follows RiseUp semantics: the stored
 * `flowMonth` (yyyy-MM, backfilled from the RiseUp export) when present,
 * otherwise the Israeli calendar month of the provider's day (see
 * localDay.ts — scraped dates are Israel-local midnight instants, so UTC
 * month boundaries pushed every 1st-of-month row into the previous month).
 * A rent check dated Jan 31 that RiseUp assigns to February therefore counts
 * in February, while rows RiseUp never saw keep their calendar month.
 */
import type { Prisma } from '@prisma/client';
import { localCalendarMonth, localDayStart } from './localDay';

export const FLOW_MONTH_PATTERN = /^\d{4}-\d{2}$/;

/** Number of months the trailing average covers — the divisor is ALWAYS 6. */
export const AVG6_MONTH_COUNT = 6;

/** Israeli calendar yyyy-MM of a date — the fallback flow month. */
export function calendarFlowMonth(date: Date): string {
  return localCalendarMonth(date);
}

/** Effective flow month: stored flowMonth if valid, else calendar month. */
export function effectiveFlowMonth(flowMonth: string | null | undefined, date: Date): string {
  if (flowMonth && FLOW_MONTH_PATTERN.test(flowMonth)) return flowMonth;
  return calendarFlowMonth(date);
}

/** Israel midnight starting the first day of a yyyy-MM label, as a UTC instant. */
export function flowMonthStart(label: string): Date {
  return localDayStart(`${label}-01`);
}

/** Exclusive end: Israel midnight starting the month after a yyyy-MM label. */
export function flowMonthEnd(label: string): Date {
  const [y = 0, m = 1] = label.split('-').map(Number);
  const next = new Date(Date.UTC(y, m, 1));
  return localDayStart(next.toISOString().slice(0, 10));
}

/**
 * Exactly the six flow months preceding `label`, oldest first.
 * E.g. '2026-08' -> ['2026-02', ..., '2026-07'].
 */
export function previousSixFlowMonths(label: string): string[] {
  const [y = 0, m = 1] = label.split('-').map(Number);
  const labels: string[] = [];
  for (let i = AVG6_MONTH_COUNT; i >= 1; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    labels.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return labels;
}

/**
 * Effective flow-month predicate for one or more yyyy-MM labels: a row belongs
 * to a flow month when its stored `flowMonth` matches, or — for rows without a
 * stored flow month (not present in the RiseUp export) — when its calendar
 * date falls inside the labels' contiguous Israeli calendar window. Labels
 * MUST be contiguous months, oldest first.
 *
 * The single month predicate for every month-scoped query: the monthly
 * breakdown and its 6-month average, the monthly transaction list and budget
 * pacing (card #53). Callers put it inside `AND` so their own `OR` clauses
 * cannot clobber it.
 */
export function effectiveFlowMonthWhere(labels: readonly string[]): Prisma.TransactionWhereInput {
  const first = labels[0];
  const last = labels[labels.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error('effectiveFlowMonthWhere needs at least one month label');
  }
  return {
    OR: [
      { flowMonth: labels.length === 1 ? first : { in: [...labels] } },
      { flowMonth: null, date: { gte: flowMonthStart(first), lt: flowMonthEnd(last) } },
    ],
  };
}
