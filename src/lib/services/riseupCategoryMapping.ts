import { canonicalCategoryName } from './categoryMerge';

export type LocalCategory = {
  id: number;
  name: string;
  type: 'INCOME' | 'EXPENSE' | 'INVESTMENT';
  group: 'INCOME' | 'VARIABLE_EXPENSE' | 'RECURRING_EXPENSE' | 'INVESTMENT';
};

export type RiseUpCategoryTarget = {
  name: string;
  type: 'INCOME' | 'EXPENSE';
  group: 'INCOME' | 'VARIABLE_EXPENSE' | 'RECURRING_EXPENSE';
};

const HIDDEN_LABEL = '__saving-hidden-category__';

export function riseUpCategoryTarget(label: string | undefined, isIncome: boolean): RiseUpCategoryTarget | null {
  const raw = label?.trim() ?? '';
  if (!raw || raw === HIDDEN_LABEL) return null;

  if (isIncome) return { name: canonicalCategoryName(raw, 'INCOME'), type: 'INCOME', group: 'INCOME' };
  // Retired (merged) labels resolve to their target so imports never recreate them.
  const name = canonicalCategoryName(raw, 'EXPENSE');

  const recurring = new Set(['דיור', 'משכנתא', 'ארנונה', 'תקשורת', 'דיגיטל', 'ביטוח', 'חינוך', 'עמלות', 'כללי']);
  return {
    name,
    type: 'EXPENSE',
    group: recurring.has(name) ? 'RECURRING_EXPENSE' : 'VARIABLE_EXPENSE',
  };
}

export function findMatchingCategory(categories: LocalCategory[], target: RiseUpCategoryTarget): LocalCategory | undefined {
  return categories.find((category) =>
    category.name.trim() === target.name && category.type === target.type && category.group === target.group,
  );
}

export { HIDDEN_LABEL };
