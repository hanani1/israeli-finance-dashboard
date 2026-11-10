/**
 * Rule execution engine.
 *
 * Applies CategorizationRule patterns to uncategorized transactions using a
 * set-based SQL UPDATE with ILIKE (case-insensitive substring match) — one
 * statement per rule instead of row-by-row processing. Patterns are literal:
 * LIKE metacharacters (%, _, \) are escaped (see rulePattern.ts).
 *
 * Only transactions with categoryId IS NULL are touched, so MANUAL
 * assignments always win and previously RULE-tagged rows are not re-written.
 * Rules run in descending priority order: higher priority claims rows first.
 */
import { prisma } from '@/lib/db';
import { RequestError } from '@/lib/services/requestError';
import { containsLikePattern } from './rulePattern';

export interface RuleInput {
  pattern: string;
  categoryId: number;
  priority?: number;
  /** Also match the memo field (see schema — opt-in, default false). */
  matchMemo?: boolean;
}

/**
 * Apply all categorization rules. Returns the number of transactions updated.
 */
export async function applyCategorizationRules(): Promise<number> {
  const rules = await prisma.categorizationRule.findMany({
    orderBy: [{ priority: 'desc' }, { id: 'asc' }],
  });

  let totalUpdated = 0;
  for (const rule of rules) {
    const like = containsLikePattern(rule.pattern);
    // matchMemo rules also match the transfer memo — bank transfer memos carry
    // the destination (e.g. "העברה אל: אלטשולר שחם") while the description is
    // a generic "העברה דיגיטל". Description-only rules keep the original SQL.
    const updated = rule.matchMemo
      ? await prisma.$executeRaw`
          UPDATE "Transaction"
          SET "categoryId" = ${rule.categoryId},
              "categorizationSource" = 'RULE'::"CategorizationSource"
          WHERE "categoryId" IS NULL
            AND "isCardSettlement" = false
            AND ("description" ILIKE ${like} OR "memo" ILIKE ${like})
        `
      : await prisma.$executeRaw`
          UPDATE "Transaction"
          SET "categoryId" = ${rule.categoryId},
              "categorizationSource" = 'RULE'::"CategorizationSource"
          WHERE "categoryId" IS NULL
            AND "isCardSettlement" = false
            AND "description" ILIKE ${like}
        `;
    totalUpdated += updated;
  }
  return totalUpdated;
}

/** Create a rule and immediately apply all rules. Returns rows updated. */
export async function createRuleAndApply(input: RuleInput): Promise<{ ruleId: number; updated: number }> {
  const pattern = input.pattern.trim();
  if (!pattern) {
    throw new RequestError(400, 'Rule pattern must not be empty.');
  }

  const rule = await prisma.categorizationRule.create({
    data: {
      pattern,
      categoryId: input.categoryId,
      priority: input.priority ?? 1,
      matchMemo: input.matchMemo ?? false,
    },
  });

  const updated = await applyCategorizationRules();
  return { ruleId: rule.id, updated };
}

export async function listRules() {
  return prisma.categorizationRule.findMany({
    include: { category: true },
    orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
  });
}

export async function deleteRule(id: number): Promise<void> {
  await prisma.categorizationRule.delete({ where: { id } });
}
