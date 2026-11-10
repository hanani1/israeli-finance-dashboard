import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import {
  detectObsoletePendingSnapshots,
  isPendingSnapshotDescription,
  matchCoveredSettlements,
  pendingSnapshotsToHide,
  settlementProviderFor,
  type CardCycleTxn,
  type PendingSnapshotCandidate,
  type SettlementCandidate,
} from './cardSettlementDetection';

function settlement(
  id: string,
  date: string,
  chargedAmount: number,
  description: string,
): SettlementCandidate {
  return { id, date: new Date(date), chargedAmount, description };
}

function cardTxn(
  accountId: string,
  provider: string,
  processedDate: string | null,
  chargedAmount: number,
): CardCycleTxn {
  return {
    accountId,
    provider,
    processedDate: processedDate ? new Date(processedDate) : null,
    chargedAmount,
  };
}

test('settlementProviderFor recognizes Max, Isracard and Cal bank debits', () => {
  assert.equal(settlementProviderFor('מקס איט פיננ-י'), 'max');
  assert.equal(settlementProviderFor('ישראכרט בע"מ-י'), 'isracard');
  assert.equal(settlementProviderFor('ל.מאסטרקרד(יש)'), 'isracard');
  assert.equal(settlementProviderFor('ל.מאסטרקארד'), 'isracard');
  assert.equal(settlementProviderFor('ל.מסטרקארד__'), 'isracard');
  // Discount's bank-side description for the monthly Cal statement debit.
  assert.equal(settlementProviderFor('כ.א.ל חיוב'), 'visaCal');
  // Cal *pending* snapshots are forecasts handled separately, never settlements.
  assert.equal(settlementProviderFor('חיוב לכרטיס מכאל 3333'), null);
  assert.equal(settlementProviderFor('שופרסל דיל'), null);
});

test('marks a settlement covered by a matching card cycle (real Max shape)', () => {
  // Bank: מקס debit of ₪1,077.40 on 2026-08-09; card account 1111 has a cycle
  // (processedDate 2026-08-09) summing to exactly -1,077.40.
  const matches = matchCoveredSettlements(
    [settlement('s1', '2026-08-09T00:00:00Z', -1077.4, 'מקס איט פיננ-י')],
    [
      cardTxn('card1111', 'max', '2026-08-09T00:00:00Z', -1000.0),
      cardTxn('card1111', 'max', '2026-08-09T00:00:00Z', -77.4),
    ],
  );
  assert.deepEqual(matches, [{ settlementId: 's1', cardAccountId: 'card1111' }]);
});

test('leaves an uncovered settlement countable (no card history for the cycle)', () => {
  // Pre-scrape-history Max cycle: bank debit exists but the card account has
  // no rows for that charge date — the bank row is the only spending record.
  const matches = matchCoveredSettlements(
    [settlement('s1', '2024-12-09T00:00:00Z', -13193, 'מקס איט פיננ-י')],
    [cardTxn('card1111', 'max', '2026-08-09T00:00:00Z', -1077.4)],
  );
  assert.deepEqual(matches, []);
});

test('never marks Cal pending snapshots even when amounts coincide', () => {
  const matches = matchCoveredSettlements(
    [settlement('s1', '2026-08-03T00:00:00Z', -6000.38, 'חיוב לכרטיס מכאל 3333')],
    [cardTxn('cardX', 'visaCal', '2026-08-03T00:00:00Z', -6000.38)],
  );
  assert.deepEqual(matches, []);
});

test('marks the monthly Cal statement debit when a visaCal card cycle exists (real Discount shape)', () => {
  const matches = matchCoveredSettlements(
    [settlement('s1', '2026-09-01T00:00:00Z', -12486.93, 'כ.א.ל חיוב')],
    [
      cardTxn('cal3333', 'visaCal', '2026-09-01T00:00:00Z', -12000),
      cardTxn('cal3333', 'visaCal', '2026-09-01T00:00:00Z', -486.93),
    ],
  );
  assert.deepEqual(matches, [{ settlementId: 's1', cardAccountId: 'cal3333' }]);
});

