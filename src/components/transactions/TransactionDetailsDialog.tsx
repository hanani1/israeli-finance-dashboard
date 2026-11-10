'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Pencil, StickyNote, Trash2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatMoney } from '@/lib/services/currencyDisplay';
import { NOTE_MAX_LENGTH } from '@/lib/services/transactionNote';
import { cn, formatDate } from '@/lib/utils';

export interface TransactionDetails {
  id: string;
  date: string | Date;
  description: string;
  /** Provider-supplied detail, such as the Bit recipient. */
  memo: string | null;
  chargedAmount: number;
  chargedCurrency: string;
  originalAmount: number | null;
  originalCurrency: string | null;
  category: { name: string } | null;
  /** User's free-text note; null when none. */
  note?: string | null;
  /** Semantic same-sign refund (ADR-0024); raw chargedAmount stays negative. */
  isRefund?: boolean;
  account: {
    displayName: string;
    provider: string;
    accountNumber: string;
    kind: 'BANK' | 'CARD';
    user: { name: string };
  };
}

interface TransactionDetailsDialogProps {
  transaction: TransactionDetails | null;
  onClose: () => void;
  /** Called after a note is saved or deleted (null = deleted) so lists can update. */
  onNoteChange?: (transactionId: string, note: string | null) => void;
  /** Called after the refund flag is toggled so lists and totals can update. */
  onRefundChange?: (transactionId: string, isRefund: boolean) => void;
}

