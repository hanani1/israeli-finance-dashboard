/**
 * Income / expense classification policy shared by the summary cards, the
 * monthly breakdown, the trend chart and the reconciliation scripts so every
 * view reconciles with the others and with RiseUp. See ADR-0024.
 *
 * - A row marked `isRefund` (a provider refund/reversal reported with the
 *   SAME sign as the purchase, e.g. Pasta Bar's raw -₪125 after a -₪250
 *   purchase) is +|amount| income and never an expense, whatever its
 *   category. Its raw negative amount is preserved in the DB/API; only the
 *   semantic flow changes. The flag is only valid on negative rows (enforced
 *   by the API and a DB CHECK), so the rule is linear (income = -amount) and
 *   summed groups of flagged rows classify exactly like the rows one by one.
 * - Income is a positive amount in an INCOME-group category.
 * - A positive amount that is uncategorized or in an expense category is a
 *   refund/reversal of spending: it reduces expenses and never counts as
 *   income (e.g. a store credit on a card, MAX's +₪850 after -₪850).
 * - A negative amount in an INCOME-group category reduces income (clawback).
 * - Every other negative amount is an expense.
 *
 * Amounts follow the scraper convention: expenses negative, income positive.
 */
import { CategoryGroup } from '@prisma/client';
import { ZERO_MONEY, money, moneyToNumber, type Decimal, type MoneyInput } from './money';

export interface ClassifiedFlow {
  /** Signed contribution to income (positive adds, negative reduces). */
  income: Decimal;
  /** Signed contribution to expenses as a positive spend figure (negative = refund). */
  expense: Decimal;
}

export function classifyFlow(
  chargedAmount: MoneyInput,
  group: CategoryGroup | null,
  isRefund: boolean,
): ClassifiedFlow {
  const amount = money(chargedAmount);
  if (isRefund) return { income: amount.neg(), expense: ZERO_MONEY };
  if (group === CategoryGroup.INCOME) return { income: amount, expense: ZERO_MONEY };
  return { income: ZERO_MONEY, expense: amount.neg() };
}

export interface FlowRow {
  chargedAmount: MoneyInput;
  group: CategoryGroup | null;
  /** Transaction.isRefund — semantic same-sign refund (card #60). */
  isRefund: boolean;
}

/** Response DTO (JSON numbers, exact to the agorot). */
export interface FlowSummary {
  income: number;
  expenses: number;
  net: number;
}

export function summarizeFlows(rows: readonly FlowRow[]): FlowSummary {
  let income = ZERO_MONEY;
  let expenses = ZERO_MONEY;
  for (const row of rows) {
    const flow = classifyFlow(row.chargedAmount, row.group, row.isRefund);
    income = income.add(flow.income);
    expenses = expenses.add(flow.expense);
  }
  return {
    income: moneyToNumber(income),
    expenses: moneyToNumber(expenses),
    net: moneyToNumber(income.sub(expenses)),
  };
}
