import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import {
  isTransferLikeDescription,
  pairTransfers,
  type TransferCandidate,
} from './transferDetection';

function txn(
  id: string,
  accountId: string,
  date: string,
  chargedAmount: number,
  description: string,
): TransferCandidate {
  return { id, accountId, date: new Date(date), chargedAmount, description };
}

test('pairs opposite amounts across different accounts within the window', () => {
  const pairs = pairTransfers([
    txn('out1', 'leumi', '2026-08-05T00:00:00Z', -10000, 'העברה דיגיטל'),
    txn('in1', 'discount', '2026-08-05T00:00:00Z', 10000, 'העברה מישראל ישראלי חשבון 10'),
  ]);
  assert.deepEqual(pairs, [{ outflowId: 'out1', inflowId: 'in1' }]);
});

test('never pairs transactions on the same account', () => {
  const pairs = pairTransfers([
    txn('out1', 'leumi', '2026-08-05T00:00:00Z', -500, 'העברה'),
    txn('in1', 'leumi', '2026-08-05T00:00:00Z', 500, 'העברה'),
  ]);
  assert.deepEqual(pairs, []);
});

test('rejects date gaps larger than the ±3 day window', () => {
  const pairs = pairTransfers([
    txn('out1', 'leumi', '2026-08-01T00:00:00Z', -500, 'העברה'),
    txn('in1', 'discount', '2026-08-05T00:00:00Z', 500, 'העברה'),
  ]);
  assert.deepEqual(pairs, []);
});

test('accepts a gap of exactly 3 days', () => {
  const pairs = pairTransfers([
    txn('out1', 'leumi', '2026-08-01T00:00:00Z', -500, 'העברת כספים'),
    txn('in1', 'discount', '2026-08-04T00:00:00Z', 500, 'העברה בין חשבונות'),
  ]);
  assert.deepEqual(pairs, [{ outflowId: 'out1', inflowId: 'in1' }]);
});

test('requires BOTH descriptions to be transfer-like (real false-positive shapes)', () => {
  // Shapes modelled on provider data: a fee vs. a grant with the same amount, and a
  // cash withdrawal vs. an unrelated incoming transfer.
  const feeVsGrant = pairTransfers([
    txn('out1', 'discount', '2026-03-30T00:00:00Z', -9.9, 'עמלת הקצאת אשראי מט"י-יחיד'),
    txn('in1', 'leumi', '2026-04-02T00:00:00Z', 9.9, 'מענק בנק לאומי'),
  ]);
  assert.deepEqual(feeVsGrant, []);

  const withdrawalVsIncoming = pairTransfers([
    txn('out1', 'leumi', '2026-06-10T00:00:00Z', -5000, 'משיכת מזומן'),
    txn('in1', 'discount', '2026-06-13T00:00:00Z', 5000, 'העברה מרחל כהן קו חשבון'),
  ]);
  assert.deepEqual(withdrawalVsIncoming, []);
});

test('requires exact opposite amounts', () => {
  const pairs = pairTransfers([
    txn('out1', 'leumi', '2026-08-05T00:00:00Z', -1000, 'העברה'),
    txn('in1', 'discount', '2026-08-05T00:00:00Z', 999.99, 'העברה'),
  ]);
  assert.deepEqual(pairs, []);
});

test('one-to-one: a single inflow is never claimed by two outflows', () => {
  const pairs = pairTransfers([
    txn('out1', 'leumi', '2026-08-04T00:00:00Z', -500, 'העברה'),
    txn('out2', 'max', '2026-08-05T00:00:00Z', -500, 'העברה'),
    txn('in1', 'discount', '2026-08-05T00:00:00Z', 500, 'העברה'),
  ]);
  // Same-day out2 wins (closest gap); out1 stays unpaired.
  assert.deepEqual(pairs, [{ outflowId: 'out2', inflowId: 'in1' }]);
});

test('prefers the closest date among multiple inflow candidates', () => {
  const pairs = pairTransfers([
    txn('out1', 'leumi', '2026-08-05T00:00:00Z', -500, 'העברה'),
    txn('inFar', 'discount', '2026-08-07T00:00:00Z', 500, 'העברה'),
    txn('inNear', 'discount', '2026-08-05T00:00:00Z', 500, 'העברה'),
  ]);
  assert.deepEqual(pairs, [{ outflowId: 'out1', inflowId: 'inNear' }]);
});

test('pairs two independent transfers simultaneously', () => {
  const pairs = pairTransfers([
    txn('outA', 'leumi', '2026-08-01T00:00:00Z', -1000, 'העברה דיגיטל'),
    txn('inA', 'discount', '2026-08-01T00:00:00Z', 1000, 'העברה מדוד'),
    txn('outB', 'discount', '2026-08-10T00:00:00Z', -250, 'העברה בין חשבונות'),
    txn('inB', 'leumi', '2026-08-11T00:00:00Z', 250, 'העברה'),
  ]);
  assert.equal(pairs.length, 2);
  assert.ok(pairs.some((p) => p.outflowId === 'outA' && p.inflowId === 'inA'));
  assert.ok(pairs.some((p) => p.outflowId === 'outB' && p.inflowId === 'inB'));
});

test('isTransferLikeDescription matches Hebrew and English transfer wording', () => {
  assert.equal(isTransferLikeDescription('העברה בין חשבונות'), true);
  assert.equal(isTransferLikeDescription('העברת משכורת'), true);
  assert.equal(isTransferLikeDescription('BANK TRANSFER OUT'), true);
  assert.equal(isTransferLikeDescription('שופרסל דיל'), false);
  assert.equal(isTransferLikeDescription('משיכת מזומן'), false);
});

test('pairs a Prisma Decimal outflow with its inflow exactly, float noise included (card #53)', () => {
  const pairs = pairTransfers([
    { id: 'out1', accountId: 'leumi', date: new Date('2026-08-05T00:00:00Z'), chargedAmount: new Prisma.Decimal('-300.00'), description: 'העברה לחשבון' },
    // A legacy float sum: (0.1 + 0.2) * 1000 === 300.00000000000006.
    txn('in1', 'discount', '2026-08-06T00:00:00Z', (0.1 + 0.2) * 1000, 'העברה מחשבון'),
    // One agora apart is a different amount.
    { id: 'in2', accountId: 'discount', date: new Date('2026-08-05T00:00:00Z'), chargedAmount: new Prisma.Decimal('300.01'), description: 'העברה מחשבון' },
  ]);
  assert.deepEqual(pairs, [{ outflowId: 'out1', inflowId: 'in1' }]);
});
