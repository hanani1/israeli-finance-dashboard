/**
 * Card #49: the settlement currency of a scraped row when the provider omits
 * it. visa-cal.js leaves chargedCurrency undefined on every pending row and
 * reports chargedAmount in the purchase currency (trnAmt), so a pending €50
 * purchase must stay €50 instead of being stored as ₪50.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveChargedCurrency } from './scrapedCurrency';
import { normalizeCurrencyCode } from './pendingSettlement';

test('Cal foreign pending (no chargedCurrency, charged == original) keeps the purchase currency', () => {
  assert.equal(
    resolveChargedCurrency('visaCal', { chargedCurrency: undefined, originalCurrency: '€', originalAmount: -50, chargedAmount: -50 }),
    'EUR',
  );
  assert.equal(
    resolveChargedCurrency('visaCal', { chargedCurrency: undefined, originalCurrency: '$', originalAmount: -12.5, chargedAmount: -12.5 }),
    'USD',
  );
});

test('Cal shekel pending without chargedCurrency stays ILS', () => {
  assert.equal(
    resolveChargedCurrency('visaCal', { chargedCurrency: undefined, originalCurrency: '₪', originalAmount: -80, chargedAmount: -80 }),
    'ILS',
  );
});

test('missing chargedCurrency with a converted amount is ILS (the amount is already shekels)', () => {
  assert.equal(
    resolveChargedCurrency('max', { chargedCurrency: undefined, originalCurrency: 'GBP', originalAmount: -20, chargedAmount: -96.4 }),
    'ILS',
  );
  // Max pending rows may report 0 paid so far: never label 0 as a foreign amount.
  assert.equal(
    resolveChargedCurrency('max', { chargedCurrency: undefined, originalCurrency: 'USD', originalAmount: -20, chargedAmount: 0 }),
    'ILS',
  );
});

test('an explicit provider chargedCurrency wins and is normalized to ISO', () => {
  assert.equal(
    resolveChargedCurrency('visaCal', { chargedCurrency: '₪', originalCurrency: '€', originalAmount: -50, chargedAmount: -195 }),
    'ILS',
  );
  assert.equal(
    resolveChargedCurrency('max', { chargedCurrency: 'usd', originalCurrency: 'USD', originalAmount: -5, chargedAmount: -5 }),
    'USD',
  );
});

test('Isracard keeps its amount-based inference even when chargedCurrency is set', () => {
  // base-isracard-amex.js copies currencyId into chargedCurrency, which is not the settlement currency.
  assert.equal(
    resolveChargedCurrency('isracard', { chargedCurrency: 'EUR', originalCurrency: 'EUR', originalAmount: 7, chargedAmount: 24.89 }),
    'ILS',
  );
  assert.equal(
    resolveChargedCurrency('isracard', { chargedCurrency: 'ILS', originalCurrency: 'EUR', originalAmount: 1585.8, chargedAmount: 1585.8 }),
    'EUR',
  );
});

test('normalizeCurrencyCode maps every symbol / alias / case variant to an ISO code', () => {
  for (const [input, iso] of [
    ['₪', 'ILS'], [' ₪ ', 'ILS'], ['ש"ח', 'ILS'], ['ש״ח', 'ILS'], ['שח', 'ILS'], ['nis', 'ILS'], ['ils', 'ILS'],
    ['$', 'USD'], ['US$', 'USD'], ['usd', 'USD'], ['דולר', 'USD'],
    ['€', 'EUR'], ['eur', 'EUR'], ['יורו', 'EUR'],
    ['£', 'GBP'], ['gbp', 'GBP'],
    ['', 'ILS'], [null, 'ILS'], [undefined, 'ILS'],
  ] as const) {
    assert.equal(normalizeCurrencyCode(input), iso, `normalizeCurrencyCode(${JSON.stringify(input)})`);
  }
});
