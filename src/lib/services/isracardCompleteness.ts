/**
 * Isracard completeness diagnostics.
 *
 * israeli-bank-scrapers' Isracard parser silently drops some raw rows before
 * they reach us (see convertTransactions in base-isracard-amex.js), so a
 * scrape with errors=0 is not proof the provider's full set was imported.
 */

/** The raw CardsTransactionsList fields the library's filter looks at. */
export type IsracardRawTxn = {
  dealSumType?: string | null;
  voucherNumberRatz?: string | null;
  voucherNumberRatzOutbound?: string | null;
  dealSumOutbound?: number | null;
  [key: string]: unknown;
};

export type IsracardDropReason = 'dealSumType=1' | 'no-voucher' | 'no-voucher-outbound';

/**
 * Mirrors the library's row filter (israeli-bank-scrapers 6.12.x):
 * `dealSumType !== '1' && voucherNumberRatz !== '000000000' &&
 * voucherNumberRatzOutbound !== '000000000'`. Returns why a row is dropped,
 * or null when the library keeps it.
 */
export function isracardRawDropReason(txn: IsracardRawTxn): IsracardDropReason | null {
  if (txn.dealSumType === '1') return 'dealSumType=1';
  if (txn.voucherNumberRatz === '000000000') return 'no-voucher';
  if (txn.voucherNumberRatzOutbound === '000000000') return 'no-voucher-outbound';
  return null;
}
