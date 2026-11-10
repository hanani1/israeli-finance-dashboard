/**
 * Review-first detector for SAME-SIGN provider refunds (pure, unit-tested).
 * Card #60, ADR-0024.
 *
 * Some providers report a refund / partial reversal with the same sign as the
 * purchase (Pasta Bar: a -₪250 purchase followed by a -₪125 reversal). The raw
 * row is correct provider data and must stay as-is; the user marks it
 * `isRefund` so it counts as +|amount| income. This module only PROPOSES such
 * rows — it never marks anything. Callers print the result for a human.
 *
 * A pair (original O, candidate R) is considered only when all hold:
 *  - both visible (not a transfer, not a hidden settlement/pending snapshot),
 *    both negative, neither already marked isRefund;
 *  - same account and settlement currency;
 *  - merchant text agrees after stripping refund keywords and punctuation
 *    (prefix match covers provider truncation);
 *  - |R| ≤ |O| and R is not before O (date, and processedDate when both have
 *    one), within MAX_REFUND_DAY_GAP days.
 *
 * Those conditions alone describe a second legitimate purchase at the same
 * merchant, so a pair is only reported with positive EVIDENCE:
 *  - `shared-identifier`: both carry the same normalized provider identifier
 *    and R is a partial amount (|R| < |O|) within MAX_IDENTIFIER_DAY_GAP days —
 *    a provider revision of the same transaction. (A monthly standing order
 *    reuses its identifier ≥ 22 days apart, hence the short window.) An
 *    equal-amount same-identifier pair could be a re-scraped twin, so it is
 *    reported as ambiguous at most.
 *  - `refund-keyword`: R's description/memo says זיכוי / ביטול / refund /
 *    reversal and O's does not.
 *
 * Confidence: `likely` when exactly one original qualifies, the amount is a
 * strict partial and R is not itself an original of another candidate;
 * otherwise `ambiguous`. Both are review-only.
 */
import { normalizeCurrency } from './currencyDisplay';
import { localCalendarDay } from './localDay';
import { toAgorot, type MoneyInput } from './money';
import { normalizeTxnIdentifier } from './pendingSettlement';

export interface RefundCandidateRow {
  id: string;
  accountId: string;
  txnIdentifier: string | null;
  date: Date;
  processedDate: Date | null;
  chargedAmount: MoneyInput;
  chargedCurrency: string | null;
  description: string;
  memo: string | null;
  createdAt: Date;
  isRefund: boolean;
  isTransfer: boolean;
  isCardSettlement: boolean;
}

export type RefundEvidence = 'shared-identifier' | 'refund-keyword';
export type RefundConfidence = 'likely' | 'ambiguous';

export interface RefundCandidate {
  /** Row that may be a same-sign refund (would be marked isRefund). */
  refundId: string;
  /** Possible original purchases, strongest evidence / closest date first. */
  originalIds: string[];
  /** Evidence supporting the best original. */
  evidence: RefundEvidence[];
  confidence: RefundConfidence;
}

/** Outer bound for a refund after its purchase. */
export const MAX_REFUND_DAY_GAP = 90;
/** Same-identifier revisions must be close; standing orders recur ≥ 22 days apart. */
export const MAX_IDENTIFIER_DAY_GAP = 14;
/** Shortest normalized merchant text accepted for a prefix match. */
const MIN_PREFIX_LENGTH = 4;

// Deliberately narrow: "החזר" alone is avoided ("החזר הלוואה" is a loan
// repayment — an expense), as is "credit" ("credit card payment").
const REFUND_KEYWORDS = ['זיכוי', 'ביטול עסקה', 'ביטול', 'refund', 'reversal', 'reversed'];

function dayNumber(date: Date): number {
  return Date.parse(`${localCalendarDay(date)}T00:00:00Z`) / 86_400_000;
}

export function hasRefundKeyword(text: string | null | undefined): boolean {
  const lower = (text ?? '').toLowerCase();
  return REFUND_KEYWORDS.some((keyword) => lower.includes(keyword));
}

