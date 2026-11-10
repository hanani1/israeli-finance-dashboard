/**
 * Budget pacing math — pure, deterministic, and free of DB access/Date so it can
 * be unit-tested in isolation. Given a monthly budget, the amount spent so far,
 * and how far through the month we are, it reports whether spending is on/under/
 * over the expected linear pace and projects the end-of-month total.
 */
import { Prisma } from '@prisma/client';
import { flowMonthEnd, flowMonthStart } from './flowMonth';
import { localCalendarDay } from './localDay';
import {
  ZERO_MONEY,
  divideMoney,
  money,
  moneyToNumber,
  ratioToNumber,
  type Decimal,
  type MoneyInput,
} from './money';

export type Pace = 'under' | 'on' | 'over';

export interface PacingInput {
  /** Monthly budget limit (positive ILS). */
  amount: MoneyInput;
  /** Positive amount spent so far in the period. */
  spent: MoneyInput;
  /** Days elapsed in the month, inclusive of today (1..daysInMonth). */
  daysElapsed: number;
  /** Total days in the month. */
  daysInMonth: number;
}

/** Response DTO: money fields are JSON numbers, exact to the agorot. */
export interface Pacing {
  amount: number;
  spent: number;
  /** amount - spent (may be negative when over budget). */
  remaining: number;
  /** Fraction of the month elapsed, 0..1. */
  elapsedFraction: number;
  /** Budget share that "should" have been spent by now. */
  expectedByNow: number;
  /** Linear end-of-month projection from the current run rate. */
  projected: number;
  /** spent / expectedByNow — 1.0 means exactly on pace. */
  paceRatio: number;
  pace: Pace;
  /** True once cumulative spend exceeds the whole monthly budget. */
  overBudget: boolean;
}

/** Spending within this band of the expected pace still counts as "on" pace. */
const ON_PACE_TOLERANCE = 0.05;

/** Ratios (not money) are reported with 4 decimals. */
function ratio4(value: Decimal): number {
  return ratioToNumber(value, 4);
}

export function computePacing(input: PacingInput): Pacing {
  // Money math is exact Decimal (card #53); only ratios are plain numbers.
  const amount = Prisma.Decimal.max(ZERO_MONEY, money(input.amount));
  const spent = Prisma.Decimal.max(ZERO_MONEY, money(input.spent));
  const daysInMonth = Math.max(1, input.daysInMonth);
  const daysElapsed = Math.min(Math.max(1, input.daysElapsed), daysInMonth);
  const elapsed = new Prisma.Decimal(daysElapsed).div(daysInMonth);

  const expectedByNow = divideMoney(amount.mul(daysElapsed), daysInMonth);
  const projected = divideMoney(spent.mul(daysInMonth), daysElapsed);
  const remaining = amount.sub(spent);

  let paceRatio: Decimal | null; // null = infinite (spend against a zero expectation)
  if (expectedByNow.gt(0)) {
    paceRatio = spent.div(expectedByNow);
  } else {
    paceRatio = spent.gt(0) ? null : ZERO_MONEY;
  }

  let pace: Pace;
  if (amount.isZero()) {
    pace = spent.gt(0) ? 'over' : 'on';
  } else if (paceRatio === null || paceRatio.gt(1 + ON_PACE_TOLERANCE)) {
    pace = 'over';
  } else if (paceRatio.lt(1 - ON_PACE_TOLERANCE)) {
    pace = 'under';
  } else {
    pace = 'on';
  }

  return {
    amount: moneyToNumber(amount),
    spent: moneyToNumber(spent),
    remaining: moneyToNumber(remaining),
    elapsedFraction: ratio4(elapsed),
    expectedByNow: moneyToNumber(expectedByNow),
    projected: moneyToNumber(projected),
    paceRatio: paceRatio === null ? Infinity : ratio4(paceRatio),
    pace,
    overBudget: spent.gt(amount),
  };
}

/**
 * Resolve the UTC window and elapsed-day counts for a given month.
 * `month` is `yyyy-MM`; when omitted the reference date's month is used.
 * daysElapsed clamps to the full month for past months and to 1 for future ones.
 */
export function resolveMonthWindow(
  month: string | undefined,
  now: Date,
): { start: Date; end: Date; daysInMonth: number; daysElapsed: number; label: string } {
  let year: number;
  let monthIndex: number; // 0-based
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [yStr = '', mStr = ''] = month.split('-');
    year = Number(yStr);
    monthIndex = Number(mStr) - 1;
  } else {
    year = now.getUTCFullYear();
    monthIndex = now.getUTCMonth();
  }

  const label = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
  // Query bounds on Israeli day boundaries: scraped rows are stored as
  // Israel-local midnight instants (see localDay.ts).
  const start = flowMonthStart(label);
  const end = flowMonthEnd(label); // exclusive
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

  let daysElapsed: number;
  if (now >= end) {
    daysElapsed = daysInMonth;
  } else if (now < start) {
    daysElapsed = 1;
  } else {
    daysElapsed = Number(localCalendarDay(now).slice(8, 10));
  }

  return { start, end, daysInMonth, daysElapsed, label };
}
