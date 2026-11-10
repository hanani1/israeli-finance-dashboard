'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  BudgetPacingChart,
  type BudgetPacingDatum,
} from '@/components/analytics/BudgetPacingChart';
import { CategoryColorButton } from '@/components/categories/CategoryColorButton';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { apiFetch, describeApiError } from '@/lib/client/api';
import { useGlobalFilters } from '@/lib/hooks/useGlobalFilters';
import { cn, formatCurrency } from '@/lib/utils';

type Pace = 'under' | 'on' | 'over';

interface CategoryPacing extends BudgetPacingDatum {
  budgetId: number;
  categoryId: number;
  remaining: number;
  projected: number;
}

interface BudgetableCategory {
  categoryId: number;
  name: string;
  color: string;
  amount: number;
  budgetId: number | null;
}

interface BudgetsResponse {
  month: string;
  totals: {
    amount: number;
    spent: number;
    remaining: number;
    expectedByNow: number;
    projected: number;
    pace: Pace;
    overBudget: boolean;
  };
  categories: CategoryPacing[];
  budgetableCategories: BudgetableCategory[];
}

const PACE_TONE: Record<Pace, string> = {
  under: 'text-emerald-600',
  on: 'text-teal-700',
  over: 'text-red-600',
};

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export default function BudgetsPage() {
  const t = useTranslations('budgets');
  const tCommon = useTranslations('common');
  const paceLabel: Record<Pace, string> = {
    under: t('underPace'),
    on: t('onPace'),
    over: t('overPace'),
  };
  const { filters } = useGlobalFilters();
  const [month, setMonth] = useState<string>(currentMonth());
  const [data, setData] = useState<BudgetsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Budget awaiting delete confirmation (ADR-0007). */
  const [pendingDelete, setPendingDelete] = useState<{ budgetId: number; name: string } | null>(
    null,
  );

  const query = useMemo(() => {
    const params = new URLSearchParams({ month });
    if (filters.userId) params.set('userId', filters.userId);
    return params.toString();
  }, [month, filters.userId]);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/budgets?${query}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Budgets request failed (${res.status})`);
        return res.json();
      })
      .then((payload: BudgetsResponse) => {
        setData(payload);
        setDrafts(
          Object.fromEntries(
            payload.budgetableCategories.map((c) => [c.categoryId, c.amount ? String(c.amount) : '']),
          ),
        );
      })
      .catch((error) => console.error(error))
      .finally(() => setLoading(false));
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    if (!cancelled) load();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const saveBudget = useCallback(
    async (categoryId: number) => {
      const raw = drafts[categoryId];
      const amount = Number(raw);
      if (raw === '' || Number.isNaN(amount) || amount < 0) return;
      setSaving(true);
      setError(null);
      try {
        await apiFetch('/api/budgets', { method: 'POST', json: { categoryId, amount } });
        load();
      } catch (e) {
        setError(describeApiError(e, t('errSave'), { networkMessage: tCommon('networkError') }));
      } finally {
        setSaving(false);
      }
    },
    [drafts, load, t, tCommon],
  );

  /** Runs after the user confirms in the ConfirmDialog. */
  const handleDeleteConfirmed = useCallback(async () => {
    if (!pendingDelete) return;
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/api/budgets/${pendingDelete.budgetId}`, { method: 'DELETE' });
      load();
    } catch (e) {
      setError(describeApiError(e, t('errDelete'), { networkMessage: tCommon('networkError') }));
    } finally {
      setPendingDelete(null);
      setSaving(false);
    }
  }, [pendingDelete, load, t, tCommon]);

  const totals = data?.totals;
  const chartData: BudgetPacingDatum[] = (data?.categories ?? []).map((c) => ({
    name: c.name,
    color: c.color,
    amount: c.amount,
    spent: c.spent,
    expectedByNow: c.expectedByNow,
    pace: c.pace,
  }));

  const summaryCards = [
    { label: t('totalBudget'), value: totals?.amount ?? 0, tone: 'text-foreground' },
    { label: t('spentSoFar'), value: totals?.spent ?? 0, tone: 'text-foreground' },
    { label: t('expectedByNow'), value: totals?.expectedByNow ?? 0, tone: 'text-muted-foreground' },
    {
      label: t('projected'),
      value: totals?.projected ?? 0,
      tone: totals && totals.projected > totals.amount ? 'text-red-600' : 'text-emerald-600',
    },
  ];

  return (
    <div className={cn('space-y-4 sm:space-y-6', loading && 'opacity-70 transition-opacity')}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-center gap-2">
          <Label htmlFor="budget-month" className="text-sm text-muted-foreground">
            {t('month')}
          </Label>
          <Input
            id="budget-month"
            type="month"
            className="h-8 w-[9.5rem] text-xs"
            value={month}
            onChange={(e) => setMonth(e.target.value || currentMonth())}
          />
        </div>
        {totals && (
          <span className={cn('text-sm font-semibold', PACE_TONE[totals.pace])}>
            {paceLabel[totals.pace]} · {t('left', { amount: formatCurrency(totals.remaining) })}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
        {summaryCards.map(({ label, value, tone }) => (
          <Card key={label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className={cn('text-xl font-bold tabular-nums sm:text-2xl', tone)}>
                {formatCurrency(value)}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <BudgetPacingChart
        title={t('budgetVsSpend')}
        data={chartData}
        emptyLabel={t('noBudgets')}
        budgetLabel={t('budget')}
        spentLabel={t('spent')}
      />

      <Card>
        <CardHeader>
          <CardTitle>{t('categoryBudgets')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {(data?.budgetableCategories ?? []).map((category) => {
            const pacing = data?.categories.find((c) => c.categoryId === category.categoryId);
            return (
              <div
                key={category.categoryId}
                className="flex flex-wrap items-center gap-3 rounded-md border p-2"
              >
                <CategoryColorButton
                  categoryId={category.categoryId}
                  categoryName={category.name}
                  color={category.color}
                  onSaved={load}
                  className="h-3 w-3"
                />
                <span className="min-w-32 flex-1 text-sm font-medium">{category.name}</span>
                {pacing && (
                  <span className={cn('text-xs tabular-nums', PACE_TONE[pacing.pace])}>
                    {formatCurrency(pacing.spent)} / {formatCurrency(pacing.amount)}
                  </span>
                )}
                <Input
                  type="number"
                  min={0}
                  step={50}
                  inputMode="decimal"
                  className="h-8 w-28 text-xs"
                  placeholder="0"
                  value={drafts[category.categoryId] ?? ''}
                  onChange={(e) =>
                    setDrafts((prev) => ({ ...prev, [category.categoryId]: e.target.value }))
                  }
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={saving}
                  onClick={() => saveBudget(category.categoryId)}
                >
                  {t('save')}
                </Button>
                {category.budgetId !== null && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={saving}
                    aria-label={t('removeBudgetFor', { name: category.name })}
                    onClick={() =>
                      setPendingDelete({
                        budgetId: category.budgetId as number,
                        name: category.name,
                      })
                    }
                  >
                    <Trash2 className="h-4 w-4 text-red-600" aria-hidden />
                  </Button>
                )}
              </div>
            );
          })}
          {(data?.budgetableCategories.length ?? 0) === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t('noExpenseCategories')}
            </p>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('deleteTitle')}
        description={t('deleteDesc', { name: pendingDelete?.name ?? '' })}
        confirmLabel={t('deleteConfirm')}
        busy={saving}
        onConfirm={() => void handleDeleteConfirmed()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
