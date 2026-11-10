/**
 * Tests for Isracard settlement-currency inference.
 *
 * Rule under test: a completed voucher whose originalCurrencyIso is non-ILS
 * AND whose billingAmount equals originalAmount within a cent tolerance was
 * settled in the original (foreign) currency; every other voucher settles
 * in ILS. Applies to completed vouchers only — approved (pending)
 * transactions carry an explicit ilsBillingAmount and always stay ILS.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferIsracardChargedCurrency } from './isracardCurrency';

test('EUR voucher with billingAmount == originalAmount is EUR-settled', () => {
  // e.g. a hotel abroad: 1500.00 EUR billed as 1500.00
  assert.equal(inferIsracardChargedCurrency('EUR', 1500, 1500), 'EUR');
});

test('USD voucher with billingAmount == originalAmount is USD-settled', () => {
  assert.equal(inferIsracardChargedCurrency('USD', 52.13, 52.13), 'USD');
});

test('EUR voucher with converted billingAmount is ILS-settled', () => {
  // e.g. 7 EUR converted and billed as 28.00 ILS
  assert.equal(inferIsracardChargedCurrency('EUR', 7, 28), 'ILS');
});

test('ILS voucher is always ILS-settled, including alias spellings', () => {
  assert.equal(inferIsracardChargedCurrency('ILS', 100, 100), 'ILS');
  assert.equal(inferIsracardChargedCurrency('NIS', 100, 100), 'ILS');
  assert.equal(inferIsracardChargedCurrency('ש"ח', 100, 100), 'ILS');
  assert.equal(inferIsracardChargedCurrency('₪', 100, 100), 'ILS');
  assert.equal(inferIsracardChargedCurrency('', 100, 100), 'ILS');
  assert.equal(inferIsracardChargedCurrency(null, 100, 100), 'ILS');
});

test('cent tolerance: only sub-cent differences count as the same amount', () => {
  assert.equal(inferIsracardChargedCurrency('EUR', 10, 10.004), 'EUR');
  assert.equal(inferIsracardChargedCurrency('EUR', 10, 10.01), 'ILS');
  // sign convention does not matter — compares absolute values
  assert.equal(inferIsracardChargedCurrency('USD', -20, 20), 'USD');
});

test('missing amounts fall back to ILS', () => {
  assert.equal(inferIsracardChargedCurrency('EUR', null, 10), 'ILS');
  assert.equal(inferIsracardChargedCurrency('EUR', 10, null), 'ILS');
});
