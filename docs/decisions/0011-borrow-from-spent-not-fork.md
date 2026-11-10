# ADR-0011: Borrow ideas from the Spent project instead of forking or depending on it

- **Date:** 2026-08-17
- **Status:** Accepted
- **Area:** Business / Architecture
- **Owners:** Finance Dashboard maintainers

## Context

The open-source project [`Shaya16/Spent`](https://github.com/Shaya16/Spent) was evaluated
for integration. It is a self-hosted personal-finance app for Israeli bank accounts —
conceptually a near-sibling of this project (Next.js/React/TypeScript/Tailwind/Recharts,
`israeli-bank-scrapers`, AES-256-GCM encrypted credentials, LLM categorization).

Key findings from the evaluation:

- It is a **standalone application**, not an npm package — `version 0.1.0`, private, no
  exported API surface. There is nothing to `npm install`.
- It persists with **SQLite (`better-sqlite3`, raw SQL)**; this project uses **Prisma on
  PostgreSQL**. Its data-access code does not transfer; only domain logic would.
- MIT-licensed (permissive), but single-author, Beta, with bursty/aging commit activity —
  not a dependency to rely on as an upstream.
- Its credential/crypto/scraper code touches the most sensitive surface and must not be
  copied without independent review.

## Decision

Treat Spent as a **reference implementation to borrow from**, not a dependency or fork.
Selectively port small, self-contained, independently reviewed pieces, rewriting any
storage against Prisma. The first two ports adopted from this evaluation:

- Monthly budgets with pacing — see [ADR-0012](0012-monthly-budgets-with-pacing.md).
- Hebrew/RTL internationalization — see [ADR-0013](0013-cookie-based-i18n-hebrew-rtl.md).

Explicitly **not** adopted now: merchant-memory / automatic transfer detection (touches the
core categorization pipeline; revisit later) and the Swift/C# menu-bar & tray companion
apps (two extra non-JS toolchains — disproportionate for a solo project).

## Consequences

### Positive
- Gains net-new features quickly without a lateral fork of an already-owned core.
- Keeps this project's authoritative crypto, ingestion, and categorization intact.
- License obligations are limited to attribution for any ported snippets.

### Negative / risks
- Ported ideas must be re-implemented and re-tested here (no upstream maintenance benefit).
- Divergence from Spent over time is expected and accepted.

## Alternatives considered

- **Fork Spent / adopt wholesale:** rejected — a lateral move onto a different persistence
  layer with no packaged interface.
- **Depend on it as a library:** impossible — it is not published and exposes no API.
- **Skip entirely:** rejected — it surfaced concrete, valuable features this project lacked.

## References

- Card #18 — Evaluate and integrate the Spent package
- `docs/decisions/0012-monthly-budgets-with-pacing.md`, `docs/decisions/0013-cookie-based-i18n-hebrew-rtl.md`
