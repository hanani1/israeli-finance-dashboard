import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { defaultLocale, isLocale, LOCALE_COOKIE } from './config';
import en from '../../messages/en.json';
import he from '../../messages/he.json';

/**
 * Statically bundle both catalogs and pick by locale. Avoid a fully-dynamic
 * `import(`../../messages/${locale}.json`)`: Webpack's async context for that
 * can fail to emit a locale chunk (ENOENT on the generated module), which
 * cascades into obscure runtime errors.
 */
const MESSAGES = { en, he } as const;

/**
 * Resolve the active locale from the LOCALE cookie (no locale in the URL — this
 * is a single-user self-hosted app) and return its message catalog.
 */
export default getRequestConfig(async () => {
  const store = await cookies();
  const cookieLocale = store.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(cookieLocale) ? cookieLocale : defaultLocale;

  return { locale, messages: MESSAGES[locale] };
});
