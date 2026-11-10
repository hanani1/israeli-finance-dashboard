# ADR-0003: Use bank website scraping before Open Banking

- **Date:** 2026-08-05
- **Status:** Accepted
- **Area:** Business / Architecture
- **Owners:** Finance Dashboard maintainers

## Context

The product needs automated Israeli bank and card ingestion. Direct Open Banking access can offer a stronger long-term interface but introduces licensing, consent, provider integration, and operational requirements that are disproportionate for a private household deployment.

## Decision

Use the pinned `israeli-bank-scrapers` package and Puppeteer for the first version. Isolate scraping in the ingestion job so a future Open Banking adapter can replace the acquisition layer without changing transaction storage, categorization, or analytics contracts.

## Consequences

### Positive
- Supports major Israeli providers without operating a regulated integration.
- Enables immediate household use and keeps the rest of the architecture provider-neutral.

### Negative / risks
- Bank website changes can break selectors and login flows.
- Chromium increases runtime size and operational complexity.
- Credentials must be stored reversibly and login attempts may trigger bank controls.

## Alternatives considered

- **Open Banking API first:** deferred due licensing and integration scope.
- **Manual CSV only:** insufficient for the daily automation goal; retained as possible future import support.

## References

- `src/lib/jobs/ingestion.ts`
- `docs/REQUIREMENTS.md` §§2, 3.1, 7
