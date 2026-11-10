'use client';

/**
 * TransactionAmount — the single way transaction money is rendered.
 * Primary: the settlement (chargedAmount in chargedCurrency), colored by sign.
 * Secondary: the merchant-side original amount, shown small + muted only when
 * its currency differs (e.g. a EUR booking charged in ILS).
 *
 * A row marked isRefund (same-sign provider refund, ADR-0024) keeps its raw
 * negative amount in the API/DB but renders as green positive income using
 * the absolute amount, with a small "refund" label.
 */
import { useTranslations } from 'next-intl';
import {
  formatMoney,
  getDisplayAmounts,
  type TransactionMoney,
} from '@/lib/services/currencyDisplay';
import { cn } from '@/lib/utils';

interface TransactionAmountProps {
  txn: TransactionMoney;
  className?: string;
}

export function TransactionAmount({ txn, className }: TransactionAmountProps) {
  const t = useTranslations('transactions');
  const { primary, secondary } = getDisplayAmounts(txn);
  return (
    <span className={cn('inline-flex flex-col items-end', className)}>
      <span
        className={cn(
          'font-semibold tabular-nums',
          primary.amount < 0 ? 'text-red-600' : 'text-emerald-600',
        )}
        title={txn.isRefund ? t('refundBadgeHint') : undefined}
      >
        {formatMoney(primary.amount, primary.currency)}
      </span>
      {txn.isRefund && (
        <span className="text-[0.65rem] font-medium leading-tight text-emerald-700">
          {t('refundBadge')}
        </span>
      )}
      {secondary && (
        <span className="text-xs font-normal tabular-nums text-muted-foreground" dir="ltr">
          {formatMoney(secondary.amount, secondary.currency)}
        </span>
      )}
    </span>
  );
}