test('leaves Cal statement debits countable when no visaCal card account is scraped', () => {
  // Without card history there is nothing to double count against.
  const matches = matchCoveredSettlements(
    [settlement('s1', '2026-09-01T00:00:00Z', -12486.93, 'כ.א.ל חיוב')],
    [cardTxn('max1', 'max', '2026-09-01T00:00:00Z', -12486.93)],
  );
  assert.deepEqual(matches, []);
});

test('marks an anchored settlement when a provider cycle has partial history', () => {
  // August shape: bank has ₪8,140.60, while card •4444 has 79 detailed
  // rows totaling ₪9,541.19. Presence in the anchored billing cycle is enough.
  const matches = matchCoveredSettlements(
    [settlement('s1', '2026-08-09T21:00:00Z', -8140.6, 'ל.מאסטרקרד(יש)')],
    [
      cardTxn('card4444', 'isracard', '2026-08-09T21:00:00Z', -9000),
      cardTxn('card4444', 'isracard', '2026-08-09T21:00:00Z', -541.19),
    ],
  );
  assert.deepEqual(matches, [{ settlementId: 's1', cardAccountId: 'card4444' }]);
});

test('requires issuer agreement between settlement and cycle', () => {
  // An isracard cycle must not cover a Max settlement of the same amount.
  const matches = matchCoveredSettlements(
    [settlement('s1', '2026-08-09T00:00:00Z', -944.8, 'מקס איט פיננ-י')],
    [cardTxn('card5555', 'isracard', '2026-08-09T00:00:00Z', -944.8)],
  );
  assert.deepEqual(matches, []);
});

test('allows a small bank-posting lag but rejects far-off dates', () => {
  // Real shape: bank posts on Jan 10 for a cycle charged Jan 9.
  const near = matchCoveredSettlements(
    [settlement('s1', '2026-01-10T00:00:00Z', -2688, 'מקס איט פיננ-י')],
    [cardTxn('card1111', 'max', '2026-01-09T00:00:00Z', -2688)],
  );
  assert.deepEqual(near, [{ settlementId: 's1', cardAccountId: 'card1111' }]);

  const far = matchCoveredSettlements(
    [settlement('s1', '2026-01-20T00:00:00Z', -2688, 'מקס איט פיננ-י')],
    [cardTxn('card1111', 'max', '2026-01-09T00:00:00Z', -2688)],
  );
  assert.deepEqual(far, []);
});

test('one-to-one: two same-day settlements match their own card cycles', () => {
  // Real shape: two Max cards settle on the same bank date with different sums.
  const matches = matchCoveredSettlements(
    [
      settlement('s1', '2026-08-09T00:00:00Z', -1077.4, 'מקס איט פיננ-י'),
      settlement('s2', '2026-08-09T00:00:00Z', -66.79, 'מקס איט פיננ-י'),
    ],
    [
      cardTxn('card1111', 'max', '2026-08-09T00:00:00Z', -1077.4),
      cardTxn('card2222', 'max', '2026-08-09T00:00:00Z', -66.79),
    ],
  );
  assert.equal(matches.length, 2);
  assert.ok(matches.some((m) => m.settlementId === 's1' && m.cardAccountId === 'card1111'));
  assert.ok(matches.some((m) => m.settlementId === 's2' && m.cardAccountId === 'card2222'));
});

test('a single cycle never covers two settlements', () => {
  const matches = matchCoveredSettlements(
    [
      settlement('s1', '2026-08-09T00:00:00Z', -500, 'מקס איט פיננ-י'),
      settlement('s2', '2026-08-10T00:00:00Z', -500, 'מקס איט פיננ-י'),
    ],
    [cardTxn('card1111', 'max', '2026-08-09T00:00:00Z', -500)],
  );
  // Closest date wins; the other settlement stays countable.
  assert.deepEqual(matches, [{ settlementId: 's1', cardAccountId: 'card1111' }]);
});

