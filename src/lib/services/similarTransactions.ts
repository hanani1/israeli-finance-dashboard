/**
 * "Find similar transactions" — pure matching logic (no DB access).
 *
 * Given a source transaction, ranks candidate transactions by how likely they
 * belong to the same merchant. The matching is deliberately conservative:
 *
 *  - Merchant names are normalized (lowercase, digits/punctuation stripped)
 *    so branch/terminal numbers ("סופר פארם 123" vs "סופר פארם 45") collide.
 *  - Generic banking phrases (העברה, חיוב כרטיס אשראי, transfer, atm…) carry
 *    no merchant signal. A source whose description is made only of such
 *    tokens matches nothing except transactions with the *identical* raw
 *    description — otherwise every transfer would "match" every other one.
 *  - Fuzzy matching is limited to full containment of significant tokens
 *    (branch-name variants); there is no edit-distance guessing.
 *
 * Every match carries a score in (0, 1] and human-readable reason codes so
 * the UI can explain *why* a row was included.
 */

import { absAgorot, type MoneyInput } from './money';

export type SimilarReason =
  | 'exactDescription'
  | 'sameMerchant'
  | 'sharedTokens'
  | 'similarAmount'
  | 'sameCategory';

export interface SimilarSource {
  id: string;
  description: string;
  chargedAmount: MoneyInput;
  categoryId: number | null;
}

export interface SimilarCandidate extends SimilarSource {
  date: Date;
}

export interface SimilarScore {
  score: number;
  reasons: SimilarReason[];
}

export interface RankedMatch<T extends SimilarCandidate> {
  candidate: T;
  score: number;
  reasons: SimilarReason[];
}

export interface RankResult<T extends SimilarCandidate> {
  items: Array<RankedMatch<T>>;
  /** Total matches found (before offset/limit slicing). */
  total: number;
  hasMore: boolean;
}

