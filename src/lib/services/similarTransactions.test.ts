import assert from 'node:assert/strict';
import test from 'node:test';
import {
  anchorToken,
  clampPagination,
  isGenericDescription,
  normalizeMerchant,
  rankSimilar,
  scoreSimilarity,
  SIMILAR_LIMIT_DEFAULT,
  SIMILAR_LIMIT_MAX,
  SIMILAR_OFFSET_MAX,
  type SimilarCandidate,
  type SimilarSource,
} from './similarTransactions';

const src = (overrides: Partial<SimilarSource> = {}): SimilarSource => ({
  id: 'src',
  description: 'סופר פארם רמת אביב 123',
  chargedAmount: -50,
  categoryId: 1,
  ...overrides,
});

let seq = 0;
const cand = (
  description: string,
  overrides: Partial<SimilarCandidate> = {},
): SimilarCandidate => ({
  id: `cand-${++seq}`,
  description,
  chargedAmount: -80,
  categoryId: null,
  date: new Date('2026-08-01T00:00:00Z'),
  ...overrides,
});

// --- normalizeMerchant ---

test('normalizeMerchant strips digits, punctuation and quotes and lowercases', () => {
  assert.equal(normalizeMerchant('סופר-פארם ת"א 123'), 'סופר פארם תא');
  assert.equal(normalizeMerchant('  SUPER-PHARM #45  '), 'super pharm');
  assert.equal(normalizeMerchant('שופרסל בע"מ'), 'שופרסל בעמ');
});

test('normalizeMerchant collapses whitespace', () => {
  assert.equal(normalizeMerchant('a   b\t c'), 'a b c');
});

// --- isGenericDescription ---

test('generic Hebrew transfer/card strings are detected as generic', () => {
  assert.equal(isGenericDescription('העברה עצמית'), true);
  assert.equal(isGenericDescription('העברה בנקאית 123'), true);
  assert.equal(isGenericDescription('חיוב כרטיס אשראי'), true);
  assert.equal(isGenericDescription('משיכת מזומן'), true);
  assert.equal(isGenericDescription('העברה בין חשבונות'), true);
});

test('generic English transfer/card strings are detected as generic', () => {
  assert.equal(isGenericDescription('Digital Transfer'), true);
  assert.equal(isGenericDescription('ATM cash withdrawal'), true);
  assert.equal(isGenericDescription('VISA card payment'), true);
});

test('real merchant names are not generic', () => {
  assert.equal(isGenericDescription('סופר פארם'), false);
  assert.equal(isGenericDescription('שופרסל דיל רמת אביב'), false);
  assert.equal(isGenericDescription('העברה אל: אלטשולר שחם'), false); // carries a merchant
});

// --- anchorToken ---

test('anchorToken picks the longest significant token', () => {
  assert.equal(anchorToken('סופר פארם רמת אביב'), 'סופר');
  assert.equal(anchorToken('העברה אל אלטשולר'), 'אלטשולר');
});

test('anchorToken is null for generic descriptions', () => {
  assert.equal(anchorToken('העברה עצמית 123'), null);
});

// --- scoreSimilarity ---

test('identical description scores 1 with exactDescription reason', () => {
  const source = src();
  const result = scoreSimilarity(source, cand(source.description));
  assert.ok(result);
  assert.equal(result.score, 1);
  assert.ok(result.reasons.includes('exactDescription'));
});

test('same merchant with different branch number scores as sameMerchant', () => {
  const result = scoreSimilarity(src(), cand('סופר פארם רמת אביב 456'));
  assert.ok(result);
  assert.ok(result.reasons.includes('sameMerchant'));
  assert.ok(result.score >= 0.9 && result.score < 1);
});

test('branch-name variant matches via sharedTokens containment', () => {
  const result = scoreSimilarity(
    src({ description: 'סופר פארם' }),
    cand('סופר פארם דיזנגוף סנטר'),
  );
  assert.ok(result);
  assert.ok(result.reasons.includes('sharedTokens'));
});

test('different merchants sharing one token do not match', () => {
  const result = scoreSimilarity(src({ description: 'סופר פארם' }), cand('סופר יודה'));
  assert.equal(result, null);
});

test('unrelated merchants do not match', () => {
  assert.equal(scoreSimilarity(src(), cand('קפה לדוגמה תל אביב')), null);
});

