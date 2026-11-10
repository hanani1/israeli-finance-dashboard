/**
 * Inter-account transfer detection — pure pairing logic (no DB access).
 *
 * A transfer is money moved between two of the household's own registered
 * accounts: one outflow (negative chargedAmount) on the source account and one
 * inflow (positive, same absolute amount) on the destination account. Such
 * pairs are neither income nor expense and must be excluded from cash-flow
 * aggregations.
 *
 * Pairing rules (all must hold):
 *  - different accounts;
 *  - amounts are exact opposites (compared at 2-decimal precision);
 *  - dates within ±MAX_DAY_GAP_DEFAULT days (bank posting lag);
 *  - BOTH descriptions look transfer-like (העברה / transfer). This is a hard
 *    gate, not a boost: real data contains same-amount ±3-day coincidences
 *    (e.g. a ₪9.90 fee vs. a ₪9.90 grant, or a cash withdrawal vs. an
 *    unrelated third-party incoming transfer) that amount+date alone would
 *    incorrectly pair;
 *  - one-to-one: no transaction participates in more than one pair. When
 *    several candidates exist, the closest dates win.
 */

import { toAgorot, type MoneyInput } from './money';

export interface TransferCandidate {
  id: string;
  accountId: string;
  date: Date;
  chargedAmount: MoneyInput;
  description: string;
}

export interface TransferPair {
  /** Transaction id of the negative (source-account) side. */
  outflowId: string;
  /** Transaction id of the positive (destination-account) side. */
  inflowId: string;
}

export const MAX_DAY_GAP_DEFAULT = 3;

const TRANSFER_KEYWORDS = ['העברה', 'העברת', 'בין חשבונות', 'transfer'];

/** True when the description looks like an inter-account transfer. */
export function isTransferLikeDescription(description: string): boolean {
  const normalized = description.toLowerCase();
  return TRANSFER_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

/**
 * Pair opposite-amount transactions across different accounts into transfers.
 * Deterministic and one-to-one: candidate edges are sorted by date gap (then
 * ids for stability) and taken greedily while both endpoints are unclaimed.
 */
export function pairTransfers(
  transactions: TransferCandidate[],
  options: { maxDayGap?: number } = {},
): TransferPair[] {
  const maxGapMs = (options.maxDayGap ?? MAX_DAY_GAP_DEFAULT) * 86_400_000;

  // Signed agorot once per row: exact integer keys, no float comparisons.
  const candidates = transactions
    .map((txn) => ({ txn, agorot: toAgorot(txn.chargedAmount) }))
    .filter(({ txn, agorot }) => agorot !== 0 && isTransferLikeDescription(txn.description));

  // Group inflows by absolute amount so each outflow only scans exact matches.
  const inflowsByAmount = new Map<number, TransferCandidate[]>();
  for (const { txn, agorot } of candidates) {
    if (agorot <= 0) continue;
    const key = agorot;
    const bucket = inflowsByAmount.get(key);
    if (bucket) bucket.push(txn);
    else inflowsByAmount.set(key, [txn]);
  }

  interface Edge {
    outflowId: string;
    inflowId: string;
    gapMs: number;
  }
  const edges: Edge[] = [];
  for (const { txn: outflow, agorot } of candidates) {
    if (agorot >= 0) continue;
    const inflows = inflowsByAmount.get(-agorot) ?? [];
    for (const inflow of inflows) {
      if (inflow.accountId === outflow.accountId) continue;
      const gapMs = Math.abs(inflow.date.getTime() - outflow.date.getTime());
      if (gapMs > maxGapMs) continue;
      edges.push({ outflowId: outflow.id, inflowId: inflow.id, gapMs });
    }
  }

  // Closest dates first; ids as a stable tie-breaker.
  edges.sort(
    (a, b) =>
      a.gapMs - b.gapMs ||
      a.outflowId.localeCompare(b.outflowId) ||
      a.inflowId.localeCompare(b.inflowId),
  );

  const claimed = new Set<string>();
  const pairs: TransferPair[] = [];
  for (const edge of edges) {
    if (claimed.has(edge.outflowId) || claimed.has(edge.inflowId)) continue;
    claimed.add(edge.outflowId);
    claimed.add(edge.inflowId);
    pairs.push({ outflowId: edge.outflowId, inflowId: edge.inflowId });
  }
  return pairs;
}
