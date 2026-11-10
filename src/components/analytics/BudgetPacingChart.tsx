'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCurrency } from '@/lib/utils';

export interface BudgetPacingDatum {
  name: string;
  color: string;
  amount: number; // monthly budget
  spent: number; // spent so far
  expectedByNow: number; // pace target so far
  pace: 'under' | 'on' | 'over';
}

const PACE_COLORS: Record<BudgetPacingDatum['pace'], string> = {
  under: '#10b981',
  on: '#0f766e',
  over: '#ef4444',
};

interface BudgetPacingChartProps {
  title: string;
  data: BudgetPacingDatum[];
  emptyLabel: string;
  budgetLabel: string;
  spentLabel: string;
}

/** Grouped bars per category: full monthly budget vs. spend-to-date, colored by pace. */
export function BudgetPacingChart({
  title,
  data,
  emptyLabel,
  budgetLabel,
  spentLabel,
}: BudgetPacingChartProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">{emptyLabel}</p>
        ) : (
          <div
            className="h-72 w-full"
            role="img"
            aria-label="Bar chart of budget versus spend per category"
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} />
                <YAxis
                  tick={{ fontSize: 11 }}
                  width={70}
                  tickFormatter={(value) => formatCurrency(Number(value))}
                />
                <Tooltip formatter={(value) => formatCurrency(Number(value))} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="amount" name={budgetLabel} fill="#e2e8f0" radius={[4, 4, 0, 0]} />
                <Bar dataKey="spent" name={spentLabel} radius={[4, 4, 0, 0]}>
                  {data.map((entry) => (
                    <Cell key={entry.name} fill={PACE_COLORS[entry.pace]} />
                  ))}
                </Bar>
                <ReferenceLine y={0} className="stroke-border" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
