import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_IDENTIFIER_DAY_GAP,
  detectSameSignRefundCandidates,
  merchantsAgree,
  type RefundCandidateRow,
} from './refundCandidates';

// Card #60 — review-first detector for provider refunds that arrive with the
// SAME sign as the purchase. It only reports; it never marks a row. Plain
// "same merchant, smaller amount, later date" is NOT enough evidence: that is
// what a second legitimate purchase looks like.

let seq = 0;
function row(overrides: Partial<RefundCandidateRow>): RefundCandidateRow {
  seq += 1;
  return {
    id: `row-${seq}`,
    accountId: 'isracard-1',
    txnIdentifier: null,
    date: new Date('2026-09-02T21:00:00.000Z'),
    processedDate: null,
    chargedAmount: -100,
    chargedCurrency: 'ILS',
    description: 'MERCHANT',
    memo: null,
    createdAt: new Date('2026-09-03T04:00:00.000Z'),
    isRefund: false,
    isTransfer: false,
    isCardSettlement: false,
    ...overrides,
  };
}

test('Pasta Bar: a -125 same-identifier reversal after a -250 purchase is one likely candidate', () => {
  const purchase = row({
    id: 'pastabar-purchase',
    txnIdentifier: '55500123',
    description: 'פסטה בר מסעדה',
    chargedAmount: -250,
    date: new Date('2026-09-04T21:00:00.000Z'),
    processedDate: new Date('2026-09-09T21:00:00.000Z'),
  });
  const reversal = row({
    id: 'pastabar-reversal',
    txnIdentifier: '55500123',
    description: 'פסטה בר מסעדה',
    chargedAmount: -125,
    date: new Date('2026-09-06T21:00:00.000Z'),
    processedDate: new Date('2026-09-09T21:00:00.000Z'),
  });
  // The padded-identifier snapshot of the purchase, already hidden as a settlement.
  const hiddenSnapshot = row({
    id: 'pastabar-snapshot',
    txnIdentifier: '0000055500123',
    description: 'פסטה בר מסעדה',
    chargedAmount: -250,
    date: new Date('2026-09-04T21:00:00.000Z'),
    processedDate: new Date('2026-09-04T21:00:00.000Z'),
    isCardSettlement: true,
  });

  const candidates = detectSameSignRefundCandidates([purchase, reversal, hiddenSnapshot]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.refundId, 'pastabar-reversal');
  assert.deepEqual(candidates[0]!.originalIds, ['pastabar-purchase']);
  assert.equal(candidates[0]!.confidence, 'likely');
  assert.deepEqual(candidates[0]!.evidence, ['shared-identifier']);
});

test('legitimate same-merchant purchases (smaller, later, own identifiers) are never flagged', () => {
  const rows = [
    row({ txnIdentifier: '7001', description: 'שופרסל דיל', chargedAmount: -250, date: new Date('2026-09-01T21:00:00.000Z') }),
    row({ txnIdentifier: '7002', description: 'שופרסל דיל', chargedAmount: -125, date: new Date('2026-09-04T21:00:00.000Z') }),
    row({ txnIdentifier: '7003', description: 'שופרסל דיל', chargedAmount: -80, date: new Date('2026-09-09T21:00:00.000Z') }),
    row({ txnIdentifier: null, description: 'קפה לדוגמה', chargedAmount: -18, date: new Date('2026-09-02T21:00:00.000Z') }),
    row({ txnIdentifier: null, description: 'קפה לדוגמה', chargedAmount: -18, date: new Date('2026-09-02T21:00:00.000Z') }),
  ];
  assert.deepEqual(detectSameSignRefundCandidates(rows), []);
});

test('a monthly standing order reusing its identifier is not a refund (gap beyond the lifecycle window)', () => {
  const rows = [
    row({ accountId: 'leumi', txnIdentifier: '900', description: 'חברת חשמל', chargedAmount: -420, date: new Date('2026-08-01T21:00:00.000Z') }),
    row({ accountId: 'leumi', txnIdentifier: '900', description: 'חברת חשמל', chargedAmount: -380, date: new Date('2026-09-01T21:00:00.000Z') }),
  ];
  assert.ok(31 > MAX_IDENTIFIER_DAY_GAP);
  assert.deepEqual(detectSameSignRefundCandidates(rows), []);
});

test('an explicit refund keyword (זיכוי / ביטול / refund) with a unique original is likely', () => {
  const purchase = row({ id: 'p', description: 'PASTABAR TLV', chargedAmount: -250 });
  const credit = row({
    id: 'r',
    description: 'זיכוי PASTABAR TLV',
    chargedAmount: -125,
    date: new Date('2026-09-20T21:00:00.000Z'),
  });
  const candidates = detectSameSignRefundCandidates([purchase, credit]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.refundId, 'r');
  assert.equal(candidates[0]!.confidence, 'likely');
  assert.deepEqual(candidates[0]!.evidence, ['refund-keyword']);
});

