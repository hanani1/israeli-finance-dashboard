'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowDownRight, ArrowUpRight, Scale, TrendingUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ExpensePieChart, type BreakdownSlice } from '@/components/analytics/ExpensePieChart';
import {
  SpendingLineChart,
  type TrendCategory,
  type TrendGranularity,
  type TrendPoint,
} from '@/components/analytics/SpendingLineChart';
import { useGlobalFilters } from '@/lib/hooks/useGlobalFilters';
import { cn, formatCurrency } from '@/lib/utils';

interface AnalyticsResponse {
  totals: { income: number; expenses: number; net: number };
  breakdown: BreakdownSlice[];
  trend: TrendPoint[];
}

interface AccountBalance {
  id: string;
  displayName: string;
  provider: string;
  userName: string;
  balance: number;
  currency: string;
}

interface BalancesResponse {
  accounts: AccountBalance[];
  total: number;
  currency: string;
}

interface InvestmentsSummary {
  totalInvested: number;
  thisMonth: { deposits: number; withdrawals: number; net: number };
}

export default function DashboardPage() {
  const t = useTranslations('dashboard');
  const tInvest = useTranslations('investments');
  const { toQueryString } = useGlobalFilters();
  const [granularity, setGranularity] = useState<TrendGranularity>('day');
  const [trendCategoryId, setTrendCategoryId] = useState('');
  const [categories, setCategories] = useState<TrendCategory[]>([]);
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [balances, setBalances] = useState<BalancesResponse | null>(null);
  const [investments, setInvestments] = useState<InvestmentsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  // Bumped when a category color is edited from the pie legend, to refetch
  // the server-colored analytics payload.
  const [refreshKey, setRefreshKey] = useState(0);

  const queryString = toQueryString();

  // Investments card honors the global filters (from/to date range and
  // household member), same as the rest of the dashboard.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/investments?${queryString}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((payload: InvestmentsSummary | null) => {
        if (!cancelled) setInvestments(payload);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [queryString]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/accounts?${queryString}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((payload: BalancesResponse | null) => {
        if (!cancelled) setBalances(payload);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [queryString]);

  useEffect(() => {
    fetch('/api/categories')
      .then((res) => (res.ok ? res.json() : []))
      .then((rows: Array<{ id: number; name: string; type: string }>) =>
        setCategories(rows.filter((c) => c.type === 'EXPENSE').map((c) => ({ id: c.id, name: c.name }))),
      )
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const trendParam = trendCategoryId ? `&trendCategoryId=${trendCategoryId}` : '';
    fetch(`/api/analytics?${queryString}&granularity=${granularity}${trendParam}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Analytics request failed (${res.status})`);
        return res.json();
      })
      .then((payload: AnalyticsResponse) => {
        if (!cancelled) setData(payload);
      })
      .catch((error) => console.error(error))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [queryString, granularity, trendCategoryId, refreshKey]);

  const totals = data?.totals ?? { income: 0, expenses: 0, net: 0 };

  const summaryCards = [
    { label: t('income'), value: totals.income, icon: ArrowUpRight, tone: 'text-emerald-600' },
    { label: t('expenses'), value: totals.expenses, icon: ArrowDownRight, tone: 'text-red-600' },
    {
      label: t('net'),
      value: totals.net,
      icon: Scale,
      tone: totals.net >= 0 ? 'text-emerald-600' : 'text-red-600',
    },
  ] as const;

  return (
    <div className={cn('space-y-4 sm:space-y-6', loading && 'opacity-70 transition-opacity')}>
      {/* Current balance — money in the bank right now, distinct from cash flow. */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {t('currentBalance')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <p className="text-3xl font-bold tabular-nums">
              {formatCurrency(balances?.total ?? 0, balances?.currency ?? 'ILS')}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{t('balanceNote')}</p>
          </div>
          {balances && balances.accounts.length > 0 ? (
            <ul className="divide-y text-sm">
              {balances.accounts.map((a) => (
                <li key={a.id} className="flex min-w-0 items-center justify-between gap-3 py-2">
                  <span className="min-w-0 truncate text-muted-foreground">
                    {a.displayName} · {a.userName}
                  </span>
                  <span className="shrink-0 font-medium tabular-nums">
                    {formatCurrency(a.balance, a.currency)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t('noAccounts')}</p>
          )}
        </CardContent>
      </Card>

      {/* Investments — cumulative money moved into investment houses, tracked
          separately from income/expense. Click-through to the breakdown. */}
      <Link href="/investments" className="block" aria-label={tInvest('title')}>
        <Card className="transition-colors hover:bg-accent/50">
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {tInvest('title')}
            </CardTitle>
            <TrendingUp className="h-4 w-4 text-primary" aria-hidden />
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold tabular-nums">
              {formatCurrency(investments?.totalInvested ?? 0)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {tInvest('cardNote', {
                thisMonth: formatCurrency(investments?.thisMonth.net ?? 0),
              })}
            </p>
          </CardContent>
        </Card>
      </Link>

      {/* Cash flow for the selected period. */}
      <h2 className="text-sm font-medium text-muted-foreground">{t('cashFlow')}</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
        {summaryCards.map(({ label, value, icon: Icon, tone }) => (
          <Card key={label}>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
              <Icon className={cn('h-4 w-4', tone)} aria-hidden />
            </CardHeader>
            <CardContent>
              <p className={cn('text-2xl font-bold tabular-nums', tone)}>
                {formatCurrency(value)}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ExpensePieChart
          data={data?.breakdown ?? []}
          onColorSaved={() => setRefreshKey((k) => k + 1)}
        />
        <SpendingLineChart
          data={data?.trend ?? []}
          granularity={granularity}
          onGranularityChange={setGranularity}
          categories={categories}
          categoryId={trendCategoryId}
          onCategoryChange={(value) => setTrendCategoryId(value === '__all__' ? '' : value)}
        />
      </div>
    </div>
  );
}
