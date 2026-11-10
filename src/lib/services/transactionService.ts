/**
 * Transaction service layer — all Prisma access for transaction listing and
 * manual categorization lives here.
 */
import { CategorizationSource, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { FLOW_MONTH_PATTERN, effectiveFlowMonthWhere } from '@/lib/services/flowMonth';
import { localDateRange } from '@/lib/services/localDay';
import {
  moneyToNumber,
  originalAmountToNumberOrNull,
  type Decimal,
} from '@/lib/services/money';
import { normalizeNote } from '@/lib/services/transactionNote';
import { assertRefundToggleAllowed } from '@/lib/services/transactionPatch';

export interface TransactionFilters {
  from?: string; // yyyy-MM-dd (inclusive)
  to?: string; // yyyy-MM-dd (inclusive)
  /**
   * Effective flow month (yyyy-MM): rows whose stored RiseUp flowMonth equals
   * it, plus rows without a stored flowMonth whose calendar date falls in the
   * month. Used by the monthly page so its transaction list matches the
   * flow-month breakdown totals. Takes precedence over from/to.
   */
  flowMonth?: string;
  userId?: string; // undefined = all household
  search?: string;
  categoryId?: number;
  uncategorizedOnly?: boolean;
  /** Only rows the user has not personally confirmed (source != MANUAL). */
  needsReview?: boolean;
  /** Internal audit use only. Public transaction APIs deliberately never set it. */
  includeCardSettlements?: boolean;
}

/** A transaction row as JSON: Decimal money fields become numbers. */
export type TransactionJson<T> = Omit<T, 'chargedAmount' | 'originalAmount'> & {
  chargedAmount: number;
  originalAmount: number | null;
};

/**
 * The UI/JSON boundary for transaction rows (card #53). Prisma returns the
 * money columns as Decimal, whose toJSON() is a string; API routes send rows
 * through this so clients keep receiving JSON numbers.
 */
export function serializeTransaction<
  T extends { chargedAmount: Decimal; originalAmount: Decimal | null },
>(row: T): TransactionJson<T> {
  return {
    ...row,
    chargedAmount: moneyToNumber(row.chargedAmount),
    originalAmount: originalAmountToNumberOrNull(row.originalAmount),
  };
}

export function buildTransactionWhere(
  filters: TransactionFilters,
): Prisma.TransactionWhereInput {
  // Raw settlement rows remain in PostgreSQL, but every normal list/review
  // path excludes them unless trusted internal code explicitly audits them.
  const where: Prisma.TransactionWhereInput = filters.includeCardSettlements
    ? {}
    : { isCardSettlement: false };

  if (filters.flowMonth && FLOW_MONTH_PATTERN.test(filters.flowMonth)) {
    where.AND = [effectiveFlowMonthWhere([filters.flowMonth])];
  } else if (filters.from || filters.to) {
    // Provider days on Israeli boundaries, see localDay.ts.
    where.date = localDateRange(filters.from, filters.to);
  }
  if (filters.userId) {
    where.account = { userId: filters.userId };
  }
  if (filters.search) {
    where.description = { contains: filters.search, mode: 'insensitive' };
  }
  if (filters.categoryId !== undefined) {
    where.categoryId = filters.categoryId;
  }
  if (filters.uncategorizedOnly) {
    where.categoryId = null;
  }
  if (filters.needsReview) {
    where.categorizationSource = { not: CategorizationSource.MANUAL };
  }
  return where;
}

export async function listTransactions(filters: TransactionFilters, limit = 500) {
  return prisma.transaction.findMany({
    where: buildTransactionWhere(filters),
    include: {
      category: true,
      account: {
        select: {
          displayName: true,
          provider: true,
          accountNumber: true,
          kind: true,
          userId: true,
          user: { select: { name: true } },
        },
      },
    },
    orderBy: { date: 'desc' },
    take: limit,
  });
}

/** Manually assign a category to a transaction (marks source = MANUAL). */
export async function setTransactionCategory(transactionId: string, categoryId: number | null) {
  return prisma.transaction.update({
    where: { id: transactionId },
    data: {
      categoryId,
      categorizationSource:
        categoryId === null ? CategorizationSource.UNASSIGNED : CategorizationSource.MANUAL,
    },
    include: { category: true },
  });
}

/**
 * Set or clear the user's note on a transaction. Throws
 * TransactionNotFoundError for an unknown id; validation errors propagate
 * from normalizeNote. Touches only `note`.
 */
export async function setTransactionNote(transactionId: string, note: string | null) {
  const normalized = normalizeNote(note);
  const existing = await prisma.transaction.findUnique({
    where: { id: transactionId },
    select: { id: true },
  });
  if (!existing) throw new TransactionNotFoundError(transactionId);
  return prisma.transaction.update({
    where: { id: transactionId },
    data: { note: normalized },
    select: { id: true, note: true },
  });
}

/**
 * Set or clear the semantic same-sign refund flag (card #60, ADR-0024).
 * Touches only `isRefund`; the raw provider amount/sign is never changed.
 * Throws TransactionNotFoundError for an unknown id and TransactionPatchError
 * when marking a row that is not a visible negative row.
 */
export async function setTransactionRefund(transactionId: string, isRefund: boolean) {
  const existing = await prisma.transaction.findUnique({
    where: { id: transactionId },
    select: { id: true, chargedAmount: true, isTransfer: true, isCardSettlement: true },
  });
  if (!existing) throw new TransactionNotFoundError(transactionId);
  assertRefundToggleAllowed(existing, isRefund);
  return prisma.transaction.update({
    where: { id: transactionId },
    data: { isRefund },
    include: { category: true },
  });
}

export class TransactionNotFoundError extends Error {
  constructor(id: string) {
    super(`Transaction ${id} not found`);
    this.name = 'TransactionNotFoundError';
  }
}

/**
 * Reclassify every transaction with an identical description to the given
 * category, marking them MANUAL. Used by the "make this permanent" flow so a
 * confirmed classification retroactively applies to all past identical rows.
 * Returns the number of rows updated.
 */
export async function reclassifyIdenticalTransactions(
  description: string,
  categoryId: number,
): Promise<number> {
  const result = await prisma.transaction.updateMany({
    where: { description, isCardSettlement: false },
    data: { categoryId, categorizationSource: CategorizationSource.MANUAL },
  });
  return result.count;
}

/**
 * Dedupe + order a category list for dropdowns.
 *
 * - Dedupes rows whose trimmed name and type collide (CSV imports have created
 *   such duplicates), keeping the oldest row (lowest id) — the one existing
 *   transactions/rules/budgets point at.
 * - Sorts alphabetically by Hebrew locale so עברית names order correctly.
 */
export function dedupeAndSortCategories<T extends { id: number; name: string; type: string }>(
  categories: T[],
): T[] {
  const byKey = new Map<string, T>();
  for (const category of categories) {
    const key = `${category.type}:${category.name.trim()}`;
    const existing = byKey.get(key);
    if (!existing || category.id < existing.id) {
      byKey.set(key, category);
    }
  }
  return Array.from(byKey.values()).sort(
    (a, b) => a.name.localeCompare(b.name, 'he') || a.id - b.id,
  );
}

export async function listCategories() {
  return dedupeAndSortCategories(await prisma.category.findMany());
}

export async function listUsers() {
  return prisma.user.findMany({ orderBy: { createdAt: 'asc' }, select: { id: true, name: true } });
}
