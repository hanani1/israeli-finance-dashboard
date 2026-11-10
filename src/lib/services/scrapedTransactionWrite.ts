/**
 * Shape of the Prisma upsert for a scraped transaction (pure, unit-tested).
 *
 * Provider-owned fields converge to the provider's latest value on every
 * scrape. User-owned fields — the note, the category and how it was assigned,
 * transfer / settlement / refund (isRefund) flags, the RiseUp flow month — are
 * never part of the update payload, so they survive re-ingestion by
 * construction.
 */
import type { Transaction as ScrapedTransaction } from 'israeli-bank-scrapers/lib/transactions';
import { money, originalAmount, type Decimal } from './money';
import { normalizeCurrencyCode, normalizeTxnIdentifier } from './pendingSettlement';

export const USER_OWNED_TRANSACTION_FIELDS = [
  'note',
  'categoryId',
  'categorizationSource',
  'isTransfer',
  'transferPairId',
  'isCardSettlement',
  'settlesAccountId',
  'flowMonth',
  'isRefund',
] as const;

export interface ScrapedTransactionWrite {
  update: {
    date: Date;
    txnIdentifier: string | null;
    processedDate: Date | null;
    chargedCurrency: string;
    originalAmount: Decimal | null;
    originalCurrency: string;
    memo: string | null;
    rawCategory: string | null;
    providerStatus: string | null;
  };
  create: ScrapedTransactionWrite['update'] & {
    id: string;
    accountId: string;
    chargedAmount: Decimal;
    description: string;
  };
}

export function buildScrapedTransactionWrite(
  accountId: string,
  id: string,
  txn: ScrapedTransaction,
): ScrapedTransactionWrite {
  const update: ScrapedTransactionWrite['update'] = {
    date: new Date(txn.date),
    txnIdentifier: normalizeTxnIdentifier(txn.identifier),
    processedDate: txn.processedDate ? new Date(txn.processedDate) : null,
    // Settlement currency of chargedAmount as an ISO code (Cal reports "₪").
    chargedCurrency: normalizeCurrencyCode(txn.chargedCurrency),
    // Scraper floats are pinned to the column scale here, the write boundary (card #53).
    originalAmount:
      txn.originalAmount === null || txn.originalAmount === undefined
        ? null
        : originalAmount(txn.originalAmount),
    originalCurrency: normalizeCurrencyCode(txn.originalCurrency ?? txn.chargedCurrency),
    memo: txn.memo ?? null,
    rawCategory: txn.category ?? null,
    // "pending" | "completed" — drives pending retirement (pendingRetirement.ts).
    providerStatus: txn.status ?? null,
  };
  return {
    update,
    create: {
      id,
      accountId,
      chargedAmount: money(txn.chargedAmount),
      description: txn.description,
      ...update,
    },
  };
}
