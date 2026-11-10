/**
 * Multi-currency display + aggregation helpers (pure, unit-tested).
 *
 * Money convention:
 * - `chargedAmount` + `chargedCurrency` is the settlement — what actually left
 *   the account. It is ALWAYS the primary display value.
 * - `originalAmount` + `originalCurrency` is the merchant-side amount for
 *   foreign-currency purchases (e.g. a EUR hotel booking charged in ILS). It
 *   is shown as secondary context ONLY when its currency differs from the
 *   settlement currency.
 * - Amounts in different currencies must NEVER be added together as if they
 *   were all ILS — totals are always computed per currency (sumByCurrency).
 */

export const DEFAULT_CURRENCY = 'ILS';

/** Symbols / legacy codes the scrapers emit, mapped to ISO 4217. */
const CURRENCY_ALIASES: Record<string, string> = {
  NIS: 'ILS',
  '₪': 'ILS',
  'ש"ח': 'ILS',
  'שח': 'ILS',
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
};

/**
 * Normalize a scraper/DB currency value to an ISO 4217 code.
 * Missing/empty values default to ILS (the settlement currency of Israeli
 * bank scrapes); unknown values pass through unchanged so they are still
 * displayed (formatMoney falls back to plain text) rather than being
 * silently mislabeled as ILS.
 */
export function normalizeCurrency(raw: string | null | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_CURRENCY;
  const upper = trimmed.toUpperCase();
  return CURRENCY_ALIASES[upper] ?? CURRENCY_ALIASES[trimmed] ?? upper;
}

/**
 * Format an amount in its own currency. Falls back to "<number> <code>" when
 * the currency is not a valid ISO code (Intl throws RangeError on those).
 */
export function formatMoney(amount: number, currency: string, locale = 'he-IL'): string {
  const code = normalizeCurrency(currency);
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: code,
      maximumFractionDigits: 2,
      minimumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(amount)} ${code}`;
  }
}

export interface MoneyParts {
  amount: number;
  currency: string;
}

export interface TransactionMoney {
  chargedAmount: number;
  /**
   * Transaction.isRefund (card #60): a same-sign provider refund. Its raw
   * chargedAmount stays negative, but it is displayed and netted as
   * +|amount| income — see semanticAmount.
   */
  isRefund?: boolean | null;
  chargedCurrency?: string | null;
  originalAmount?: number | null;
  originalCurrency?: string | null;
}

export interface DisplayAmounts {
  /** The settlement amount — always shown, in its settlement currency. */
  primary: MoneyParts;
  /** The merchant-side original amount — only when its currency differs. */
  secondary: MoneyParts | null;
}

/**
 * The semantic signed amount of a row: the raw chargedAmount, except that an
 * isRefund row (raw negative) counts as +|amount|. Same policy as
 * flowClassification.classifyFlow (ADR-0024); client-safe (no Prisma import).
 */
export function semanticAmount(amount: number, isRefund: boolean | null | undefined): number {
  return isRefund ? Math.abs(amount) : amount;
}

/** Resolve what to display for a transaction (see module doc). */
export function getDisplayAmounts(txn: TransactionMoney): DisplayAmounts {
  const chargedCurrency = normalizeCurrency(txn.chargedCurrency);
  const primary: MoneyParts = { amount: semanticAmount(txn.chargedAmount, txn.isRefund), currency: chargedCurrency };

  const hasOriginal =
    txn.originalAmount !== null && txn.originalAmount !== undefined && !!txn.originalCurrency?.trim();
  const originalCurrency = hasOriginal ? normalizeCurrency(txn.originalCurrency) : null;
  const secondary: MoneyParts | null =
    originalCurrency && originalCurrency !== chargedCurrency
      ? { amount: semanticAmount(txn.originalAmount as number, txn.isRefund), currency: originalCurrency }
      : null;

  return { primary, secondary };
}

export interface CurrencyTotal {
  currency: string;
  total: number;
}

/**
 * Sum settlement amounts grouped per currency — never across currencies.
 * isRefund rows contribute +|amount| (semanticAmount).
 * ILS (when present) is returned first, then other currencies alphabetically.
 */
export function sumByCurrency(
  rows: ReadonlyArray<{ chargedAmount: number; chargedCurrency?: string | null; isRefund?: boolean | null }>,
): CurrencyTotal[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const currency = normalizeCurrency(row.chargedCurrency);
    totals.set(currency, (totals.get(currency) ?? 0) + semanticAmount(row.chargedAmount, row.isRefund));
  }
  return Array.from(totals.entries())
    .map(([currency, total]) => ({ currency, total: Math.round(total * 100) / 100 }))
    .sort((a, b) => {
      if (a.currency === DEFAULT_CURRENCY) return -1;
      if (b.currency === DEFAULT_CURRENCY) return 1;
      return a.currency.localeCompare(b.currency);
    });
}
