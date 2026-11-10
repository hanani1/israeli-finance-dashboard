/**
 * Settlement currency (chargedCurrency) of a scraped row, as an ISO code
 * (pure, unit-tested; card #49).
 *
 *  - Isracard: always inferred from the amounts (isracardCurrency.ts); the
 *    library's chargedCurrency is the voucher currency, not the settlement one.
 *  - Explicit provider value: normalized (₪ → ILS, $ → USD, ...).
 *  - Missing (visa-cal.js leaves it undefined on every pending row, max.js on
 *    unmapped currency ids): a foreign purchase whose charged amount equals the
 *    original amount is still in the purchase currency — Cal pending rows carry
 *    trnAmt in both fields — so keep that currency instead of labelling €50 as
 *    ₪50. Any other combination is a converted amount and settles in ILS.
 */
import { CompanyTypes } from 'israeli-bank-scrapers';
import { inferChargedCurrencyFromAmounts } from './isracardCurrency';
import { normalizeCurrencyCode } from './pendingSettlement';

export interface ScrapedCurrencyFields {
  chargedCurrency?: string | null;
  originalCurrency?: string | null;
  originalAmount?: number | null;
  chargedAmount?: number | null;
}

export function resolveChargedCurrency(provider: string, txn: ScrapedCurrencyFields): string {
  const explicit = (txn.chargedCurrency ?? '').trim();
  if (provider === CompanyTypes.isracard) {
    return inferChargedCurrencyFromAmounts(txn.originalCurrency, txn.originalAmount, txn.chargedAmount);
  }
  if (explicit !== '') return normalizeCurrencyCode(explicit);
  // Nothing charged yet (Max pending rows can report 0) is not a foreign amount.
  if (txn.chargedAmount === 0) return 'ILS';
  return inferChargedCurrencyFromAmounts(txn.originalCurrency, txn.originalAmount, txn.chargedAmount);
}