/** Hebrew geresh/gershayim and ASCII quotes — stripped so בע"מ → בעמ. */
const QUOTE_CHARS = /['"`´׳״]/g;
/** Anything that is not a letter (any script) or whitespace: digits, punctuation. */
const NON_LETTER = /[^\p{L}\s]/gu;

/**
 * Tokens that describe the *kind* of banking operation rather than a
 * merchant. Descriptions made exclusively of these (plus digits/punctuation)
 * are "generic" — e.g. "העברה עצמית", "חיוב כרטיס אשראי", "משיכת מזומן",
 * "digital transfer" — and must not fuzzy-match each other.
 */
const GENERIC_TOKENS = new Set([
  // Hebrew banking vocabulary
  'העברה',
  'העברת',
  'העברות',
  'הפקדה',
  'הפקדת',
  'משיכה',
  'משיכת',
  'מזומן',
  'זיכוי',
  'חיוב',
  'תשלום',
  'תשלומים',
  'כרטיס',
  'כרטיסי',
  'אשראי',
  'ויזה',
  'מסטרקארד',
  'ישראכרט',
  'לישראכרט',
  'כאל',
  'מקס',
  'דיגיטל',
  'דיגיטלית',
  'בנקאית',
  'עצמית',
  'אינטרנט',
  'נייד',
  'שיק',
  'צק',
  'המחאה',
  'עמלה',
  'עמלת',
  'ריבית',
  'חשבון',
  'חשבונות',
  'בין',
  'אל',
  'מאת',
  'עבור',
  // English banking vocabulary
  'transfer',
  'payment',
  'deposit',
  'withdrawal',
  'atm',
  'cash',
  'credit',
  'debit',
  'card',
  'visa',
  'mastercard',
  'direct',
  'digital',
  'standing',
  'order',
  'fee',
  'interest',
  'charge',
  'bit',
  'paybox',
  // Corporate-suffix noise (carries no merchant identity on its own)
  'בעמ',
  'ltd',
  'inc',
  'llc',
  'co',
]);

/**
 * Normalize a raw bank description into a merchant string: NFKC, lowercase,
 * quotes removed, digits and punctuation replaced by spaces, whitespace
 * collapsed. "סופר-פארם ת\"א 123" → "סופר פארם תא".
 */
export function normalizeMerchant(description: string): string {
  return description
    .normalize('NFKC')
    .toLowerCase()
    .replace(QUOTE_CHARS, '')
    .replace(NON_LETTER, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Merchant-identifying tokens: normalized, ≥2 chars, not generic vocabulary. */
export function significantTokens(description: string): string[] {
  return normalizeMerchant(description)
    .split(' ')
    .filter((token) => token.length >= 2 && !GENERIC_TOKENS.has(token));
}

/**
 * True when the description carries no merchant signal (only transfer/card
 * vocabulary, digits and punctuation). Such sources only ever match
 * transactions with the identical raw description.
 */
export function isGenericDescription(description: string): boolean {
  return significantTokens(description).length === 0;
}

/**
 * The single most selective token to use as a DB `contains` pre-filter when
 * scanning for candidates, or null for generic descriptions (exact-description
 * lookup must be used instead).
 */
export function anchorToken(description: string): string | null {
  const tokens = significantTokens(description);
  if (tokens.length === 0) return null;
  return tokens.reduce((longest, token) => (token.length > longest.length ? token : longest));
}

const SCORE_EXACT = 1;
const SCORE_SAME_MERCHANT = 0.9;
const SCORE_SHARED_TOKENS = 0.75;
const BONUS_AMOUNT = 0.05;
const BONUS_CATEGORY = 0.04;
/** Non-exact matches never reach 1 even with bonuses. */
const NON_EXACT_CAP = 0.99;
/** Minimum score for a candidate to be reported at all. */
export const MIN_SCORE = SCORE_SHARED_TOKENS;

/**
 * Score a candidate against the source. Returns null when the candidate is
 * not similar (or is the source itself).
 */
export function scoreSimilarity(
  source: SimilarSource,
  candidate: SimilarSource,
): SimilarScore | null {
  if (candidate.id === source.id) return null;

  const sourceDesc = source.description.trim();
  const candidateDesc = candidate.description.trim();
  const reasons: SimilarReason[] = [];
  let score: number;

  if (sourceDesc === candidateDesc && sourceDesc.length > 0) {
    score = SCORE_EXACT;
    reasons.push('exactDescription');
  } else if (isGenericDescription(sourceDesc)) {
    // Generic transfer/card strings must not fuzzy-match everything.
    return null;
  } else {
    const sourceTokens = significantTokens(sourceDesc);
    const candidateTokens = significantTokens(candidateDesc);
    if (candidateTokens.length === 0) return null;

    if (sourceTokens.join(' ') === candidateTokens.join(' ')) {
      // Same merchant once branch numbers / punctuation are stripped.
      score = SCORE_SAME_MERCHANT;
      reasons.push('sameMerchant');
    } else {
      // Conservative containment: every significant token of the shorter side
      // appears in the longer side (branch-name variants such as
      // "סופר פארם" vs "סופר פארם מרכז העיר"), with a substance requirement so
      // a single short token cannot pull in unrelated merchants.
      const [shorter, longer] =
        sourceTokens.length <= candidateTokens.length
          ? [sourceTokens, candidateTokens]
          : [candidateTokens, sourceTokens];
      const longerSet = new Set(longer);
      const contained = shorter.every((token) => longerSet.has(token));
      const substantive = shorter.length >= 2 || shorter.some((token) => token.length >= 4);
      if (!contained || !substantive) return null;
      score = SCORE_SHARED_TOKENS;
      reasons.push('sharedTokens');
    }
  }

  if (absAgorot(source.chargedAmount) === absAgorot(candidate.chargedAmount)) {
    reasons.push('similarAmount');
    if (score < SCORE_EXACT) score = Math.min(NON_EXACT_CAP, score + BONUS_AMOUNT);
  }
  if (source.categoryId !== null && source.categoryId === candidate.categoryId) {
    reasons.push('sameCategory');
    if (score < SCORE_EXACT) score = Math.min(NON_EXACT_CAP, score + BONUS_CATEGORY);
  }

  return { score, reasons };
}

export const SIMILAR_LIMIT_DEFAULT = 20;
export const SIMILAR_LIMIT_MAX = 50;
export const SIMILAR_OFFSET_MAX = 500;

export interface Pagination {
  limit: number;
  offset: number;
}

/**
 * Clamp client-supplied pagination to safe bounds. Non-numeric / missing
 * values fall back to defaults; out-of-range values are clamped, never
 * rejected, so the endpoint stays bounded regardless of input.
 */
export function clampPagination(limitRaw?: string | null, offsetRaw?: string | null): Pagination {
  const limitParsed = Number.parseInt(limitRaw ?? '', 10);
  const offsetParsed = Number.parseInt(offsetRaw ?? '', 10);
  const limit = Number.isNaN(limitParsed)
    ? SIMILAR_LIMIT_DEFAULT
    : Math.min(Math.max(limitParsed, 1), SIMILAR_LIMIT_MAX);
  const offset = Number.isNaN(offsetParsed)
    ? 0
    : Math.min(Math.max(offsetParsed, 0), SIMILAR_OFFSET_MAX);
  return { limit, offset };
}

/**
 * Score, filter, and order candidates, then apply bounded pagination.
 * Ordering: score desc, then date desc, then id asc (stable).
 */
export function rankSimilar<T extends SimilarCandidate>(
  source: SimilarSource,
  candidates: T[],
  pagination: Pagination,
): RankResult<T> {
  const matches: Array<RankedMatch<T>> = [];
  for (const candidate of candidates) {
    const result = scoreSimilarity(source, candidate);
    if (result && result.score >= MIN_SCORE) {
      matches.push({ candidate, score: result.score, reasons: result.reasons });
    }
  }
  matches.sort(
    (a, b) =>
      b.score - a.score ||
      b.candidate.date.getTime() - a.candidate.date.getTime() ||
      a.candidate.id.localeCompare(b.candidate.id),
  );
  const items = matches.slice(pagination.offset, pagination.offset + pagination.limit);
  return {
    items,
    total: matches.length,
    hasMore: pagination.offset + pagination.limit < matches.length,
  };
}
