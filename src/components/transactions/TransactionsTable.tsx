'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Search, StickyNote } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { TransactionAmount } from '@/components/transactions/TransactionAmount';
import {
  TransactionDetailsDialog,
  type TransactionDetails,
} from '@/components/transactions/TransactionDetailsDialog';
import { cn, formatDate } from '@/lib/utils';
import { transactionMemoText } from '@/lib/services/transactionMemo';

export interface CategoryOption {
  id: number;
  name: string;
  color: string;
}

export interface TransactionRow {
  id: string;
  date: string;
  description: string;
  /** Provider-supplied detail, such as the Bit recipient. */
  memo: string | null;
  chargedAmount: number;
  /** Settlement currency of chargedAmount (primary display). */
  chargedCurrency: string;
  /** Merchant-side amount/currency; secondary display when currency differs. */
  originalAmount: number | null;
  originalCurrency: string | null;
  categoryId: number | null;
  categorizationSource: 'UNASSIGNED' | 'RULE' | 'LLM' | 'MANUAL';
  category: { id: number; name: string; color: string } | null;
  /** User's free-text note; null/undefined when none. */
  note?: string | null;
  /** Semantic same-sign refund (ADR-0024): raw amount stays negative, shown as +|amount|. */
  isRefund?: boolean;
  account: {
    displayName: string;
    provider: string;
    accountNumber: string;
    kind: 'BANK' | 'CARD';
    user: { name: string };
  };
}

interface TransactionsTableProps {
  transactions: TransactionRow[];
  categories: CategoryOption[];
  onCategoryChange: (transaction: TransactionRow, categoryId: number) => void;
  /** Confirm the current (heuristic) category as the user's own choice. */
  onConfirm?: (transaction: TransactionRow) => void;
  /** Open the "find similar transactions" dialog for a row. */
  onFindSimilar?: (transaction: TransactionRow) => void;
  /** A note was saved (string) or deleted (null) from the details dialog. */
  onNoteChange?: (transactionId: string, note: string | null) => void;
  /** The refund flag was toggled from the details dialog. */
  onRefundChange?: (transactionId: string, isRefund: boolean) => void;
}

const UNCATEGORIZED = '__none__';

