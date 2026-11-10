/**
 * Pure helpers for categorization-rule input (card #50).
 *
 * Rule patterns are literal substrings typed by the user. They are matched
 * with `ILIKE '%pattern%'`; the value is a bound parameter (no injection), but
 * LIKE metacharacters inside it still act as wildcards, so a pattern such as
 * "50%" or "a_b" would over-match. PostgreSQL's default LIKE escape character
 * is backslash, so escaping \, % and _ with it makes them match literally.
 */

/** Escape LIKE metacharacters (\, %, _) for PostgreSQL's default "\" escape. */
export function escapeLikePattern(pattern: string): string {
  return pattern.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** `%<escaped pattern>%` — a literal, case-insensitive substring match for ILIKE. */
export function containsLikePattern(pattern: string): string {
  return `%${escapeLikePattern(pattern)}%`;
}

/** CategorizationRule.priority is a Postgres INTEGER. */
const MAX_RULE_PRIORITY = 2_147_483_647;

export type RulePriorityResult = { ok: true; value: number } | { ok: false; error: string };

/** Validate an API-supplied rule priority: omitted → 1, else a positive integer. */
export function parseRulePriority(value: unknown): RulePriorityResult {
  if (value === undefined) return { ok: true, value: 1 };
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_RULE_PRIORITY) {
    return { ok: false, error: 'priority must be a positive integer' };
  }
  return { ok: true, value };
}
