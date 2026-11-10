'use client';

/**
 * CategoryColorButton — the category color swatch as an accessible edit
 * control. Rendered wherever a category legend/row shows its color dot;
 * clicking (or Enter/Space via keyboard) opens a dialog with a color picker +
 * hex input, and saves via PATCH /api/categories/[id].
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
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
import { cn } from '@/lib/utils';

/** #RGB or #RRGGBB — mirrors the server-side validation. */
const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Expand to 6-digit lowercase so <input type="color"> accepts the value. */
function toPickerValue(hex: string): string {
  const trimmed = hex.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(trimmed)) {
    const [, r, g, b] = trimmed;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return /^#[0-9a-f]{6}$/.test(trimmed) ? trimmed : '#888888';
}

interface CategoryColorButtonProps {
  categoryId: number;
  categoryName: string;
  color: string;
  /** Called with the saved color after a successful PATCH. */
  onSaved?: (color: string) => void;
  /** Swatch size classes, e.g. "h-3 w-3". */
  className?: string;
}

export function CategoryColorButton({
  categoryId,
  categoryName,
  color,
  onSaved,
  className,
}: CategoryColorButtonProps) {
  const t = useTranslations('categoryColor');
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(color);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const openDialog = () => {
    setDraft(toPickerValue(color));
    setError(null);
    setOpen(true);
  };

  const save = async () => {
    if (!HEX_COLOR_PATTERN.test(draft.trim())) {
      setError(t('invalid'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/categories/${categoryId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ color: draft.trim() }),
      });
      if (!res.ok) {
        setError(t('error'));
        return;
      }
      const updated = (await res.json()) as { color: string };
      setOpen(false);
      onSaved?.(updated.color);
    } catch {
      setError(t('error'));
    } finally {
      setSaving(false);
    }
  };

  const pickerId = `category-color-picker-${categoryId}`;
  const hexId = `category-color-hex-${categoryId}`;

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        aria-label={t('editAria', { name: categoryName })}
        title={t('editAria', { name: categoryName })}
        className={cn(
          'inline-block shrink-0 rounded-full ring-offset-background transition-shadow',
          'hover:ring-2 hover:ring-ring hover:ring-offset-1',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
          className ?? 'h-3 w-3',
        )}
        style={{ backgroundColor: color }}
      />

      <Dialog open={open} onOpenChange={(o) => !o && setOpen(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('title', { name: categoryName })}</DialogTitle>
            <DialogDescription>{t('description')}</DialogDescription>
          </DialogHeader>

          <div className="flex items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor={pickerId}>{t('colorLabel')}</Label>
              <input
                id={pickerId}
                type="color"
                className="block h-9 w-14 cursor-pointer rounded-md border bg-transparent p-1"
                value={toPickerValue(draft)}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setError(null);
                }}
              />
            </div>
            <div className="flex-1 space-y-1.5">
              <Label htmlFor={hexId}>{t('hexLabel')}</Label>
              <Input
                id={hexId}
                dir="ltr"
                value={draft}
                aria-invalid={error !== null}
                aria-describedby={error ? `${hexId}-error` : undefined}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setError(null);
                }}
                placeholder="#22C55E"
              />
            </div>
          </div>
          {error && (
            <p id={`${hexId}-error`} role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              {t('cancel')}
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? t('saving') : t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
