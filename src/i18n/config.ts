/** Locale configuration for cookie-based (non-routed) i18n. */
export const locales = ['en', 'he'] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = 'he';

/** Locales rendered right-to-left. */
export const RTL_LOCALES: readonly Locale[] = ['he'];

/** Cookie that persists the reader's chosen locale. */
export const LOCALE_COOKIE = 'LOCALE';

export function isLocale(value: string | undefined | null): value is Locale {
  return !!value && (locales as readonly string[]).includes(value);
}

export function dirFor(locale: Locale): 'rtl' | 'ltr' {
  return RTL_LOCALES.includes(locale) ? 'rtl' : 'ltr';
}