test('several possible originals make the candidate ambiguous (report for review, never pick one)', () => {
  const rows = [
    row({ id: 'p1', description: 'PASTABAR', chargedAmount: -250, date: new Date('2026-09-01T21:00:00.000Z') }),
    row({ id: 'p2', description: 'PASTABAR', chargedAmount: -200, date: new Date('2026-09-03T21:00:00.000Z') }),
    row({ id: 'r', description: 'ביטול עסקה PASTABAR', chargedAmount: -125, date: new Date('2026-09-05T21:00:00.000Z') }),
  ];
  const candidates = detectSameSignRefundCandidates(rows);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.confidence, 'ambiguous');
  assert.deepEqual(new Set(candidates[0]!.originalIds), new Set(['p1', 'p2']));
});

test('an equal-amount same-identifier pair is at most ambiguous (could be a re-scraped twin)', () => {
  const rows = [
    row({ id: 'a', txnIdentifier: '42', chargedAmount: -90, createdAt: new Date('2026-09-03T04:00:00.000Z') }),
    row({ id: 'b', txnIdentifier: '42', chargedAmount: -90, createdAt: new Date('2026-09-04T04:00:00.000Z') }),
  ];
  const candidates = detectSameSignRefundCandidates(rows);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.refundId, 'b');
  assert.equal(candidates[0]!.confidence, 'ambiguous');
});

test('never reports: larger amount, earlier date, other account, other currency, positive, already-marked, hidden', () => {
  const purchase = row({ id: 'p', txnIdentifier: '1', description: 'PASTABAR', chargedAmount: -250 });
  const later = new Date('2026-09-05T21:00:00.000Z');
  const rows = [
    purchase,
    row({ txnIdentifier: '1', description: 'PASTABAR', chargedAmount: -300, date: later }),
    row({ txnIdentifier: '1', description: 'PASTABAR', chargedAmount: -125, date: new Date('2026-08-30T21:00:00.000Z') }),
    row({ accountId: 'other', txnIdentifier: '1', description: 'PASTABAR', chargedAmount: -125, date: later }),
    row({ txnIdentifier: '1', description: 'PASTABAR', chargedAmount: -125, chargedCurrency: 'USD', date: later }),
    row({ txnIdentifier: '1', description: 'PASTABAR', chargedAmount: 125, date: later }),
    row({ txnIdentifier: '1', description: 'PASTABAR', chargedAmount: -125, date: later, isRefund: true }),
    row({ txnIdentifier: '1', description: 'PASTABAR', chargedAmount: -125, date: later, isCardSettlement: true }),
    row({ txnIdentifier: '1', description: 'PASTABAR', chargedAmount: -125, date: later, isTransfer: true }),
  ];
  assert.deepEqual(detectSameSignRefundCandidates(rows), []);
});

test('MAX: a positive provider refund (+850 after -850) is out of scope — already handled by sign', () => {
  const rows = [
    row({ accountId: 'max', txnIdentifier: '31', description: 'KSP', chargedAmount: -850 }),
    row({ accountId: 'max', txnIdentifier: '31', description: 'KSP', chargedAmount: 850, date: new Date('2026-09-08T21:00:00.000Z') }),
  ];
  assert.deepEqual(detectSameSignRefundCandidates(rows), []);
});

test('Cal pending snapshot (no identifier, precise amount) beside its settled row is not a refund', () => {
  const day = new Date('2026-09-10T21:00:00.000Z');
  const pending = row({ accountId: 'cal', txnIdentifier: null, description: 'משיכת מזומן', chargedAmount: -99.9, date: day, processedDate: day });
  const settled = row({
    accountId: 'cal',
    txnIdentifier: '880011',
    description: 'משיכת מזומן',
    chargedAmount: -100,
    date: day,
    processedDate: new Date('2026-10-01T21:00:00.000Z'),
  });
  assert.deepEqual(detectSameSignRefundCandidates([pending, settled]), []);
  assert.deepEqual(detectSameSignRefundCandidates([{ ...pending, isCardSettlement: true }, settled]), []);
});

test('merchantsAgree ignores refund keywords, punctuation and provider truncation', () => {
  assert.equal(merchantsAgree('זיכוי - PASTABAR TLV', 'pastabar tlv'), true);
  assert.equal(merchantsAgree('פסטה בר מסעדה איטלקית בע"מ', 'פסטה בר מסעדה איטלקית'), true);
  assert.equal(merchantsAgree('PASTABAR', 'MAX STOCK'), false);
  assert.equal(merchantsAgree('זיכוי', 'ביטול'), false);
});
