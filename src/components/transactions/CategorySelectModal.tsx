'use client';

/**
 * Auto-rule generation modal.
 *
 * Shown after a user manually categorizes a transaction. Offers to create a
 * CategorizationRule so all future (and current uncategorized) transactions
 * matching the merchant description get the same category automatically.
 */
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { describeApiError } from '@/lib/client/api';

export interface AutoRulePrompt {
  merchant: string;
  categoryId: number;
  categoryName: string;
}

interface CategorySelectModalProps {
  prompt: AutoRulePrompt | null;
  onClose: () => void;
  /**
   * Called with the confirmed pattern; parent creates the rule + applies it.
   * A rejection keeps the modal open and shows the error.
   */
  onConfirm: (pattern: string, categoryId: number) => Promise<void>;
}

export function CategorySelectModal({ prompt, onClose, onConfirm }: CategorySelectModalProps) {
  const t = useTranslations('rules');
  const tCommon = useTranslations('common');
  const [pattern, setPattern] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (prompt) {
      setPattern(prompt.merchant);
      setSaving(false);
      setError(null);
    }
  }, [prompt]);

  const handleConfirm = async () => {
    if (!prompt || !pattern.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onConfirm(pattern.trim(), prompt.categoryId);
      onClose();
    } catch (e) {
      setError(describeApiError(e, t('errCreate'), { networkMessage: tCommon('networkError') }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={prompt !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="h-4 w-4 text-primary" aria-hidden />
            {t('autoTitle')}
          </DialogTitle>
          <DialogDescription>
            {t.rich('autoDesc', {
              merchant: prompt?.merchant ?? '',
              category: prompt?.categoryName ?? '',
              b: (chunks) => <span className="font-semibold text-foreground">{chunks}</span>,
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="rule-pattern">{t('patternLabel')}</Label>
          <Input
            id="rule-pattern"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder={t('patternPlaceholder')}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t('declineOne')}
          </Button>
          <Button onClick={handleConfirm} disabled={saving || !pattern.trim()}>
            {saving ? tCommon('saving') : t('confirmCreate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
