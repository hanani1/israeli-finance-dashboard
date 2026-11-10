'use client';

/**
 * One-by-one categorization review. Walks through the transactions the user has
 * not personally confirmed (source != MANUAL), pre-selecting the category our
 * heuristics (rule / LLM) already suggested so the user can just confirm.
 * It only advances after the save succeeded; a failure keeps the user on the
 * same item with the error shown (card #51).
 */
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TransactionAmount } from '@/components/transactions/TransactionAmount';
import type { CategoryOption, TransactionRow } from '@/components/transactions/TransactionsTable';
import { describeApiError } from '@/lib/client/api';
import { formatDate } from '@/lib/utils';

interface CategorizeReviewModalProps {
  open: boolean;
  items: TransactionRow[];
  categories: CategoryOption[];
  /** Persists the category; must reject on failure so the modal stays on the item. */
  onConfirm: (transactionId: string, categoryId: number) => Promise<void> | void;
  onClose: () => void;
}

export function CategorizeReviewModal({
  open,
  items,
  categories,
  onConfirm,
  onClose,
}: CategorizeReviewModalProps) {
  const t = useTranslations('review');
  const tCat = useTranslations('rules');
  const tCommon = useTranslations('common');
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset to the first item whenever the modal (re)opens.
  useEffect(() => {
    if (open) {
      setIndex(0);
      setError(null);
    }
  }, [open]);

  const current = items[index];

  // Pre-fill with the heuristic category for the current item.
  useEffect(() => {
    setSelected(current?.categoryId != null ? String(current.categoryId) : '');
  }, [current]);

  const finished = open && items.length > 0 && index >= items.length;

  const confirm = async () => {
    if (!current || !selected) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(current.id, Number(selected));
      setIndex((i) => i + 1);
    } catch (e) {
      setError(describeApiError(e, t('errConfirm'), { networkMessage: tCommon('networkError') }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>

        {items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t('empty')}</p>
        ) : finished ? (
          <p className="py-8 text-center text-sm font-medium">{t('done')}</p>
        ) : current ? (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              {t('progress', { current: index + 1, total: items.length })}
            </p>
            <div className="rounded-md border p-3">
              <div className="flex items-start justify-between gap-3">
                <span className="font-medium">{current.description}</span>
                <TransactionAmount txn={current} className="shrink-0" />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {formatDate(current.date)} · {current.account.displayName}
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">{t('suggested')}</label>
              <Select value={selected} onValueChange={setSelected}>
                <SelectTrigger aria-label={tCat('category')}>
                  <SelectValue placeholder={tCat('chooseCategory')} />
                </SelectTrigger>
                <SelectContent>
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
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
        ) : null}

        <DialogFooter>
          {finished || items.length === 0 ? (
            <Button onClick={onClose}>{t('close')}</Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setError(null);
                  setIndex((i) => i + 1);
                }}
                disabled={busy}
              >
                {t('skip')}
              </Button>
              <Button onClick={confirm} disabled={busy || !selected}>
                {t('confirm')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
