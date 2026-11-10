'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight, ArrowLeftRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useGlobalFilters } from '@/lib/hooks/useGlobalFilters';
import { cn, formatCurrency, formatDate } from '@/lib/utils';

interface TransferPairView {
  id: string;
  date: string;
  amount: number;
  fromAccount: string;
  toAccount: string;
  fromDescription: string;
  toDescription: string;
}

interface TransfersResponse {
  pairs: TransferPairView[];
}

interface MonthGroup {
  month: string; // yyyy-MM
  total: number;
  pairs: TransferPairView[];
}

/**
 * העברות בין חשבונות — money moved between the household's own accounts.
 * These pairs are excluded from income/expense analytics and tracked here.
 */
export default function TransfersPage() {
  const t = useTranslations('transfers');
  const { filters } = useGlobalFilters();
  const [data, setData] = useState<TransfersResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = filters.userId ? `?userId=${filters.userId}` : '';
    fetch(`/api/transfers${params}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Transfers request failed (${res.status})`);
        return res.json();
      })
      .then((payload: TransfersResponse) => {
        if (!cancelled) setData(payload);
      })
      .catch((error) => console.error(error))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filters.userId]);

  const monthGroups = useMemo<MonthGroup[]>(() => {
    const groups = new Map<string, MonthGroup>();
    for (const pair of data?.pairs ?? []) {
      const month = pair.date.slice(0, 7);
      const group = groups.get(month) ?? { month, total: 0, pairs: [] };
      group.total += pair.amount;
      group.pairs.push(pair);
      groups.set(month, group);
    }
    // API returns newest-first; Map preserves insertion order.
    return Array.from(groups.values());
  }, [data]);

  return (
    <div className={cn('space-y-4 sm:space-y-6', loading && 'opacity-70 transition-opacity')}>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <ArrowLeftRight className="h-4 w-4 text-primary" aria-hidden />
            {t('title')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
        </CardContent>
      </Card>

      {monthGroups.length === 0 && !loading ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {t('empty')}
          </CardContent>
        </Card>
      ) : (
        monthGroups.map((group) => (
          <Card key={group.month}>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {group.month}
              </CardTitle>
              <span className="text-sm font-semibold tabular-nums">
                {t('monthTotal', { amount: formatCurrency(group.total) })}
              </span>
            </CardHeader>
            <CardContent>
              <ul className="divide-y">
                {group.pairs.map((pair) => (
                  <li key={pair.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 text-sm font-medium">
                        <span className="truncate">{pair.fromAccount}</span>
                        <ArrowRight
                          className="h-3.5 w-3.5 shrink-0 text-muted-foreground rtl:rotate-180"
                          aria-hidden
                        />
                        <span className="truncate">{pair.toAccount}</span>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {formatDate(pair.date)} · {pair.fromDescription}
                      </p>
                    </div>
                    <span className="shrink-0 text-sm font-semibold tabular-nums">
                      {formatCurrency(pair.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
