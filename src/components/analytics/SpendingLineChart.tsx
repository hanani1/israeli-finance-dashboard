'use client';

import { useTranslations } from 'next-intl';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatCurrency } from '@/lib/utils';

export type TrendGranularity = 'day' | 'month';

export interface TrendPoint {
  period: string;
  expenses: number;
  income: number;
}

export interface TrendCategory {
  id: number;
  name: string;
}

const ALL_CATEGORIES = '__all__';

interface SpendingLineChartProps {
  data: TrendPoint[];
  granularity: TrendGranularity;
  onGranularityChange: (granularity: TrendGranularity) => void;
  categories: TrendCategory[];
  categoryId: string;
  onCategoryChange: (categoryId: string) => void;
}

/** Spending trend over time with a Day/Month bucket toggle. */
export function SpendingLineChart({
  data,
  granularity,
  onGranularityChange,
  categories,
  categoryId,
  onCategoryChange,
}: SpendingLineChartProps) {
  const t = useTranslations('dashboard');
  return (
    <Card>
      <CardHeader className="flex-col items-start gap-3 space-y-0 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle>{t('spendingTrends')}</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={categoryId || ALL_CATEGORIES} onValueChange={onCategoryChange}>
            <SelectTrigger className="h-8 w-44 text-xs" aria-label={t('filterByCategory')}>
              <SelectValue placeholder={t('allCategories')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_CATEGORIES}>{t('allCategories')}</SelectItem>
              {categories.map((category) => (
                <SelectItem key={category.id} value={String(category.id)}>
                  {category.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex gap-1" role="group" aria-label={t('spendingTrends')}>
            {(['day', 'month'] as const).map((option) => (
              <Button
                key={option}
                size="sm"
                variant={granularity === option ? 'default' : 'outline'}
                aria-pressed={granularity === option}
                onClick={() => onGranularityChange(option)}
              >
                {option === 'day' ? t('day') : t('month')}
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">{t('noActivity')}</p>
        ) : (
          <div className="h-72 w-full" role="img" aria-label="Line chart of spending over time">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="period" tick={{ fontSize: 11 }} minTickGap={24} />
                <YAxis
                  tick={{ fontSize: 11 }}
                  width={70}
                  tickFormatter={(value) => formatCurrency(Number(value))}
                />
                <Tooltip formatter={(value) => formatCurrency(Number(value))} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line
                  type="monotone"
                  dataKey="expenses"
                  name={t('expenses')}
                  stroke="#ef4444"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="income"
                  name={t('income')}
                  stroke="#10b981"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