test('ignores positive (refund) settlements and net-positive cycles', () => {
  const matches = matchCoveredSettlements(
    [settlement('s1', '2026-08-09T00:00:00Z', 250, 'מקס איט פיננ-י')],
    [cardTxn('card1111', 'max', '2026-08-09T00:00:00Z', 250)],
  );
  assert.deepEqual(matches, []);
});

function snapshot(
  id: string,
  accountId: string,
  date: string,
  description: string,
  createdAt: string,
): PendingSnapshotCandidate {
  return {
    id,
    accountId,
    date: new Date(date),
    description,
    createdAt: new Date(createdAt),
  };
}

test('marks all but the latest-scraped Cal pending snapshot (real shape)', () => {
  // Real shape: five revisions of the same upcoming Cal charge on Discount,
  // same date + description, different amounts, distinguishable by createdAt.
  const obsolete = detectObsoletePendingSnapshots([
    snapshot('a', 'discount', '2026-08-03T00:00:00Z', 'חיוב לכרטיס מכאל 3333', '2026-08-10T21:54:37Z'),
    snapshot('b', 'discount', '2026-08-03T00:00:00Z', 'חיוב לכרטיס מכאל 3333', '2026-08-16T22:28:14Z'),
    snapshot('c', 'discount', '2026-08-03T00:00:00Z', 'חיוב לכרטיס מכאל 3333', '2026-08-18T06:17:03Z'),
    snapshot('d', 'discount', '2026-08-03T00:00:00Z', 'חיוב לכרטיס מכאל 3333', '2026-08-29T23:02:00Z'),
    snapshot('e', 'discount', '2026-08-03T00:00:00Z', 'חיוב לכרטיס מכאל 3333', '2026-09-01T01:01:19Z'),
  ]);
  // Latest snapshot 'e' stays countable; the four superseded revisions do not.
  assert.deepEqual(obsolete.sort(), ['a', 'b', 'c', 'd']);
});

test('a lone pending snapshot is never marked', () => {
  const obsolete = detectObsoletePendingSnapshots([
    snapshot('a', 'discount', '2026-08-03T00:00:00Z', 'חיוב לכרטיס מכאל 3333', '2026-08-10T00:00:00Z'),
  ]);
  assert.deepEqual(obsolete, []);
});

test('snapshots on different dates or accounts are independent charges', () => {
  const obsolete = detectObsoletePendingSnapshots([
    snapshot('a', 'discount', '2026-07-03T00:00:00Z', 'חיוב לכרטיס מכאל 3333', '2026-07-10T00:00:00Z'),
    snapshot('b', 'discount', '2026-08-03T00:00:00Z', 'חיוב לכרטיס מכאל 3333', '2026-08-10T00:00:00Z'),
    snapshot('c', 'otherBank', '2026-08-03T00:00:00Z', 'חיוב לכרטיס מכאל 3333', '2026-08-10T00:00:00Z'),
  ]);
  assert.deepEqual(obsolete, []);
});

test('non-pending descriptions are never snapshot candidates', () => {
  assert.equal(isPendingSnapshotDescription('חיוב לכרטיס מכאל 3333'), true);
  assert.equal(isPendingSnapshotDescription('מקס איט פיננ-י'), false);
  // Contains "כאל" as a substring of a merchant name — must not match.
  assert.equal(isPendingSnapshotDescription('חנות בגדים לדוגמה'), false);
  const obsolete = detectObsoletePendingSnapshots([
    snapshot('a', 'discount', '2026-08-03T00:00:00Z', 'שופרסל דיל', '2026-08-10T00:00:00Z'),
    snapshot('b', 'discount', '2026-08-03T00:00:00Z', 'שופרסל דיל', '2026-08-16T00:00:00Z'),
  ]);
  assert.deepEqual(obsolete, []);
});