/** Lowercase, drop refund keywords and punctuation, collapse whitespace. */
export function normalizeMerchant(text: string): string {
  let out = text.toLowerCase();
  for (const keyword of REFUND_KEYWORDS) out = out.split(keyword).join(' ');
  return out
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function merchantsAgree(a: string, b: string): boolean {
  const x = normalizeMerchant(a);
  const y = normalizeMerchant(b);
  if (x === '' || y === '') return false;
  if (x === y) return true;
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  return shorter.length >= MIN_PREFIX_LENGTH && longer.startsWith(shorter);
}

function eligible(row: RefundCandidateRow): boolean {
  return !row.isTransfer && !row.isCardSettlement && toAgorot(row.chargedAmount) < 0;
}

interface Match {
  originalId: string;
  evidence: RefundEvidence[];
  gap: number;
  equalAmount: boolean;
}

function matchPair(original: RefundCandidateRow, refund: RefundCandidateRow): Match | null {
  if (original.id === refund.id || original.isRefund || refund.isRefund) return null;
  if (original.accountId !== refund.accountId) return null;
  if (normalizeCurrency(original.chargedCurrency) !== normalizeCurrency(refund.chargedCurrency)) {
    return null;
  }
  const refundCents = -toAgorot(refund.chargedAmount);
  const originalCents = -toAgorot(original.chargedAmount);
  if (refundCents > originalCents) return null;
  const equalAmount = refundCents === originalCents;

  const gap = dayNumber(refund.date) - dayNumber(original.date);
  if (gap < 0 || gap > MAX_REFUND_DAY_GAP) return null;
  if (
    original.processedDate &&
    refund.processedDate &&
    dayNumber(refund.processedDate) < dayNumber(original.processedDate)
  ) {
    return null;
  }
  // Same day + same amount: only the later-ingested row can be the refund,
  // so a symmetric pair is reported once.
  if (gap === 0 && equalAmount && refund.createdAt.getTime() <= original.createdAt.getTime()) {
    return null;
  }
  if (!merchantsAgree(original.description, refund.description)) return null;

  const evidence: RefundEvidence[] = [];
  const idO = normalizeTxnIdentifier(original.txnIdentifier);
  const idR = normalizeTxnIdentifier(refund.txnIdentifier);
  if (idO !== null && idO === idR && gap <= MAX_IDENTIFIER_DAY_GAP) {
    evidence.push('shared-identifier');
  }
  const refundSays = hasRefundKeyword(refund.description) || hasRefundKeyword(refund.memo);
  const originalSays = hasRefundKeyword(original.description) || hasRefundKeyword(original.memo);
  if (refundSays && !originalSays) evidence.push('refund-keyword');
  if (evidence.length === 0) return null;
  return { originalId: original.id, evidence, gap, equalAmount };
}

export function detectSameSignRefundCandidates(
  rows: readonly RefundCandidateRow[],
): RefundCandidate[] {
  const byAccount = new Map<string, RefundCandidateRow[]>();
  for (const row of rows) {
    if (!eligible(row)) continue;
    const list = byAccount.get(row.accountId) ?? [];
    list.push(row);
    byAccount.set(row.accountId, list);
  }

  const raw: Array<{ refundId: string; matches: Match[] }> = [];
  for (const group of byAccount.values()) {
    for (const refund of group) {
      const matches: Match[] = [];
      for (const original of group) {
        const match = matchPair(original, refund);
        if (match) matches.push(match);
      }
      if (matches.length === 0) continue;
      matches.sort(
        (a, b) =>
          b.evidence.length - a.evidence.length ||
          a.gap - b.gap ||
          a.originalId.localeCompare(b.originalId),
      );
      raw.push({ refundId: refund.id, matches });
    }
  }

  const originalIds = new Set(raw.flatMap((c) => c.matches.map((m) => m.originalId)));
  return raw
    .map(({ refundId, matches }) => {
      const best = matches[0]!;
      const likely = matches.length === 1 && !best.equalAmount && !originalIds.has(refundId);
      return {
        refundId,
        originalIds: matches.map((m) => m.originalId),
        evidence: best.evidence,
        confidence: likely ? ('likely' as const) : ('ambiguous' as const),
      };
    })
    .sort((a, b) => a.refundId.localeCompare(b.refundId));
}
