import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatMoney,
  getDisplayAmounts,
  normalizeCurrency,
  sumByCurrency,
} from './currencyDisplay';

// ---------------------------------------------------------------------------
// Regression: EXAMPLE TRAVEL BV (foreign EUR purchase settled in ILS).
// The bug: the UI formatted chargedAmount using originalCurrency, showing the
// ILS settlement amount as if it were EUR (e.g. "€-1,113.97" instead of
// "₪-1,113.97 (€-280.05)").
// ---------------------------------------------------------------------------
const bookingTxn = {
  description: 'EXAMPLE TRAVEL BV',
  chargedAmount: -1113.97,
  chargedCurrency: 'ILS',
  originalAmount: -280.05,
  originalCurrency: 'EUR',
};

test('EXAMPLE TRAVEL BV: primary is the ILS settlement, never EUR', () => {
  const { primary } = getDisplayAmounts(bookingTxn);
  assert.deepEqual(primary, { amount: -1113.97, currency: 'ILS' });
  const formatted = formatMoney(primary.amount, primary.currency);
  assert.ok(formatted.includes('₪'), `expected ILS symbol in "${formatted}"`);
  assert.ok(!formatted.includes('€'), `must not format settlement as EUR: "${formatted}"`);
});

test('EXAMPLE TRAVEL BV: secondary shows the original EUR amount', () => {
  const { secondary } = getDisplayAmounts(bookingTxn);
  assert.deepEqual(secondary, { amount: -280.05, currency: 'EUR' });
  const formatted = formatMoney(secondary!.amount, secondary!.currency);
  assert.ok(formatted.includes('€'), `expected EUR symbol in "${formatted}"`);
  // The EUR figure must be the original amount, not the ILS settlement.
  assert.ok(formatted.includes('280.05'), `expected 280.05 in "${formatted}"`);
});

test('EXAMPLE TRAVEL BV: real DB shape (ILS settlement, USD original)', () => {
  // Shape of a scraped row: charged in ILS, original in USD.
  const { primary, secondary } = getDisplayAmounts({
    chargedAmount: -2500,
    chargedCurrency: 'ILS',
    originalAmount: -700,
    originalCurrency: 'USD',
  });
  assert.deepEqual(primary, { amount: -2500, currency: 'ILS' });
  assert.deepEqual(secondary, { amount: -700, currency: 'USD' });
  assert.ok(!formatMoney(primary.amount, primary.currency).includes('$'));
});

test('same-currency transaction shows no secondary amount', () => {
  const { primary, secondary } = getDisplayAmounts({
    chargedAmount: -52.9,
    chargedCurrency: 'ILS',
    originalAmount: -52.9,
    originalCurrency: 'ILS',
  });
  assert.equal(primary.currency, 'ILS');
  assert.equal(secondary, null);
});

test('missing chargedCurrency defaults to ILS (legacy rows)', () => {
  const { primary } = getDisplayAmounts({ chargedAmount: -10, chargedCurrency: null });
  assert.equal(primary.currency, 'ILS');
});

test('missing originalAmount yields no secondary even when currencies differ', () => {
  const { secondary } = getDisplayAmounts({
    chargedAmount: -100,
    chargedCurrency: 'ILS',
    originalAmount: null,
    originalCurrency: 'USD',
  });
  assert.equal(secondary, null);
});

test('foreign-settled transaction keeps its own settlement currency', () => {
  const { primary, secondary } = getDisplayAmounts({
    chargedAmount: -25,
    chargedCurrency: 'USD',
    originalAmount: -25,
    originalCurrency: 'USD',
  });
  assert.deepEqual(primary, { amount: -25, currency: 'USD' });
  assert.equal(secondary, null);
  assert.ok(formatMoney(primary.amount, primary.currency).includes('$'));
});

test('normalizeCurrency maps scraper symbols/aliases to ISO codes', () => {
  assert.equal(normalizeCurrency('NIS'), 'ILS');
  assert.equal(normalizeCurrency('₪'), 'ILS');
  assert.equal(normalizeCurrency('€'), 'EUR');
  assert.equal(normalizeCurrency(' usd '), 'USD');
  assert.equal(normalizeCurrency(''), 'ILS');
  assert.equal(normalizeCurrency(undefined), 'ILS');
});

test('formatMoney falls back to plain text for non-ISO currency values', () => {
  const formatted = formatMoney(-5, 'XX1');
  assert.ok(formatted.includes('XX1'), `expected raw code in "${formatted}"`);
});

// ---------------------------------------------------------------------------
// Never sum mixed currencies as ILS.
// ---------------------------------------------------------------------------
test('sumByCurrency keeps each currency separate — never one merged ILS total', () => {
  const totals = sumByCurrency([
    { chargedAmount: -100, chargedCurrency: 'ILS' },
    { chargedAmount: -200.5, chargedCurrency: 'ILS' },
    bookingTxn, // ILS settlement joins the ILS bucket
    { chargedAmount: -50, chargedCurrency: 'EUR' },
    { chargedAmount: -30, chargedCurrency: 'USD' },
  ]);
  assert.deepEqual(totals, [
    { currency: 'ILS', total: -1414.47 },
    { currency: 'EUR', total: -50 },
    { currency: 'USD', total: -30 },
  ]);
  // Sanity: no bucket ever equals the naive mixed sum.
  const naiveMixed = -100 - 200.5 - 1113.97 - 50 - 30;
  assert.ok(totals.every((t) => t.total !== naiveMixed));
});

test('sumByCurrency treats missing chargedCurrency as ILS', () => {
  const totals = sumByCurrency([
    { chargedAmount: -10 },
    { chargedAmount: -5, chargedCurrency: 'ILS' },
  ]);
  assert.deepEqual(totals, [{ currency: 'ILS', total: -15 }]);
});

// Card #60 — an isRefund row keeps its raw negative provider amount in the
// API/DB but is displayed (and netted) as positive income.
test('isRefund row displays the absolute amount as a positive (green) value', () => {
  const { primary } = getDisplayAmounts({ chargedAmount: -125, chargedCurrency: 'ILS', isRefund: true });
  assert.deepEqual(primary, { amount: 125, currency: 'ILS' });
  const plain = getDisplayAmounts({ chargedAmount: -125, chargedCurrency: 'ILS' });
  assert.deepEqual(plain.primary, { amount: -125, currency: 'ILS' });
});

test('sumByCurrency nets an isRefund row as +|amount| (Pasta Bar month net is -125, not -375)', () => {
  assert.deepEqual(
    sumByCurrency([
      { chargedAmount: -250, chargedCurrency: 'ILS' },
      { chargedAmount: -125, chargedCurrency: 'ILS', isRefund: true },
    ]),
    [{ currency: 'ILS', total: -125 }],
  );
});
