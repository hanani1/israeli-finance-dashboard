/**
 * Category service — persistence + validation for category attributes that
 * users can edit (currently: the display color).
 */
import { prisma } from '@/lib/db';

/** #RGB or #RRGGBB (case-insensitive). */
const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** True when the value is a valid hex CSS color (#RGB or #RRGGBB). */
export function isValidCategoryColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR_PATTERN.test(value.trim());
}

/** Normalize a validated hex color to lowercase 6-digit #rrggbb form. */
export function normalizeCategoryColor(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 4) {
    const [, r, g, b] = trimmed;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return trimmed;
}

/**
 * Update a category's display color. The caller must have validated the color
 * with isValidCategoryColor. Throws Prisma P2025 when the category is missing.
 */
export async function updateCategoryColor(categoryId: number, color: string) {
  return prisma.category.update({
    where: { id: categoryId },
    data: { color: normalizeCategoryColor(color) },
  });
}
