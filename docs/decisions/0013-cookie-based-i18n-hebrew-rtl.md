# ADR-0013: Cookie-based internationalization with Hebrew/RTL via next-intl

- **Date:** 2026-08-17
- **Status:** Accepted
- **Area:** UI / Architecture
- **Owners:** Finance Dashboard maintainers

## Context

The audience is Israeli-bank users, but the UI was English-only and left-to-right. The
Spent evaluation ([ADR-0011](0011-borrow-from-spent-not-fork.md)) highlighted full
Hebrew/RTL support as a high-value, low-risk port. This app is single-user/household and
self-hosted, so per-locale URLs and locale-based SEO are irrelevant.

## Decision

Adopt **`next-intl` without i18n routing** — the locale lives in a cookie, not in the URL.

- **Locale resolution:** `src/i18n/config.ts` defines `locales = ['en','he']`, the default,
  the RTL set, and the `LOCALE` cookie. `src/i18n/request.ts` (`getRequestConfig`) reads the
  cookie server-side and loads `messages/{locale}.json`. The plugin is wired in
  `next.config.mjs` via `createNextIntlPlugin`.
- **Direction:** the root layout is async and sets `<html lang dir>` (`dir="rtl"` for
  Hebrew) and wraps the tree in `NextIntlClientProvider`.
- **Switching:** a `LocaleSwitcher` posts to `POST /api/locale`, which persists the cookie;
  the client then refreshes.
- **RTL layout:** directional utilities in shared chrome were made logical
  (`border-r → border-e`, `ml-auto → ms-auto`) so `dir="rtl"` mirrors correctly.

**Scope of translation (v1):** the app chrome and analytics — navigation, header,
dashboard, and the new Budgets page — plus the Hebrew catalog. **Non-goals for now:** the
Transactions and Settings page bodies remain English (keys to be added later), and broader
logical-property RTL polish across every component is a follow-up.

## Consequences

### Positive
- Hebrew + RTL work end-to-end with a persistent toggle, no route restructuring.
- Message catalogs make further translation additive; no new state library.

### Negative / risks
- Partial coverage: untranslated pages render English under Hebrew until keys are added.
- Some deep components still use physical (non-logical) spacing utilities in RTL.

## Alternatives considered

- **`next-intl` with `[locale]` routing:** rejected — invasive route restructuring with no
  benefit for a single-user app that needs no per-locale URLs.
- **`i18next`/`react-i18next`:** rejected — heavier client setup; `next-intl` fits the App
  Router server/client split better.

## References

- `src/i18n/config.ts`, `src/i18n/request.ts`, `messages/en.json`, `messages/he.json`
- `next.config.mjs`, `src/app/layout.tsx`, `src/app/api/locale/route.ts`
- `src/components/layout/LocaleSwitcher.tsx`
- `docs/REQUIREMENTS.md §3.9`, `docs/DESIGN.md §10`
