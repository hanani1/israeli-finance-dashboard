/**
 * Infer a row's settlement currency from its amounts when the provider does
 * not expose it reliably: a non-ILS purchase whose charged amount equals the
 * original amount (within a cent) was settled in the original currency;
 * everything else settles in ILS. Used for every Isracard row and for other
 * providers' rows without a chargedCurrency (scrapedCurrency.ts).
 */
import { normalizeCurrencyCode } from './pendingSettlement';

const ILS = 'ILS';
const SAME_AMOUNT_TOLERANCE = 0.005;

export function inferChargedCurrencyFromAmounts(
  originalCurrency: string | null | undefined,
  originalAmount: number | null | undefined,
  chargedAmount: number | null | undefined,
): string {
  const original = normalizeCurrencyCode(originalCurrency);
  if (
    original === ILS ||
    typeof originalAmount !== 'number' ||
    typeof chargedAmount !== 'number' ||
    Number.isNaN(originalAmount) ||
    Number.isNaN(chargedAmount)
  ) {
    return ILS;
  }

  return Math.abs(Math.abs(chargedAmount) - Math.abs(originalAmount)) < SAME_AMOUNT_TOLERANCE
    ? original
    : ILS;
}

export const inferIsracardChargedCurrency = inferChargedCurrencyFromAmounts;
