/**
 * DB glue for "find similar transactions". The pure matching logic lives in
 * similarTransactions.ts; this module loads the source transaction
 * server-side (the API only ever receives an id — never client-supplied
 * merchant strings), scans a bounded candidate set, and ranks it.
 */
import { prisma } from '@/lib/db';
import { moneyToNumber, originalAmountToNumberOrNull } from '@/lib/services/money';
import {
  anchorToken,
  clampPagination,
  isGenericDescription,
  rankSimilar,
  type Pagination,
  type SimilarReason,
} from './similarTransactions';

/** Upper bound on rows scanned per request, newest first. */
const CANDIDATE_SCAN_LIMIT = 1000;

export interface SimilarTransactionItem {
  id: string;
  date: Date;
  description: string;
  chargedAmount: number;
  chargedCurrency: string;
  originalAmount: number | null;
  originalCurrency: string | null;
  account: { displayName: string };
  category: { id: number; name: string; color: string } | null;
  score: number;
  reasons: SimilarReason[];
}

export interface SimilarTransactionsResult {
  source: {
    id: string;
    date: Date;
    description: string;
    chargedAmount: number;
    chargedCurrency: string;
    originalAmount: number | null;
    originalCurrency: string | null;
  };
  /** True when the source description is a generic transfer/card string —
   *  only exact-description matches are returned in that case. */
  generic: boolean;
  items: SimilarTransactionItem[];
  total: number;
  hasMore: boolean;
  limit: number;
  offset: number;
}

/**
 * Find transactions similar to the given source transaction.
 * Returns null when the source transaction does not exist.
 */
export async function findSimilarTransactions(
  sourceId: string,
  paginationRaw: { limit?: string | null; offset?: string | null } = {},
): Promise<SimilarTransactionsResult | null> {
  const source = await prisma.transaction.findFirst({
    where: { id: sourceId, isCardSettlement: false },
    select: {
      id: true,
      date: true,
      description: true,
      chargedAmount: true,
      chargedCurrency: true,
      originalAmount: true,
      originalCurrency: true,
      categoryId: true,
    },
  });
  if (!source) return null;

  const pagination: Pagination = clampPagination(paginationRaw.limit, paginationRaw.offset);
  const generic = isGenericDescription(source.description);
  const anchor = anchorToken(source.description);

  // Bounded candidate scan. For merchant-bearing descriptions we pre-filter by
  // the most selective token; generic descriptions only ever match the exact
  // same string, so the query is an equality lookup.
  const candidates = await prisma.transaction.findMany({
    where: {
      id: { not: source.id },
      isCardSettlement: false,
      description:
        generic || anchor === null
          ? { equals: source.description }
          : { contains: anchor, mode: 'insensitive' },
    },
    select: {
      id: true,
      date: true,
      description: true,
      chargedAmount: true,
      chargedCurrency: true,
      originalAmount: true,
      originalCurrency: true,
      categoryId: true,
      account: { select: { displayName: true } },
      category: { select: { id: true, name: true, color: true } },
    },
    orderBy: { date: 'desc' },
    take: CANDIDATE_SCAN_LIMIT,
  });

  const ranked = rankSimilar(source, candidates, pagination);

  return {
    source: {
      id: source.id,
      date: source.date,
      description: source.description,
      chargedAmount: moneyToNumber(source.chargedAmount),
      chargedCurrency: source.chargedCurrency,
      originalAmount: originalAmountToNumberOrNull(source.originalAmount),
      originalCurrency: source.originalCurrency,
    },
    generic,
    items: ranked.items.map(({ candidate, score, reasons }) => ({
      id: candidate.id,
      date: candidate.date,
      description: candidate.description,
      chargedAmount: moneyToNumber(candidate.chargedAmount),
      chargedCurrency: candidate.chargedCurrency,
      originalAmount: originalAmountToNumberOrNull(candidate.originalAmount),
      originalCurrency: candidate.originalCurrency,
      account: { displayName: candidate.account.displayName },
      category: candidate.category,
      score,
      reasons,
    })),
    total: ranked.total,
    hasMore: ranked.hasMore,
    limit: pagination.limit,
    offset: pagination.offset,
  };
}