test('createdAt ties break deterministically by id', () => {
  const obsolete = detectObsoletePendingSnapshots([
    snapshot('b', 'discount', '2026-08-03T00:00:00Z', 'חיוב לכרטיס מכאל 3333', '2026-08-10T00:00:00Z'),
    snapshot('a', 'discount', '2026-08-03T00:00:00Z', 'חיוב לכרטיס מכאל 3333', '2026-08-10T00:00:00Z'),
  ]);
  // Same createdAt: lowest id survives; the other is obsolete.
  assert.deepEqual(obsolete, ['b']);
});

test('prefers exact account totals before partial-history fallback', () => {
  const matches = matchCoveredSettlements(
    [
      settlement('large', '2026-08-09T21:00:00Z', -8140.6, 'ל.מאסטרקרד(יש)'),
      settlement('small', '2026-08-09T21:00:00Z', -944.8, 'ישראכרט בע"מ-י'),
    ],
    [
      cardTxn('card4444', 'isracard', '2026-08-09T21:00:00Z', -9541.19),
      cardTxn('card5555', 'isracard', '2026-08-09T21:00:00Z', -944.8),
    ],
  );
  assert.ok(matches.some((match) => match.settlementId === 'small' && match.cardAccountId === 'card5555'));
  assert.ok(matches.some((match) => match.settlementId === 'large' && match.cardAccountId === 'card4444'));
});

test('pendingSnapshotsToHide: with detailed Cal rows every forecast snapshot is hidden (the card purchases are counted instead)', () => {
  const snapshots = [
    { id: 'a', accountId: 'bank', date: new Date('2026-09-02T21:00:00.000Z'), description: 'חיוב לכרטיס מכאל 3333', createdAt: new Date('2026-09-04T00:00:00.000Z') },
    { id: 'b', accountId: 'bank', date: new Date('2026-09-02T21:00:00.000Z'), description: 'חיוב לכרטיס מכאל 3333', createdAt: new Date('2026-10-02T00:00:00.000Z') },
    { id: 'c', accountId: 'bank', date: new Date('2026-09-02T21:00:00.000Z'), description: 'משיכת שיק', createdAt: new Date('2026-10-02T00:00:00.000Z') },
  ];
  assert.deepEqual(pendingSnapshotsToHide(snapshots, { hasDetailedCalRows: true }).sort(), ['a', 'b']);
});

test('pendingSnapshotsToHide: without detailed Cal rows only stale snapshots are hidden, the newest forecast stays visible', () => {
  const snapshots = [
    { id: 'a', accountId: 'bank', date: new Date('2026-09-02T21:00:00.000Z'), description: 'חיוב לכרטיס מכאל 3333', createdAt: new Date('2026-09-04T00:00:00.000Z') },
    { id: 'b', accountId: 'bank', date: new Date('2026-09-02T21:00:00.000Z'), description: 'חיוב לכרטיס מכאל 3333', createdAt: new Date('2026-10-02T00:00:00.000Z') },
  ];
  assert.deepEqual(pendingSnapshotsToHide(snapshots, { hasDetailedCalRows: false }), ['a']);
});

test('cycle sums are exact agorot, so the exact-amount edge wins over float drift (card #53)', () => {
  // Ten 0.1 rows: a float sum is 0.9999999999999999, the cycle is exactly 1.00.
  const tenths = Array.from({ length: 10 }, () => cardTxn('cardA', 'max', '2026-08-09T00:00:00Z', -0.1));
  const matches = matchCoveredSettlements(
    [
      { id: 's-exact', date: new Date('2026-08-09T00:00:00Z'), chargedAmount: new Prisma.Decimal('-1.00'), description: 'מקס איט פיננ-י' },
      settlement('s-other', '2026-08-09T00:00:00Z', -1.01, 'מקס איט פיננ-י'),
    ],
    tenths,
  );
  assert.deepEqual(matches, [{ settlementId: 's-exact', cardAccountId: 'cardA' }]);
});
