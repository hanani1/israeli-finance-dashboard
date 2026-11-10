/**
 * Budget service layer — persistence for monthly per-category budgets and the
 * read-time pacing aggregation that powers the Budgets page.
 *
 * Sign convention (matches analyticsService): scraped expenses have negative
 * chargedAmount; "spent" is reported as a positive number.
 */
import { CategoryType, type Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { DEFAULT_CURRENCY } from '@/lib/services/currencyDisplay';
import { effectiveFlowMonthWhere } from '@/lib/services/flowMonth';
import { RequestError } from '@/lib/services/requestError';
import {
  MAX_MONEY_AMOUNT,
  ZERO_MONEY,
  money,
  moneyToNumber,
  sumMoney,
  type Decimal,
} from '@/lib/services/money';
import { computePacing, resolveMonthWindow, type Pacing } from './budgetPacing';

/** API input: `amount` is the JSON number the client sent (rounded to the agorot on write). */
export interface BudgetInput {
  categoryId: number;
  amount: number;
}

export interface BudgetMetadata {
  id: number;
  categoryId: number;
  categoryName: string;
  color: string;
  amount: number;
}

export interface CategoryPacing extends Pacing {
  budgetId: number;
  categoryId: number;
  name: string;
  color: string;
}

export interface BudgetPacingResult {
  month: string; // yyyy-MM
  totals: Pacing;
  categories: CategoryPacing[];
}

/** Create or replace the budget for a single category. */
export async function upsertBudget(input: BudgetInput): Promise<BudgetMetadata> {
  if (!Number.isInteger(input.categoryId)) {
    throw new RequestError(400, 'categoryId must be an integer');
  }
  if (
    typeof input.amount !== 'number' ||
    !Number.isFinite(input.amount) ||
    input.amount < 0 ||
    input.amount > MAX_MONEY_AMOUNT
  ) {
    throw new RequestError(400, 'amount must be a non-negative number');
  }

  const amount = money(input.amount);
  const budget = await prisma.budget.upsert({
    where: { categoryId: input.categoryId },
    update: { amount },
    create: { categoryId: input.categoryId, amount },
    include: { category: { select: { name: true, color: true } } },
  });

  return {
    id: budget.id,
    categoryId: budget.categoryId,
    categoryName: budget.category.name,
    color: budget.category.color,
    amount: moneyToNumber(budget.amount),
  };
}

export async function deleteBudget(id: number): Promise<void> {
  await prisma.budget.delete({ where: { id } });
}

/**
 * Spend counted against budgets in one month. The month is the *effective
 * flow month* — the same predicate as the monthly breakdown (card #53), so a
 * Jan-31 purchase RiseUp assigns to February eats into February's budget and
 * shows in February's breakdown, never one of each.
 */
export function budgetSpendWhere(options: {
  label: string;
  categoryIds: number[];
  userId?: string;
}): Prisma.TransactionWhereInput {
  return {
    AND: [effectiveFlowMonthWhere([options.label])],
    chargedAmount: { lt: 0 },
    isTransfer: false,
    isCardSettlement: false,
    // A same-sign refund (isRefund, raw negative) is income, not spend — it
    // must not eat into a budget (ADR-0024).
    isRefund: false,
    // Budgets are ILS figures — never fold foreign-settled rows into them.
    chargedCurrency: DEFAULT_CURRENCY,
    categoryId: { in: options.categoryIds },
    ...(options.userId ? { account: { userId: options.userId } } : {}),
  };
}

/**
 * Compute pacing for every budgeted category in the given month, plus an
 * aggregate total row. `now` is injectable so callers/tests control "today".
 */
export async function getBudgetPacing(
  options: { month?: string; userId?: string },
  now: Date = new Date(),
): Promise<BudgetPacingResult> {
  const window = resolveMonthWindow(options.month, now);

  const budgets = await prisma.budget.findMany({
    include: { category: { select: { id: true, name: true, color: true } } },
    orderBy: { category: { name: 'asc' } },
  });

  if (budgets.length === 0) {
    return {
      month: window.label,
      totals: computePacing({
        amount: 0,
        spent: 0,
        daysElapsed: window.daysElapsed,
        daysInMonth: window.daysInMonth,
      }),
      categories: [],
    };
  }

  const budgetedCategoryIds = budgets.map((b) => b.categoryId);

  const grouped = await prisma.transaction.groupBy({
    by: ['categoryId'],
    where: budgetSpendWhere({
      label: window.label,
      categoryIds: budgetedCategoryIds,
      userId: options.userId,
    }),
    _sum: { chargedAmount: true },
  });

  const spentByCategory = new Map<number, Decimal>();
  for (const row of grouped) {
    if (row.categoryId !== null) {
      spentByCategory.set(row.categoryId, sumMoney([row._sum.chargedAmount]).abs());
    }
  }

  const categories: CategoryPacing[] = budgets.map((budget) => {
    const spent = spentByCategory.get(budget.categoryId) ?? ZERO_MONEY;
    const pacing = computePacing({
      amount: budget.amount,
      spent,
      daysElapsed: window.daysElapsed,
      daysInMonth: window.daysInMonth,
    });
    return {
      ...pacing,
      budgetId: budget.id,
      categoryId: budget.categoryId,
      name: budget.category.name,
      color: budget.category.color,
    };
  });

  const totalAmount = sumMoney(budgets.map((b) => b.amount));
  const totalSpent = sumMoney(budgets.map((b) => spentByCategory.get(b.categoryId)));
  const totals = computePacing({
    amount: totalAmount,
    spent: totalSpent,
    daysElapsed: window.daysElapsed,
    daysInMonth: window.daysInMonth,
  });

  return { month: window.label, totals, categories };
}

/** Expense categories with their current budget amount (0 when unset). */
export async function listBudgetableCategories(): Promise<
  Array<{ categoryId: number; name: string; color: string; amount: number; budgetId: number | null }>
> {
  const categories = await prisma.category.findMany({
    where: { type: CategoryType.EXPENSE },
    include: { budget: { select: { id: true, amount: true } } },
    orderBy: { name: 'asc' },
  });
  return categories.map((c) => ({
    categoryId: c.id,
    name: c.name,
    color: c.color,
    amount: c.budget ? moneyToNumber(c.budget.amount) : 0,
    budgetId: c.budget?.id ?? null,
  }));
}
