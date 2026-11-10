'use client';

/**
 * Monthly view (מבט חודשי) — unified from the former Monthly + Breakdown tabs.
 * Pick a month, see a pie of expenses by category at the top, a Net summary,
 * then the full per-category breakdown grouped into variable expenses /
 * recurring expenses / income (RiseUp-style). Each category row expands to its
 * actual transactions, where the classification can be changed inline — and
 * optionally made permanent (applied to all identical transactions + a rule).
 * Data from GET /api/monthly-breakdown.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronUp, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ExpensePieChart, type BreakdownSlice } from '@/components/analytics/ExpensePieChart';
import { CategoryColorButton } from '@/components/categories/CategoryColorButton';
import { MakePermanentDialog } from '@/components/transactions/MakePermanentDialog';
import {
  SimilarTransactionsDialog,
  type SimilarSourceRef,
} from '@/components/transactions/SimilarTransactionsDialog';
import { TransactionAmount } from '@/components/transactions/TransactionAmount';
import {
  TransactionDetailsDialog,
  type TransactionDetails,
} from '@/components/transactions/TransactionDetailsDialog';
import { apiFetch, describeApiError } from '@/lib/client/api';
import { useGlobalFilters } from '@/lib/hooks/useGlobalFilters';
import { cn, formatCurrency, formatDate } from '@/lib/utils';

type Group = 'VARIABLE_EXPENSE' | 'RECURRING_EXPENSE' | 'INCOME';

interface BreakdownCategory {
  categoryId: number;
  name: string;
  color: string;
  total: number;
  avg6: number;
}
interface BreakdownGroup {
  group: Group;
  total: number;
  categories: BreakdownCategory[];
}
interface MonthlyBreakdown {
  month: string;
  groups: BreakdownGroup[];
  uncategorized: { total: number; count: number };
  /** Same-sign refunds marked isRefund, already included in totalIncome. */
  refunds: { total: number; count: number };
  totalIncome: number;
  totalExpense: number;
  net: number;
}

interface CategoryOption {
  id: number;
  name: string;
  color: string;
}

interface TxnRow {
  id: string;
  date: string;
  description: string;
  memo: string | null;
  chargedAmount: number;
  chargedCurrency: string;
  originalAmount: number | null;
  originalCurrency: string | null;
  categoryId: number | null;
  category: { id: number; name: string; color: string } | null;
  /** Same-sign refund (ADR-0024): raw amount negative, shown as +|amount|. */
  isRefund?: boolean;
  account: {
    displayName: string;
    provider: string;
    accountNumber: string;
    kind: 'BANK' | 'CARD';
    user: { name: string };
  };
}

interface PermanentPrompt {
  description: string;
  categoryId: number;
  categoryName: string;
}

