/**
 * Investment analysis — pure logic (no DB access), mirroring the
 * transferDetection.ts pattern so it is unit-testable.
 *
 * Sign convention (same as everywhere else): negative chargedAmount is money
 * leaving the bank account (a DEPOSIT into an investment), positive is money
 * coming back (a WITHDRAWAL from an investment). "Total invested" is the
 * cumulative net: deposits − withdrawals across all time.
 */
import { agorotToNumber, toAgorot, type MoneyInput } from './money';

export interface InvestmentTxn {
  date: Date;
  chargedAmount: MoneyInput;
  description: string;
  memo: string | null;
}

/**
 * Known Israeli investment houses, checked against description + memo.
 * Ordered: more specific patterns first (מיטב דש before the מיטב fallback via
 * מיטב טרייד). Patterns are ones verified against real data plus the standard
 * house names; matching is substring, case-insensitive.
 */
const HOUSE_PATTERNS: ReadonlyArray<{ pattern: string; house: string }> = [
  { pattern: 'אלטשולר', house: 'אלטשולר שחם' },
  { pattern: 'מיטב דש', house: 'מיטב דש' },
  { pattern: 'מיטב טרייד', house: 'מיטב טרייד' },
  { pattern: 'פסגות', house: 'פסגות' },
  { pattern: 'ילין לפידות', house: 'ילין לפידות' },
  { pattern: 'אקסלנס', house: 'אקסלנס' },
  { pattern: 'מור השקעות', house: 'מור השקעות' },
  { pattern: 'ibi', house: 'IBI' },
  { pattern: 'אינטראקטיב', house: 'אינטראקטיב' },
  { pattern: 'מגדל שוקי הון', house: 'מגדל שוקי הון' },
  // Direct securities trading on the bank account (קנית ני"ע / מכירת ני"ע).
  { pattern: 'ני"ע', house: 'תיק ני"ע (בנק)' },
  { pattern: 'ני ע', house: 'תיק ני"ע (בנק)' },
];

export const OTHER_HOUSE = 'אחר';

/** Resolve the investment house for a transaction from its description + memo. */
export function investmentHouseFor(description: string, memo: string | null): string {
  const haystack = `${description} ${memo ?? ''}`.toLowerCase();
  for (const { pattern, house } of HOUSE_PATTERNS) {
    if (haystack.includes(pattern.toLowerCase())) return house;
  }
  return OTHER_HOUSE;
}

export interface HouseSummary {
  house: string;
  deposits: number; // positive: money put in
  withdrawals: number; // positive: money taken out
  net: number; // deposits − withdrawals
  count: number;
}

export interface MonthlyInvestmentActivity {
  month: string; // yyyy-MM
  deposits: number;
  withdrawals: number;
  net: number;
}

export interface InvestmentBreakdown {
  totalDeposits: number;
  totalWithdrawals: number;
  /** Cumulative net invested: deposits − withdrawals (can be negative). */
  totalInvested: number;
  count: number;
  houses: HouseSummary[]; // sorted by net desc
  monthly: MonthlyInvestmentActivity[]; // sorted ascending by month
}

/** Aggregate investment-category transactions by house and by month. */
export function buildInvestmentBreakdown(txns: readonly InvestmentTxn[]): InvestmentBreakdown {
  // Accumulate exact integer agorot; convert to numbers only for the result DTO.
  interface Acc {
    deposits: number;
    withdrawals: number;
  }
  const houses = new Map<string, Acc & { house: string; count: number }>();
  const monthly = new Map<string, Acc & { month: string }>();
  let totalDeposits = 0;
  let totalWithdrawals = 0;

  for (const txn of txns) {
    const agorot = toAgorot(txn.chargedAmount);
    const deposit = agorot < 0 ? -agorot : 0;
    const withdrawal = agorot > 0 ? agorot : 0;
    totalDeposits += deposit;
    totalWithdrawals += withdrawal;

    const houseName = investmentHouseFor(txn.description, txn.memo);
    const house = houses.get(houseName) ?? { house: houseName, deposits: 0, withdrawals: 0, count: 0 };
    house.deposits += deposit;
    house.withdrawals += withdrawal;
    house.count += 1;
    houses.set(houseName, house);

    const month = txn.date.toISOString().slice(0, 7);
    const bucket = monthly.get(month) ?? { month, deposits: 0, withdrawals: 0 };
    bucket.deposits += deposit;
    bucket.withdrawals += withdrawal;
    monthly.set(month, bucket);
  }

  const houseList: HouseSummary[] = Array.from(houses.values())
    .map((h) => ({
      house: h.house,
      deposits: agorotToNumber(h.deposits),
      withdrawals: agorotToNumber(h.withdrawals),
      net: agorotToNumber(h.deposits - h.withdrawals),
      count: h.count,
    }))
    .sort((a, b) => b.net - a.net);

  const monthlyList: MonthlyInvestmentActivity[] = Array.from(monthly.values())
    .map((m) => ({
      month: m.month,
      deposits: agorotToNumber(m.deposits),
      withdrawals: agorotToNumber(m.withdrawals),
      net: agorotToNumber(m.deposits - m.withdrawals),
    }))
    .sort((a, b) => a.month.localeCompare(b.month));

  return {
    totalDeposits: agorotToNumber(totalDeposits),
    totalWithdrawals: agorotToNumber(totalWithdrawals),
    totalInvested: agorotToNumber(totalDeposits - totalWithdrawals),
    count: txns.length,
    houses: houseList,
    monthly: monthlyList,
  };
}