export function TransactionsTable({
  transactions,
  categories,
  onCategoryChange,
  onConfirm,
  onFindSimilar,
  onNoteChange,
  onRefundChange,
}: TransactionsTableProps) {
  const t = useTranslations('transactions');
  const tDetails = useTranslations('transactionDetails');
  const [detailsTransaction, setDetailsTransaction] = useState<TransactionDetails | null>(null);
  if (transactions.length === 0) {
    return <p className="py-16 text-center text-sm text-muted-foreground">{t('empty')}</p>;
  }

  const openDetailsProps = (txn: TransactionRow) => ({
    tabIndex: txn.chargedAmount < 0 ? 0 : undefined,
    'aria-label':
      txn.chargedAmount < 0
        ? tDetails('openAria', { description: txn.description })
        : undefined,
    onClick: () => txn.chargedAmount < 0 && setDetailsTransaction(txn),
    onKeyDown: (event: React.KeyboardEvent) => {
      if (txn.chargedAmount >= 0 || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      setDetailsTransaction(txn);
    },
  });

  const noteIndicator = (txn: TransactionRow, className: string) =>
    txn.note ? (
      <span
        className={cn('inline-flex shrink-0 text-amber-600', className)}
        role="img"
        aria-label={tDetails('hasNoteAria')}
        title={txn.note}
      >
        <StickyNote className="h-3.5 w-3.5" aria-hidden />
      </span>
    ) : null;

  const categorySelect = (txn: TransactionRow, mobile = false) => (
    <Select
      value={txn.categoryId !== null ? String(txn.categoryId) : UNCATEGORIZED}
      onValueChange={(value) => {
        if (value !== UNCATEGORIZED) onCategoryChange(txn, Number(value));
      }}
    >
      <SelectTrigger
        className={cn(mobile ? 'h-11 min-w-0 flex-1 text-sm' : 'h-8 text-xs')}
        aria-label={t('categoryForAria', { description: txn.description })}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <SelectValue placeholder={t('uncategorized')} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNCATEGORIZED} disabled>
          {t('uncategorized')}
        </SelectItem>
        {categories.map((category) => (
          <SelectItem key={category.id} value={String(category.id)}>
            <span className="flex items-center gap-2">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: category.color }}
                aria-hidden
              />
              {category.name}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <>
      <div className="space-y-2 md:hidden">
        {transactions.map((txn) => (
          <article
            key={txn.id}
            className={cn(
              'rounded-xl border bg-background p-3 shadow-sm',
              txn.chargedAmount < 0 && 'cursor-pointer',
            )}
            {...openDetailsProps(txn)}
          >
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  {txn.categorizationSource !== 'MANUAL' && (
                    <span
                      className="h-2 w-2 shrink-0 rounded-full bg-emerald-500"
                      role="img"
                      aria-label={t('notReviewed')}
                      title={t('notReviewed')}
                    />
                  )}
                  <p className="truncate text-sm font-semibold" title={txn.description}>
                    {txn.description}
                  </p>
                  {noteIndicator(txn, '')}
                </div>
                {transactionMemoText(txn.memo) && (
                  <p className="mt-1 truncate text-xs text-muted-foreground" title={transactionMemoText(txn.memo) ?? undefined}>
                    {transactionMemoText(txn.memo)}
                  </p>
                )}
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {formatDate(txn.date)} · {txn.account.displayName}
                </p>
              </div>
              <TransactionAmount txn={txn} className="shrink-0 text-sm" />
            </div>
            <div
              className="mt-3 flex items-center gap-2"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              {categorySelect(txn, true)}
              {onFindSimilar && (
                <Button
                  size="icon"
                  variant="outline"
                  className="h-11 w-11 shrink-0 rounded-xl"
                  aria-label={t('findSimilarAria', { description: txn.description })}
                  title={t('findSimilarAria', { description: txn.description })}
                  onClick={() => onFindSimilar(txn)}
                >
                  <Search className="h-5 w-5 text-muted-foreground" aria-hidden />
                </Button>
              )}
              {onConfirm && txn.categorizationSource !== 'MANUAL' && txn.categoryId !== null && (
                <Button
                  size="icon"
                  variant="outline"
                  className="h-11 w-11 shrink-0 rounded-xl"
                  aria-label={t('confirmAria', { description: txn.description })}
                  title={t('confirmAria', { description: txn.description })}
                  onClick={() => onConfirm(txn)}
                >
                  <Check className="h-5 w-5 text-emerald-600" aria-hidden />
                </Button>
              )}
            </div>
          </article>
        ))}
      </div>

      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('colDate')}</TableHead>
              <TableHead>{t('colDescription')}</TableHead>
              <TableHead>{t('colAccount')}</TableHead>
              <TableHead className="text-end">{t('colAmount')}</TableHead>
              <TableHead className="w-48">{t('colCategory')}</TableHead>
              <TableHead className="hidden w-20 lg:table-cell">{t('colSource')}</TableHead>
              {onFindSimilar && (
                <TableHead className="w-10">
                  <span className="sr-only">{t('colActions')}</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {transactions.map((txn) => (
              <TableRow
                key={txn.id}
                className={txn.chargedAmount < 0 ? 'cursor-pointer' : undefined}
                {...openDetailsProps(txn)}
              >
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {formatDate(txn.date)}
                </TableCell>
                <TableCell className="max-w-[16rem] font-medium">
                  <div className="truncate" title={txn.description}>
                    {txn.categorizationSource !== 'MANUAL' && (
                      <span
                        className="me-2 inline-block h-2 w-2 shrink-0 rounded-full bg-emerald-500 align-middle"
                        role="img"
                        aria-label={t('notReviewed')}
                        title={t('notReviewed')}
                      />
                    )}
                    {txn.description}
                    {noteIndicator(txn, 'ms-2 inline-block align-middle')}
                  </div>
                  {transactionMemoText(txn.memo) && (
                    <div className="truncate text-xs font-normal text-muted-foreground" title={transactionMemoText(txn.memo) ?? undefined}>
                      {transactionMemoText(txn.memo)}
                    </div>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {txn.account.displayName}
                </TableCell>
                <TableCell className="whitespace-nowrap text-end">
                  <TransactionAmount txn={txn} />
                </TableCell>
                <TableCell
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  {categorySelect(txn)}
                </TableCell>
                <TableCell
                  className="hidden lg:table-cell"
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <div className="flex items-center gap-2">
                    <Badge variant={txn.categorizationSource === 'MANUAL' ? 'default' : 'secondary'}>
                      {t(`source.${txn.categorizationSource.toLowerCase()}`)}
                    </Badge>
                    {onConfirm && txn.categorizationSource !== 'MANUAL' && txn.categoryId !== null && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        aria-label={t('confirmAria', { description: txn.description })}
                        title={t('confirmAria', { description: txn.description })}
                        onClick={() => onConfirm(txn)}
                      >
                        <Check className="h-4 w-4 text-emerald-600" aria-hidden />
                      </Button>
                    )}
                  </div>
                </TableCell>
                {onFindSimilar && (
                  <TableCell
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label={t('findSimilarAria', { description: txn.description })}
                      title={t('findSimilarAria', { description: txn.description })}
                      onClick={() => onFindSimilar(txn)}
                    >
                      <Search className="h-4 w-4 text-muted-foreground" aria-hidden />
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <TransactionDetailsDialog
        transaction={detailsTransaction}
        onClose={() => setDetailsTransaction(null)}
        onNoteChange={(transactionId, note) => {
          setDetailsTransaction((current) =>
            current && current.id === transactionId ? { ...current, note } : current,
          );
          onNoteChange?.(transactionId, note);
        }}
        onRefundChange={(transactionId, isRefund) => {
          setDetailsTransaction((current) =>
            current && current.id === transactionId ? { ...current, isRefund } : current,
          );
          onRefundChange?.(transactionId, isRefund);
        }}
      />
    </>
  );
}