const GROUP_LABEL: Record<Group, 'groupVariable' | 'groupRecurring' | 'groupIncome'> = {
  VARIABLE_EXPENSE: 'groupVariable',
  RECURRING_EXPENSE: 'groupRecurring',
  INCOME: 'groupIncome',
};

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export default function MonthlyPage() {
  const t = useTranslations('breakdown');
  const tSimilar = useTranslations('similar');
  const tDetails = useTranslations('transactionDetails');
  const tCommon = useTranslations('common');
  const { filters } = useGlobalFilters();
  const userId = filters.userId;
  const [month, setMonth] = useState<string>(currentMonth());
  const [data, setData] = useState<MonthlyBreakdown | null>(null);
  const [loading, setLoading] = useState(true);

  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [monthTxns, setMonthTxns] = useState<TxnRow[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [permanentPrompt, setPermanentPrompt] = useState<PermanentPrompt | null>(null);
  const [busy, setBusy] = useState(false);
  /** Last failed mutation (card #51: never fail silently). */
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [similarSource, setSimilarSource] = useState<SimilarSourceRef | null>(null);
  const [detailsTransaction, setDetailsTransaction] = useState<TransactionDetails | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ month });
    if (userId) params.set('userId', userId);
    return fetch(`/api/monthly-breakdown?${params.toString()}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((payload: MonthlyBreakdown | null) => setData(payload))
      .catch((error) => console.error(error))
      .finally(() => setLoading(false));
  }, [month, userId]);

  const loadMonthTxns = useCallback(() => {
    // Effective flow-month semantics (stored RiseUp flowMonth, calendar
    // fallback) so the list matches the breakdown totals for the month.
    const params = new URLSearchParams({ flowMonth: month });
    if (userId) params.set('userId', userId);
    return fetch(`/api/transactions?${params.toString()}`)
      .then((res) => (res.ok ? res.json() : []))
      .then((rows: TxnRow[]) => setMonthTxns(Array.isArray(rows) ? rows : []))
      .catch(() => setMonthTxns([]));
  }, [month, userId]);

  useEffect(() => {
    load();
    loadMonthTxns();
    setExpanded(null);
  }, [load, loadMonthTxns]);

  const loadCategories = useCallback(() => {
    return fetch('/api/categories')
      .then((res) => (res.ok ? res.json() : []))
      .then((rows: Array<{ id: number; name: string; color: string }>) =>
        setCategories(rows.map((c) => ({ id: c.id, name: c.name, color: c.color }))),
      )
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void loadCategories();
  }, [loadCategories]);

  /** Refresh everything that renders category colors after an edit. */
  const handleColorSaved = useCallback(() => {
    void Promise.all([load(), loadCategories()]);
  }, [load, loadCategories]);

  const handleReclassify = useCallback(
    async (txn: TxnRow, newCategoryId: number) => {
      if (newCategoryId === txn.categoryId) return;
      setMutationError(null);
      try {
        await apiFetch(`/api/transactions/${txn.id}`, {
          method: 'PATCH',
          json: { categoryId: newCategoryId },
        });
      } catch (error) {
        // Do not offer "make permanent" for a change that was never saved.
        setMutationError(
          describeApiError(error, t('errReclassify'), { networkMessage: tCommon('networkError') }),
        );
        return;
      }
      await Promise.all([load(), loadMonthTxns()]);
      const cat = categories.find((c) => c.id === newCategoryId);
      setPermanentPrompt({
        description: txn.description,
        categoryId: newCategoryId,
        categoryName: cat?.name ?? '',
      });
    },
    [categories, load, loadMonthTxns, t, tCommon],
  );

  const handlePermanentConfirm = useCallback(async () => {
    if (!permanentPrompt) return;
    setBusy(true);
    setMutationError(null);
    try {
      await apiFetch('/api/transactions/reclassify-identical', {
        method: 'POST',
        json: {
          description: permanentPrompt.description,
          categoryId: permanentPrompt.categoryId,
        },
      });
      await apiFetch('/api/rules', {
        method: 'POST',
        json: {
          pattern: permanentPrompt.description,
          categoryId: permanentPrompt.categoryId,
        },
      });
    } catch (error) {
      setMutationError(
        describeApiError(error, t('errMakePermanent'), { networkMessage: tCommon('networkError') }),
      );
    } finally {
      // Reload either way: the first call may have applied before the second failed.
      await Promise.all([load(), loadMonthTxns()]);
      setBusy(false);
      setPermanentPrompt(null);
    }
  }, [permanentPrompt, load, loadMonthTxns, t, tCommon]);

  // Pie = expense categories (variable + recurring) + an uncategorized slice.
  const pieData: BreakdownSlice[] = useMemo(() => {
    if (!data) return [];
    const slices: BreakdownSlice[] = data.groups
      .filter((g) => g.group !== 'INCOME')
      .flatMap((g) =>
        g.categories.map((c) => ({
          categoryId: c.categoryId,
          name: c.name,
          color: c.color,
          total: c.total,
        })),
      );
    if (data.uncategorized.total > 0) {
      slices.push({ categoryId: null, name: '', color: '#94a3b8', total: data.uncategorized.total });
    }
    return slices.sort((a, b) => b.total - a.total);
  }, [data]);

  const hasAny =
    !!data &&
    (pieData.length > 0 ||
      data.groups.some((g) => g.categories.length > 0) ||
      (data.refunds?.total ?? 0) > 0);

  const renderTxns = (categoryId: number) => {
    const rows = monthTxns.filter((tx) => tx.categoryId === categoryId);
    if (rows.length === 0) {
      return <p className="py-2 text-xs text-muted-foreground">{t('noTxns')}</p>;
    }
    return (
      <div className="mt-2 space-y-2 sm:ps-4">
        {rows.map((tx) => (
          <div
            key={tx.id}
            className={cn(
              'flex flex-col gap-2 rounded-xl border bg-background p-3 text-xs sm:flex-row sm:items-center sm:justify-between sm:rounded sm:p-1.5',
              tx.chargedAmount < 0 && 'cursor-pointer',
            )}
            tabIndex={tx.chargedAmount < 0 ? 0 : undefined}
            aria-label={
              tx.chargedAmount < 0
                ? tDetails('openAria', { description: tx.description })
                : undefined
            }
            onClick={() => tx.chargedAmount < 0 && setDetailsTransaction(tx)}
            onKeyDown={(event) => {
              if (tx.chargedAmount >= 0 || (event.key !== 'Enter' && event.key !== ' ')) return;
              event.preventDefault();
              setDetailsTransaction(tx);
            }}
          >
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium" title={tx.description}>
                {tx.description}
              </div>
              <div className="text-muted-foreground">{formatDate(tx.date)}</div>
            </div>
            <TransactionAmount txn={tx} className="self-end shrink-0 text-xs sm:self-auto" />
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 shrink-0"
              aria-label={tSimilar('actionFor', { description: tx.description })}
              title={tSimilar('actionFor', { description: tx.description })}
              onClick={(event) => {
                event.stopPropagation();
                setSimilarSource({ id: tx.id, description: tx.description });
              }}
            >
              <Search className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            </Button>
            <div
              className="shrink-0"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <Select
                value={tx.categoryId !== null ? String(tx.categoryId) : ''}
                onValueChange={(v) => handleReclassify(tx, Number(v))}
              >
              <SelectTrigger
                className="h-11 w-full shrink-0 text-sm sm:h-7 sm:w-32 sm:text-xs"
                aria-label={t('changeCategory')}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {categories.map((cat) => (
                  <SelectItem key={cat.id} value={String(cat.id)}>
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: cat.color }}
                        aria-hidden
                      />
                      {cat.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
              </Select>
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className={cn('space-y-4 sm:space-y-6', loading && 'opacity-70 transition-opacity')}>
      <div className="flex items-center gap-2">
        <Label htmlFor="breakdown-month" className="text-sm text-muted-foreground">
          {t('month')}
        </Label>
        <Input
          id="breakdown-month"
          type="month"
          className="h-8 w-[9.5rem] text-xs"
          value={month}
          onChange={(e) => setMonth(e.target.value || currentMonth())}
        />
      </div>

      {mutationError && (
        <p role="alert" className="text-sm text-destructive">
          {mutationError}
        </p>
      )}

      {!hasAny ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            {t('empty')}
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Net summary — income minus ALL expenses (incl. variable) */}
          <Card>
            <CardContent className="grid grid-cols-3 gap-2 py-4 text-center">
              <div>
                <p className="text-xs text-muted-foreground">{t('income')}</p>
                <p className="text-base font-semibold tabular-nums text-emerald-600 sm:text-lg">
                  {formatCurrency(data!.totalIncome)}
                </p>
                {(data!.refunds?.total ?? 0) > 0 && (
                  <p className="text-xs tabular-nums text-muted-foreground" title={t('refundsHint')}>
                    {t('refunds')}: {formatCurrency(data!.refunds.total)}
                  </p>
                )}
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t('expenses')}</p>
                <p className="text-base font-semibold tabular-nums text-red-600 sm:text-lg">
                  {formatCurrency(data!.totalExpense)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground" title={t('netHint')}>
                  {t('net')}
                </p>
                <p
                  className={cn(
                    'text-base font-bold tabular-nums sm:text-lg',
                    data!.net >= 0 ? 'text-emerald-600' : 'text-red-600',
                  )}
                >
                  {formatCurrency(data!.net)}
                </p>
              </div>
            </CardContent>
          </Card>

          <ExpensePieChart data={pieData} onColorSaved={handleColorSaved} />

          {data!.groups.map((group) => {
            if (group.categories.length === 0) return null;
            return (
              <Card key={group.group}>
                <CardHeader className="flex-row items-center justify-between space-y-0 py-3">
                  <CardTitle className="text-base">{t(GROUP_LABEL[group.group])}</CardTitle>
                  <span className="text-sm font-semibold tabular-nums">
                    {formatCurrency(group.total)}
                  </span>
                </CardHeader>
                <CardContent className="space-y-1">
                  {group.categories.map((c) => {
                    const isIncome = group.group === 'INCOME';
                    const pct = c.avg6 > 0 ? Math.round(((c.total - c.avg6) / c.avg6) * 100) : null;
                    // For expenses, above-average is "bad" (red); for income, above is "good".
                    const deltaTone =
                      pct === null || pct === 0
                        ? 'text-muted-foreground'
                        : (pct > 0) === isIncome
                          ? 'text-emerald-600'
                          : 'text-red-600';
                    const isOpen = expanded === c.categoryId;
                    return (
                      <div key={c.categoryId} className="border-b py-1 text-sm last:border-0">
                        <div className="flex w-full items-center gap-2">
                          <CategoryColorButton
                            categoryId={c.categoryId}
                            categoryName={c.name}
                            color={c.color}
                            onSaved={handleColorSaved}
                            className="h-2.5 w-2.5"
                          />
                          <button
                            type="button"
                            className="flex flex-1 items-center justify-between gap-2 text-start"
                            aria-expanded={isOpen}
                            onClick={() => setExpanded(isOpen ? null : c.categoryId)}
                          >
                            <span className="flex items-center gap-2">
                              {isOpen ? (
                                <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                              ) : (
                                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                              )}
                              {c.name}
                            </span>
                            <span className="tabular-nums">{formatCurrency(c.total)}</span>
                          </button>
                        </div>
                        {c.avg6 > 0 && (
                          <div className="flex items-center justify-between ps-6 text-xs text-muted-foreground">
                            <span>
                              {t('avg6')}: {formatCurrency(c.avg6)}
                            </span>
                            {pct !== null && (
                              <span className={cn('tabular-nums', deltaTone)}>
                                {pct > 0 ? '+' : ''}
                                {pct}%
                              </span>
                            )}
                          </div>
                        )}
                        {isOpen && renderTxns(c.categoryId)}
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            );
          })}
        </>
      )}

      <MakePermanentDialog
        open={permanentPrompt !== null}
        categoryName={permanentPrompt?.categoryName ?? ''}
        busy={busy}
        onConfirm={handlePermanentConfirm}
        onCancel={() => setPermanentPrompt(null)}
      />
      <SimilarTransactionsDialog source={similarSource} onClose={() => setSimilarSource(null)} />
      <TransactionDetailsDialog
        transaction={detailsTransaction}
        onClose={() => setDetailsTransaction(null)}
        onRefundChange={(transactionId, isRefund) => {
          setDetailsTransaction((current) =>
            current && current.id === transactionId ? { ...current, isRefund } : current,
          );
          void Promise.all([load(), loadMonthTxns()]);
        }}
      />
    </div>
  );
}
