'use client';

import { useTranslations } from 'next-intl';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { CategoryColorButton } from '@/components/categories/CategoryColorButton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatSharePercent, sliceSharePercent } from '@/lib/services/chartShare';
import { formatCurrency } from '@/lib/utils';

export interface BreakdownSlice {
  categoryId: number | null;
  name: string;
  color: string;
  total: number;
}

interface ExpensePieChartProps {
  data: BreakdownSlice[];
  /**
   * When provided, legend swatches for real categories become accessible
   * color-edit buttons; called after a color is saved so the caller can
   * refetch the (server-colored) data.
   */
  onColorSaved?: () => void;
}

/** Expense breakdown by category (donut) with a color-editable legend. */
export function ExpensePieChart({ data, onColorSaved }: ExpensePieChartProps) {
  const t = useTranslations('dashboard');
  // Localize the server-provided "Uncategorized" slice so the legend and hover
  // tooltip read in the active language.
  const localized = data.map((slice) =>
    slice.categoryId === null ? { ...slice, name: t('uncategorized') } : slice,
  );
  // Each slice's share of the visible total, shown in the tooltip and legend.
  const shareOf = (total: number): string =>
    formatSharePercent(sliceSharePercent(total, localized));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('expenseBreakdown')}</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">{t('noExpenses')}</p>
        ) : (
          <>
            <div
              className="h-64 w-full"
              role="img"
              aria-label="Pie chart of expenses by category"
            >
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={localized}
                    dataKey="total"
                    nameKey="name"
                    innerRadius="55%"
                    outerRadius="80%"
                    paddingAngle={2}
                    strokeWidth={1}
                  >
                    {localized.map((slice) => (
                      <Cell key={slice.name} fill={slice.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value) =>
                      `${formatCurrency(Number(value))} · ${shareOf(Number(value))}`
                    }
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            {/* Legend outside the role="img" chart so the color-edit buttons
                stay in the accessibility tree. */}
            <ul className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs">
              {localized.map((slice) => (
                <li
                  key={slice.categoryId ?? '__uncategorized__'}
                  className="flex items-center gap-1.5"
                >
                  {slice.categoryId !== null && onColorSaved ? (
                    <CategoryColorButton
                      categoryId={slice.categoryId}
                      categoryName={slice.name}
                      color={slice.color}
                      onSaved={onColorSaved}
                      className="h-2.5 w-2.5"
                    />
                  ) : (
                    <span
                      className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: slice.color }}
                      aria-hidden
                    />
                  )}
                  <span>{slice.name}</span>
                  <span className="text-muted-foreground">{shareOf(slice.total)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
