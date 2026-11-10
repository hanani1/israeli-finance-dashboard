/**
 * Provider → AccountKind mapping. CARD providers are credit-card issuers whose
 * spending is settled by a monthly debit on a BANK account; their "balance" is
 * not money the household holds, so it never counts toward current balance.
 */
import { AccountKind } from '@prisma/client';

const CARD_PROVIDERS: ReadonlySet<string> = new Set([
  'visaCal',
  'max',
  'isracard',
  'amex',
  'leumiCard', // legacy name of max
  'behatsdaa',
  'beyahadBishvilha',
]);

export function accountKindForProvider(provider: string): AccountKind {
  return CARD_PROVIDERS.has(provider) ? AccountKind.CARD : AccountKind.BANK;
}