/** Persist a note through the API; empty text deletes it. */
async function saveNote(transactionId: string, note: string): Promise<string | null> {
  const response = await fetch(`/api/transactions/${transactionId}/note`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as { note: string | null };
  return body.note;
}

/** Persist the semantic refund flag through the transaction PATCH route. */
async function saveRefund(transactionId: string, isRefund: boolean): Promise<boolean> {
  const response = await fetch(`/api/transactions/${transactionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isRefund }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as { isRefund: boolean };
  return body.isRefund;
}

export function TransactionDetailsDialog({
  transaction,
  onClose,
  onNoteChange,
  onRefundChange,
}: TransactionDetailsDialogProps) {
  const t = useTranslations('transactionDetails');
  const cardSuffix =
    transaction?.account.kind === 'CARD' ? transaction.account.accountNumber.slice(-4) : null;

  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isRefund, setIsRefund] = useState(false);
  const [refundSaving, setRefundSaving] = useState(false);
  const [refundError, setRefundError] = useState<string | null>(null);

  // Reset editor state whenever a different transaction is shown.
  useEffect(() => {
    setNote(transaction?.note ?? null);
    setEditing(false);
    setDraft(transaction?.note ?? '');
    setSaving(false);
    setError(null);
  }, [transaction?.id, transaction?.note]);

  useEffect(() => {
    setIsRefund(transaction?.isRefund ?? false);
    setRefundSaving(false);
    setRefundError(null);
  }, [transaction?.id, transaction?.isRefund]);

  const toggleRefund = async () => {
    if (!transaction) return;
    setRefundSaving(true);
    setRefundError(null);
    try {
      const saved = await saveRefund(transaction.id, !isRefund);
      setIsRefund(saved);
      onRefundChange?.(transaction.id, saved);
    } catch {
      setRefundError(t('refundSaveFailed'));
    } finally {
      setRefundSaving(false);
    }
  };

  const draftLength = [...draft].length;
  const tooLong = draftLength > NOTE_MAX_LENGTH;

  const commit = async (value: string) => {
    if (!transaction) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveNote(transaction.id, value);
      setNote(saved);
      setDraft(saved ?? '');
      setEditing(false);
      onNoteChange?.(transaction.id, saved);
    } catch {
      setError(t('noteSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={transaction !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{transaction?.description ?? ''}</DialogDescription>
        </DialogHeader>

        {transaction && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 text-sm">
            <dt className="text-muted-foreground">{t('account')}</dt>
            <dd className="font-medium">{transaction.account.displayName}</dd>

            <dt className="text-muted-foreground">{t('provider')}</dt>
            <dd dir="ltr">{transaction.account.provider}</dd>

            {cardSuffix && (
              <>
                <dt className="text-muted-foreground">{t('cardSuffix')}</dt>
                <dd dir="ltr">•••• {cardSuffix}</dd>
              </>
            )}

            <dt className="text-muted-foreground">{t('member')}</dt>
            <dd>{transaction.account.user.name}</dd>

            <dt className="text-muted-foreground">{t('date')}</dt>
            <dd>{formatDate(transaction.date)}</dd>

            {transaction.memo?.trim() && (
              <>
                <dt className="text-muted-foreground">{t('providerDetail')}</dt>
                <dd className="whitespace-pre-wrap">{transaction.memo.trim()}</dd>
              </>
            )}

            <dt className="text-muted-foreground">{t('category')}</dt>
            <dd>{transaction.category?.name ?? t('uncategorized')}</dd>

            <dt className="text-muted-foreground">{t('chargedAmount')}</dt>
            <dd className="font-semibold tabular-nums" dir="ltr">
              {formatMoney(transaction.chargedAmount, transaction.chargedCurrency)}
              <span className="ms-2 font-normal text-muted-foreground">
                {transaction.chargedCurrency}
              </span>
            </dd>

            <dt className="text-muted-foreground">{t('originalAmount')}</dt>
            <dd className="tabular-nums" dir="ltr">
              {transaction.originalAmount !== null ? (
                <>
                  {formatMoney(
                    transaction.originalAmount,
                    transaction.originalCurrency ?? transaction.chargedCurrency,
                  )}
                  <span className="ms-2 text-muted-foreground">
                    {transaction.originalCurrency ?? transaction.chargedCurrency}
                  </span>
                </>
              ) : (
                t('notAvailable')
              )}
            </dd>
          </dl>
        )}

        {transaction && (transaction.chargedAmount < 0 || isRefund) && (
          <section className="rounded-lg border bg-muted/30 p-3 text-sm" aria-labelledby="txn-refund-heading">
            <div className="flex items-center justify-between gap-2">
              <h3 id="txn-refund-heading" className="flex items-center gap-2 font-medium">
                <Undo2 className="h-4 w-4 text-muted-foreground" aria-hidden />
                {t('refund')}
              </h3>
              <Button
                size="sm"
                variant={isRefund ? 'outline' : 'ghost'}
                className="h-8"
                disabled={refundSaving}
                aria-pressed={isRefund}
                onClick={() => void toggleRefund()}
              >
                {refundSaving ? t('refundSaving') : isRefund ? t('refundUnmark') : t('refundMark')}
              </Button>
            </div>
            <p className={cn('mt-2', isRefund ? 'text-emerald-700' : 'text-muted-foreground')}>
              {isRefund
                ? t('refundMarked', {
                    amount: formatMoney(Math.abs(transaction.chargedAmount), transaction.chargedCurrency),
                  })
                : t('refundHint')}
            </p>
            {refundError && (
              <p role="alert" className="mt-2 text-xs text-destructive">
                {refundError}
              </p>
            )}
          </section>
        )}

        {transaction && (
          <section className="rounded-lg border bg-muted/30 p-3 text-sm" aria-labelledby="txn-note-heading">
            <div className="flex items-center justify-between gap-2">
              <h3 id="txn-note-heading" className="flex items-center gap-2 font-medium">
                <StickyNote className="h-4 w-4 text-muted-foreground" aria-hidden />
                {t('note')}
              </h3>
              {!editing && (
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8"
                    onClick={() => {
                      setDraft(note ?? '');
                      setEditing(true);
                    }}
                  >
                    <Pencil className="me-1 h-3.5 w-3.5" aria-hidden />
                    {note ? t('noteEdit') : t('noteAdd')}
                  </Button>
                  {note && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 text-destructive hover:text-destructive"
                      disabled={saving}
                      onClick={() => void commit('')}
                      aria-label={t('noteDelete')}
                      title={t('noteDelete')}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  )}
                </div>
              )}
            </div>

            {editing ? (
              <form
                className="mt-2 space-y-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!tooLong) void commit(draft);
                }}
              >
                <label htmlFor="txn-note-input" className="sr-only">
                  {t('note')}
                </label>
                <textarea
                  id="txn-note-input"
                  className={cn(
                    'min-h-[5rem] w-full resize-y rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    tooLong && 'border-destructive',
                  )}
                  value={draft}
                  placeholder={t('notePlaceholder')}
                  maxLength={NOTE_MAX_LENGTH * 2}
                  autoFocus
                  disabled={saving}
                  aria-invalid={tooLong}
                  aria-describedby="txn-note-counter"
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      setEditing(false);
                      setDraft(note ?? '');
                    }
                  }}
                />
                <div className="flex items-center justify-between gap-2">
                  <span
                    id="txn-note-counter"
                    className={cn('text-xs tabular-nums', tooLong ? 'text-destructive' : 'text-muted-foreground')}
                    dir="ltr"
                  >
                    {tooLong
                      ? t('noteTooLong', { max: NOTE_MAX_LENGTH })
                      : t('noteCounter', { count: draftLength, max: NOTE_MAX_LENGTH })}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={saving}
                      onClick={() => {
                        setEditing(false);
                        setDraft(note ?? '');
                      }}
                    >
                      {t('noteCancel')}
                    </Button>
                    <Button type="submit" size="sm" disabled={saving || tooLong}>
                      {saving ? t('noteSaving') : t('noteSave')}
                    </Button>
                  </div>
                </div>
              </form>
            ) : note ? (
              <p className="mt-2 whitespace-pre-wrap break-words">{note}</p>
            ) : (
              <p className="mt-2 text-muted-foreground">{t('noteEmpty')}</p>
            )}
            {error && (
              <p role="alert" className="mt-2 text-xs text-destructive">
                {error}
              </p>
            )}
          </section>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