test('generic source does NOT match other transfers with different text', () => {
  const source = src({ description: 'העברה עצמית' });
  // Same amount, both transfer-like — still must not match.
  assert.equal(scoreSimilarity(source, cand('העברה בנקאית', { chargedAmount: -50 })), null);
  assert.equal(scoreSimilarity(source, cand('העברה דיגיטל')), null);
});

test('generic source still matches the identical raw description', () => {
  const source = src({ description: 'העברה עצמית' });
  const result = scoreSimilarity(source, cand('העברה עצמית'));
  assert.ok(result);
  assert.equal(result.score, 1);
  assert.deepEqual(result.reasons.slice(0, 1), ['exactDescription']);
});

test('generic card-charge strings do not fuzzy-match each other', () => {
  const source = src({ description: 'חיוב כרטיס ויזה' });
  assert.equal(scoreSimilarity(source, cand('חיוב כרטיס מסטרקארד')), null);
});

test('candidate with no significant tokens never matches a merchant source', () => {
  assert.equal(scoreSimilarity(src(), cand('העברה עצמית')), null);
});

test('same amount and same category add reasons and bounded bonuses', () => {
  const source = src({ chargedAmount: -49.9, categoryId: 7 });
  const result = scoreSimilarity(
    source,
    cand('סופר פארם רמת אביב 456', { chargedAmount: -49.9, categoryId: 7 }),
  );
  assert.ok(result);
  assert.ok(result.reasons.includes('similarAmount'));
  assert.ok(result.reasons.includes('sameCategory'));
  assert.ok(result.score < 1, 'non-exact match must stay below 1 even with bonuses');
});

test('uncategorized source (null category) gets no sameCategory reason', () => {
  const source = src({ categoryId: null });
  const result = scoreSimilarity(source, cand('סופר פארם רמת אביב 456', { categoryId: null }));
  assert.ok(result);
  assert.equal(result.reasons.includes('sameCategory'), false);
});

test('the source transaction itself never matches', () => {
  const source = src();
  const self: SimilarCandidate = { ...source, date: new Date() };
  assert.equal(scoreSimilarity(source, self), null);
});

// --- clampPagination ---

test('clampPagination falls back to defaults for missing/garbage input', () => {
  assert.deepEqual(clampPagination(undefined, undefined), {
    limit: SIMILAR_LIMIT_DEFAULT,
    offset: 0,
  });
  assert.deepEqual(clampPagination('abc', 'xyz'), { limit: SIMILAR_LIMIT_DEFAULT, offset: 0 });
});

test('clampPagination clamps out-of-range values', () => {
  assert.deepEqual(clampPagination('9999', '99999'), {
    limit: SIMILAR_LIMIT_MAX,
    offset: SIMILAR_OFFSET_MAX,
  });
  assert.deepEqual(clampPagination('-5', '-10'), { limit: 1, offset: 0 });
});

test('clampPagination accepts in-range values', () => {
  assert.deepEqual(clampPagination('10', '30'), { limit: 10, offset: 30 });
});

// --- rankSimilar ---

test('rankSimilar orders by score then date desc and reports total/hasMore', () => {
  const source = src();
  const exact = cand(source.description, { date: new Date('2026-07-01T00:00:00Z') });
  const merchant = cand('סופר פארם רמת אביב 999', { date: new Date('2026-08-10T00:00:00Z') });
  const newerExact = cand(source.description, { date: new Date('2026-08-20T00:00:00Z') });
  const noise = cand('קפה לדוגמה');
  const result = rankSimilar(source, [noise, merchant, exact, newerExact], {
    limit: 2,
    offset: 0,
  });
  assert.equal(result.total, 3);
  assert.equal(result.hasMore, true);
  assert.deepEqual(
    result.items.map((m) => m.candidate.id),
    [newerExact.id, exact.id], // both exact (score 1), newest first
  );
});

test('rankSimilar applies offset and marks the end of results', () => {
  const source = src();
  const a = cand(source.description);
  const b = cand(source.description);
  const result = rankSimilar(source, [a, b], { limit: 10, offset: 1 });
  assert.equal(result.items.length, 1);
  assert.equal(result.hasMore, false);
});

test('rankSimilar returns empty result when nothing matches', () => {
  const result = rankSimilar(src(), [cand('קפה לדוגמה'), cand('העברה עצמית')], {
    limit: 10,
    offset: 0,
  });
  assert.deepEqual(result, { items: [], total: 0, hasMore: false });
});
