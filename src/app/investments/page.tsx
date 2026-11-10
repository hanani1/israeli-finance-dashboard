'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { TrendingUp } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useGlobalFilters } from '@/lib/hooks/useGlobalFilters';
import { cn, formatCurrency } from '@/lib/utils';

interface HouseSummary {
  house: string;
  deposits: number;
  withdrawals: number;
  net: number;
  count: number;
}

interface MonthlyActivity {
  month: string;
  deposits: number;
  withdrawals: number;
  net: number;
}

interface InvestmentsResponse {
  totalDeposits: number;
  totalWithdrawals: number;
  totalInvested: number;
  count: number;
  houses: HouseSummary[];
  monthly: MonthlyActivity[];
  thisMonth: MonthlyActivity;
}

/**
 * השקעות — money moved to/from investment houses (אלטשולר שחם, מיטב דש, …).
 * Excluded from income/expense analytics (like inter-account transfers) and
 * broken down here by investment house and by month.
 */
export default function InvestmentsPage() {
  const t = useTranslations('investments');
  const { toQueryString } = useGlobalFilters();
  const [data, setData] = useState<InvestmentsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const queryString = toQueryString();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/investments?${queryString}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Investments request failed (${res.status})`);
        return res.json();
      })
      .then((payload: InvestmentsResponse) => {
        if (!cancelled) setData(payload);
      })
      .catch((error) => console.error(error))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [queryString]);

  const summaryCards = [
    { key: 'totalInvested', value: data?.totalInvested ?? 0 },
    { key: 'totalDeposits', value: data?.totalDeposits ?? 0 },
    { key: 'totalWithdrawals', value: data?.totalWithdrawals ?? 0 },
  ] as const;

  return (
    <div className={cn('space-y-4 sm:space-y-6', loading && 'opacity-70 transition-opacity')}>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingUp className="h-4 w-4 text-primary" aria-hidden />
            {t('title')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
        {summaryCards.map(({ key, value }) => (
          <Card key={key}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{t(key)}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold tabular-nums">{formatCurrency(value)}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {data && data.count === 0 && !loading ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {t('empty')}
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {t('byHouse')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="divide-y">
                {(data?.houses ?? []).map((house) => (
                  <li key={house.house} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{house.house}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t('houseDetail', {
                          count: house.count,
                          deposits: formatCurrency(house.deposits),
                          withdrawals: formatCurrency(house.withdrawals),
                        })}
                      </p>
                    </div>
                    <span
                      className={cn(
                        'shrink-0 text-sm font-semibold tabular-nums',
                        house.net >= 0 ? 'text-emerald-600' : 'text-red-600',
                      )}
                    >
                      {formatCurrency(house.net)}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {t('monthlyActivity')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div
                className="h-72 w-full"
                role="img"
                aria-label="Bar chart of monthly investment deposits and withdrawals"
              >
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data?.monthly ?? []} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                    <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                    <YAxis
                      tick={{ fontSize: 11 }}
                      width={70}
                      tickFormatter={(value) => formatCurrency(Number(value))}
                    />
                    <Tooltip formatter={(value) => formatCurrency(Number(value))} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar
                      dataKey="deposits"
                      name={t('deposits')}
                      fill="#0f766e"
                      radius={[4, 4, 0, 0]}
                    />
                    <Bar
                      dataKey="withdrawals"
                      name={t('withdrawals')}
                      fill="#ef4444"
                      radius={[4, 4, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
