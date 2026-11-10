'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  CategorySelectModal,
  type AutoRulePrompt,
} from '@/components/transactions/CategorySelectModal';
import { CategorizeReviewModal } from '@/components/transactions/CategorizeReviewModal';
import {
  SimilarTransactionsDialog,
  type SimilarSourceRef,
} from '@/components/transactions/SimilarTransactionsDialog';
import {
  TransactionsTable,
  type CategoryOption,
  type TransactionRow,
} from '@/components/transactions/TransactionsTable';
import { apiFetch, describeApiError } from '@/lib/client/api';
import { useGlobalFilters } from '@/lib/hooks/useGlobalFilters';
import { formatMoney, sumByCurrency } from '@/lib/services/currencyDisplay';
import { monthDateRange } from '@/lib/services/transactionMonth';
import { cn } from '@/lib/utils';

/** First day of the month `n-1` months before the current one, as yyyy-MM-dd. */
function windowStart(monthsBack: number): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - (monthsBack - 1));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

const INITIAL_MONTHS = 3;
const MONTHS_STEP = 3;

export default function TransactionsPage() {
  const t = useTranslations('transactions');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const searchParams = useSearchParams();
  const { filters } = useGlobalFilters();
  const userId = filters.userId;

  const [transactions, setTransactions] = useState<TransactionRow[]>([]);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedMonth, setSelectedMonth] = useState('');
  const [monthsBack, setMonthsBack] = useState(INITIAL_MONTHS);
  const [reachedEnd, setReachedEnd] = useState(false);
  const [loading, setLoading] = useState(false);
  const [rulePrompt, setRulePrompt] = useState<AutoRulePrompt | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewItems, setReviewItems] = useState<TransactionRow[]>([]);
  const [similarSource, setSimilarSource] = useState<SimilarSourceRef | null>(null);
  /** Last failed mutation, shown under the header (card #51: never fail silently). */
  const [mutationError, setMutationError] = useState<string | null>(null);

  const lastCountRef = useRef(-1);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    fetch('/api/categories')
      .then((res) => (res.ok ? res.json() : []))
      .then(setCategories)
      .catch(() => undefined);
  }, []);

  // A new search, month, or household filter resets the visible window.
  useEffect(() => {
    setMonthsBack(INITIAL_MONTHS);
    setReachedEnd(Boolean(selectedMonth));
    lastCountRef.current = -1;
  }, [debouncedSearch, selectedMonth, userId]);

  const loadTransactions = useCallback(() => {
    setLoading(true);
    const range = selectedMonth ? monthDateRange(selectedMonth) : null;
    const params = new URLSearchParams(
      range ? { from: range.from, to: range.to } : { from: windowStart(monthsBack), to: todayStr() },
    );
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (userId) params.set('userId', userId);
    return fetch(`/api/transactions?${params.toString()}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load transactions (${res.status})`);
        return res.json() as Promise<TransactionRow[]>;
      })
      .then((rows) => {
        setTransactions(rows);
        // Widened the window but no new rows arrived → nothing older exists.
        if (!selectedMonth && monthsBack > INITIAL_MONTHS && rows.length === lastCountRef.current) {
          setReachedEnd(true);
        }
        lastCountRef.current = rows.length;
      })
      .catch((error) => console.error(error))
      .finally(() => setLoading(false));
  }, [monthsBack, debouncedSearch, selectedMonth, userId]);

  useEffect(() => {
    void loadTransactions();
  }, [loadTransactions]);

  // Infinite scroll: widen the window when the sentinel scrolls into view.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || reachedEnd) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !loading) {
        setMonthsBack((m) => m + MONTHS_STEP);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [reachedEnd, loading]);

  const describe = useCallback(
    (error: unknown, fallback: string) =>
      describeApiError(error, fallback, { networkMessage: tCommon('networkError') }),
    [tCommon],
  );

  /** Persist a category as MANUAL. Throws `ApiError` on failure (the review modal relies on it). */
  const confirmCategory = useCallback(async (transactionId: string, categoryId: number) => {
    await apiFetch(`/api/transactions/${transactionId}`, {
      method: 'PATCH',
      json: { categoryId },
    });
    setMutationError(null);
    setTransactions((current) =>
      current.map((row) =>
        row.id === transactionId
          ? { ...row, categoryId, categorizationSource: 'MANUAL' as const }
          : row,
      ),
    );
  }, []);

  /** Inline category change: persist as MANUAL, then offer an auto-rule. */
  const handleCategoryChange = async (txn: TransactionRow, categoryId: number) => {
    const category = categories.find((c) => c.id === categoryId);
    if (!category) return;
    try {
      await apiFetch(`/api/transactions/${txn.id}`, { method: 'PATCH', json: { categoryId } });
    } catch (error) {
      setMutationError(describe(error, t('errSaveCategory')));
      return;
    }
    setMutationError(null);
    setTransactions((current) =>
      current.map((row) =>
        row.id === txn.id
          ? { ...row, categoryId, category, categorizationSource: 'MANUAL' as const }
          : row,
      ),
    );
    setRulePrompt({ merchant: txn.description, categoryId, categoryName: category.name });
  };

  /** Tick next to a row: confirm the existing (heuristic) category as-is. */
  const handleConfirm = (txn: TransactionRow) => {
    if (txn.categoryId === null) return;
    confirmCategory(txn.id, txn.categoryId).catch((error: unknown) =>
      setMutationError(describe(error, t('errSaveCategory'))),
    );
  };

  /** Throws on failure; CategorySelectModal shows the error and stays open. */
  const handleRuleConfirm = async (pattern: string, categoryId: number) => {
    await apiFetch('/api/rules', { method: 'POST', json: { pattern, categoryId } });
    await loadTransactions();
  };

  const needsReview = useMemo(
    () => transactions.filter((txn) => txn.categorizationSource !== 'MANUAL'),
    [transactions],
  );

  const openReview = useCallback(() => {
    setReviewItems(transactions.filter((txn) => txn.categorizationSource !== 'MANUAL'));
    setReviewOpen(true);
  }, [transactions]);

  // Deep-link from the daily reminder: /transactions?review=1 opens the flow.
  useEffect(() => {
    if (searchParams.get('review') === '1' && transactions.length > 0) openReview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, transactions.length]);

  // Group by month (transactions arrive newest-first, so months stay in order).
  const groups = useMemo(() => {
    const map = new Map<string, TransactionRow[]>();
    for (const txn of transactions) {
      const key = txn.date.slice(0, 7); // yyyy-MM
      const bucket = map.get(key);
      if (bucket) bucket.push(txn);
      else map.set(key, [txn]);
    }
    return [...map.entries()];
  }, [transactions]);

  const monthLabel = (key: string): string => {
    const [y, m] = key.split('-').map(Number);
    return new Intl.DateTimeFormat(locale === 'he' ? 'he-IL' : 'en-GB', {
      month: 'long',
      year: 'numeric',
    }).format(new Date(y ?? 2000, (m ?? 1) - 1, 1));
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between sm:space-y-0">
          <CardTitle>{t('title')}</CardTitle>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center">
            {needsReview.length > 0 && (
              <Button variant="outline" size="sm" className="h-11 w-full sm:h-8 sm:w-auto" onClick={openReview}>
                {t('reviewButtonCount', { count: needsReview.length })}
              </Button>
            )}
            <div className="relative w-full sm:w-72">
              <Search
                className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                type="search"
                placeholder={t('searchPlaceholder')}
                aria-label={t('searchAria')}
                className="h-11 ps-8 sm:h-9"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <label className="flex h-11 w-full items-center gap-2 rounded-md border px-3 text-sm sm:h-9 sm:w-auto">
              <span className="whitespace-nowrap text-muted-foreground">{t('monthFilter')}</span>
              <Input
                type="month"
                aria-label={t('monthFilter')}
                className="h-8 min-w-0 border-0 p-0 shadow-none focus-visible:ring-0"
                value={selectedMonth}
                onChange={(event) => setSelectedMonth(event.target.value)}
              />
              {selectedMonth && (
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={t('clearMonthFilter')}
                  onClick={() => setSelectedMonth('')}
                >
                  ×
                </button>
              )}
            </label>
          </div>
        </CardHeader>
        {mutationError && (
          <CardContent className="pt-0">
            <p role="alert" className="text-sm text-destructive">
              {mutationError}
            </p>
          </CardContent>
        )}
      </Card>

      {transactions.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            {t('empty')}
          </CardContent>
        </Card>
      ) : (
        groups.map(([key, rows]) => {
          // One net per settlement currency — mixed currencies are never
          // added together as if they were all ILS. isRefund rows count as
          // +|amount| (same-sign refunds, ADR-0024).
          const nets = sumByCurrency(rows);
          return (
            <Card key={key}>
              <CardHeader className="flex-row items-center justify-between space-y-0 py-3">
                <CardTitle className="text-base">{monthLabel(key)}</CardTitle>
                <span className="flex flex-wrap items-center justify-end gap-x-3 gap-y-0.5">
                  {nets.map(({ currency, total }) => (
                    <span
                      key={currency}
                      className={cn(
                        'text-sm font-semibold tabular-nums',
                        total < 0 ? 'text-red-600' : 'text-emerald-600',
                      )}
                    >
                      {formatMoney(total, currency)}
                    </span>
                  ))}
                </span>
              </CardHeader>
              <CardContent>
                <TransactionsTable
                  transactions={rows}
                  categories={categories}
                  onCategoryChange={handleCategoryChange}
                  onNoteChange={(transactionId, note) =>
                    setTransactions((current) =>
                      current.map((row) => (row.id === transactionId ? { ...row, note } : row)),
                    )
                  }
                  onRefundChange={(transactionId, isRefund) =>
                    setTransactions((current) =>
                      current.map((row) => (row.id === transactionId ? { ...row, isRefund } : row)),
                    )
                  }
                  onConfirm={handleConfirm}
                  onFindSimilar={(txn) =>
                    setSimilarSource({ id: txn.id, description: txn.description })
                  }
                />
              </CardContent>
            </Card>
          );
        })
      )}

      {/* Infinite-scroll sentinel + status */}
      <div ref={sentinelRef} className="py-4 text-center text-xs text-muted-foreground">
        {loading ? t('loadingEarlier') : selectedMonth ? ' ' : reachedEnd ? t('noEarlier') : ' '}
      </div>

      <CategorySelectModal
        prompt={rulePrompt}
        onClose={() => setRulePrompt(null)}
        onConfirm={handleRuleConfirm}
      />
      <CategorizeReviewModal
        open={reviewOpen}
        items={reviewItems}
        categories={categories}
        onConfirm={confirmCategory}
        onClose={() => setReviewOpen(false)}
      />
      <SimilarTransactionsDialog source={similarSource} onClose={() => setSimilarSource(null)} />
    </div>
  );
}
