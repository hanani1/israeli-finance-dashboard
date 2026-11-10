import assert from 'node:assert/strict';
import { test } from 'node:test';
import { USER_OWNED_TRANSACTION_FIELDS, buildScrapedTransactionWrite } from './scrapedTransactionWrite';

const scraped = {
  identifier: '030000005',
  date: '2026-09-01T21:00:00.000Z',
  processedDate: '2026-09-08T21:00:00.000Z',
  chargedAmount: -600,
  chargedCurrency: '₪',
  originalAmount: -600,
  originalCurrency: '₪',
  description: 'מאפיית השכונה הגדולה',
  memo: '',
  category: 'תרומות',
  type: 'normal',
  status: 'completed',
} as const;

test('re-ingestion never overwrites user-owned fields: note, category, categorization source, transfer/settlement flags, flow month', () => {
  const write = buildScrapedTransactionWrite('acct', 'row-id', scraped as never);
  for (const field of USER_OWNED_TRANSACTION_FIELDS) {
    assert.equal(field in write.update, false, `update must not touch ${field}`);
    assert.equal(field in write.create, false, `create must not preset ${field}`);
  }
  assert.ok(USER_OWNED_TRANSACTION_FIELDS.includes('note'));
  assert.ok(USER_OWNED_TRANSACTION_FIELDS.includes('categoryId'));
});

test('re-ingestion converges provider-owned fields: date, processedDate, normalized identifier and currency', () => {
  const write = buildScrapedTransactionWrite('acct', 'row-id', scraped as never);
  assert.equal(write.update.date.toISOString(), '2026-09-01T21:00:00.000Z');
  assert.equal(write.update.txnIdentifier, '30000005');
  assert.equal(write.update.chargedCurrency, 'ILS');
  assert.equal(write.update.originalCurrency, 'ILS');
  assert.equal(write.create.id, 'row-id');
  assert.equal(write.create.accountId, 'acct');
  assert.equal(write.create.chargedAmount.toString(), '-600');
});

test('scraper floats are pinned to the column scale on write (card #53)', () => {
  const write = buildScrapedTransactionWrite('acct', 'row-id', {
    ...scraped,
    chargedAmount: -(0.1 + 0.2),
    originalAmount: -12.3456,
    originalCurrency: 'JOD',
  } as never);
  assert.equal(write.create.chargedAmount.toString(), '-0.3');
  // originalAmount keeps three decimals (JOD fils), see ADR-0027.
  assert.equal(write.update.originalAmount?.toString(), '-12.346');
});

test('re-ingestion never erases the semantic refund flag (card #60): isRefund is user-owned', () => {
  assert.ok(USER_OWNED_TRANSACTION_FIELDS.includes('isRefund'));
  // The Pasta Bar reversal: raw -125, same sign as the -250 purchase.
  const write = buildScrapedTransactionWrite('acct', 'row-id', { ...scraped, chargedAmount: -125 } as never);
  assert.equal('isRefund' in write.update, false, 'update must not touch isRefund');
  assert.equal('isRefund' in write.create, false, 'create must not preset isRefund (DB default false)');
  // The raw provider amount/sign is preserved on create and never rewritten on update.
  assert.equal(write.create.chargedAmount.toString(), '-125');
  assert.equal('chargedAmount' in write.update, false);
});

test('card #49: the scraper status is persisted and converges; the retirement marker is never in the scrape payload', () => {
  const pending = buildScrapedTransactionWrite('acct', 'row-id', { ...scraped, status: 'pending' } as never);
  assert.equal(pending.create.providerStatus, 'pending');
  assert.equal(pending.update.providerStatus, 'pending');
  const completed = buildScrapedTransactionWrite('acct', 'row-id', scraped as never);
  assert.equal(completed.update.providerStatus, 'completed');
  const missing = buildScrapedTransactionWrite('acct', 'row-id', { ...scraped, status: undefined } as never);
  assert.equal(missing.update.providerStatus, null);
  assert.equal('pendingRetiredAt' in completed.update, false);
  assert.equal('pendingRetiredAt' in completed.create, false);
});
