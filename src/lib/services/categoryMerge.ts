/**
 * Category merges (pure, unit-tested).
 *
 * Categories are identified by name + type + group, never by id: the primary
 * and dev databases assign different ids to the same category. Each merge
 * moves every reference (transactions, rules, budgets) from `source` to
 * `target` and retires the source. `canonicalCategoryName` is the durable
 * guard: anything that resolves a category by name (RiseUp imports, rules)
 * goes through it, so a retired name can never be recreated by a later sync.
 */

export type MergeCategoryType = 'INCOME' | 'EXPENSE' | 'INVESTMENT';
export type MergeCategoryGroup = 'INCOME' | 'VARIABLE_EXPENSE' | 'RECURRING_EXPENSE' | 'INVESTMENT';

export interface MergeCategory {
  id: number;
  name: string;
  type: MergeCategoryType;
  group: MergeCategoryGroup;
}

export interface CategoryKey {
  name: string;
  type: MergeCategoryType;
  group: MergeCategoryGroup;
}

export interface CategoryMerge {
  source: CategoryKey;
  target: CategoryKey;
}

/** Agreed merges (card #57). Order matters only for reporting. */
export const CATEGORY_MERGES: readonly CategoryMerge[] = [
  {
    source: { name: 'אחר', type: 'EXPENSE', group: 'VARIABLE_EXPENSE' },
    target: { name: 'הוצאות משתנות', type: 'EXPENSE', group: 'VARIABLE_EXPENSE' },
  },
  {
    // RiseUp's own label is the broader one and carries the larger history.
    source: { name: 'פנאי', type: 'EXPENSE', group: 'VARIABLE_EXPENSE' },
    target: { name: 'טיולים ופנאי', type: 'EXPENSE', group: 'VARIABLE_EXPENSE' },
  },
];

export type MergeSkipReason = 'source-missing' | 'target-missing' | 'target-ambiguous';

export interface MergeStep {
  merge: CategoryMerge;
  source: MergeCategory;
  target: MergeCategory;
}

export interface MergePlan {
  steps: MergeStep[];
  skipped: Array<{ merge: CategoryMerge; reason: MergeSkipReason }>;
}

function matches(category: MergeCategory, key: CategoryKey): boolean {
  return category.name.trim() === key.name && category.type === key.type && category.group === key.group;
}

export function planCategoryMerges(categories: readonly MergeCategory[]): MergePlan {
  const steps: MergeStep[] = [];
  const skipped: MergePlan['skipped'] = [];
  for (const merge of CATEGORY_MERGES) {
    const sources = categories.filter((c) => matches(c, merge.source));
    const targets = categories.filter((c) => matches(c, merge.target));
    if (targets.length > 1) {
      skipped.push({ merge, reason: 'target-ambiguous' });
      continue;
    }
    if (targets.length === 0) {
      skipped.push({ merge, reason: 'target-missing' });
      continue;
    }
    if (sources.length === 0) {
      skipped.push({ merge, reason: 'source-missing' });
      continue;
    }
    // Duplicate sources (CSV imports have created same-name twins) all fold in.
    for (const source of sources) steps.push({ merge, source, target: targets[0]! });
  }
  return { steps, skipped };
}

/**
 * Canonical display name for a category label: a retired (merged) name maps
 * to its target; everything else is returned trimmed. Type disambiguates
 * same-name categories in different groups (INCOME אחר is untouched).
 */
export function canonicalCategoryName(name: string, type: MergeCategoryType): string {
  const trimmed = name.trim();
  for (const merge of CATEGORY_MERGES) {
    if (merge.source.name === trimmed && merge.source.type === type) return merge.target.name;
  }
  return trimmed;
}
