# Finance Dashboard Decision Log

This directory records durable product, business, architecture, security, data, and UI decisions. Its purpose is to preserve **why** a choice was made, the alternatives considered, and the consequences future maintainers must understand.

## Process

1. Copy [`0000-template.md`](0000-template.md) for a new decision.
2. Use the next sequential number and a concise kebab-case filename.
3. Set status to `Proposed`, `Accepted`, `Superseded`, or `Rejected`.
4. Link superseding/superseded records in both directions; never delete old records.
5. Update this index and the relevant requirement/design documentation in the same change.
6. Record meaningful changes in Trello and link the resulting commit/branch (and PR only when one is requested).

## Index

| ID | Decision | Area | Status |
|---|---|---|---|
| [ADR-0001](0001-self-hosted-local-first.md) | Self-hosted, local-first product boundary | Business / Architecture | Accepted |
| [ADR-0002](0002-encrypted-view-only-bank-access.md) | Encrypted credentials and least-privilege bank access | Security / Business | Accepted |
| [ADR-0003](0003-scraping-before-open-banking.md) | Website scraping before Open Banking integration | Business / Architecture | Accepted |
| [ADR-0004](0004-deterministic-idempotent-ingestion.md) | Deterministic, idempotent transaction ingestion | Data / Architecture | Accepted |
| [ADR-0005](0005-layered-categorization-precedence.md) | Manual, rule, and LLM categorization precedence | Business / Data | Accepted |
| [ADR-0006](0006-url-backed-household-filters.md) | URL-backed global household filters | UI / Architecture | Accepted |
| [ADR-0007](0007-confirm-destructive-actions.md) | Confirmation for destructive UI actions | UI / Safety | Accepted |
| [ADR-0008](0008-single-image-multi-role-deployment.md) | Single image with web and worker roles | Deployment / Architecture | Accepted |
| [ADR-0009](0009-kiro-cli-headless-categorization.md) | Kiro CLI headless LLM categorization | AI / Privacy / Operations | Accepted |
| [ADR-0010](0010-solo-no-pr-workflow.md) | Fast-forward, no-PR workflow while solo | Development Process | Accepted |
| [ADR-0011](0011-borrow-from-spent-not-fork.md) | Borrow ideas from the Spent project, not fork/depend | Business / Architecture | Accepted |
| [ADR-0012](0012-monthly-budgets-with-pacing.md) | Monthly per-category budgets with linear pacing | Product / Data | Accepted |
| [ADR-0013](0013-cookie-based-i18n-hebrew-rtl.md) | Cookie-based i18n with Hebrew/RTL via next-intl | UI / Architecture | Accepted |
| [ADR-0014](0014-balance-separate-from-cashflow.md) | Current balance separate from period cash flow | Product / Data | Accepted |
| [ADR-0015](0015-categorization-review-and-reminder.md) | In-app daily categorization reminder and one-by-one review | Product / UX | Accepted |
| [ADR-0016](0016-category-taxonomy-groups-and-breakdown.md) | RiseUp category taxonomy with groups + monthly breakdown | Product / Data / UI | Accepted |
| [ADR-0017](0017-unified-monthly-view.md) | Unified monthly view: merge, net, 6-month average, drill-down reclassify | Product / UI | Accepted |
| [ADR-0018](0018-loopback-bind-is-the-access-wall.md) | Loopback/tailnet bind is the access wall; request headers are not | Security / Operations | Accepted |
| [ADR-0019](0019-api-request-guard.md) | API request guard (CSRF / Origin / Content-Type / Host) and security headers | Security | Accepted |
| [ADR-0020](0020-ingestion-time-zone-asia-jerusalem.md) | Pin the ingestion process time zone to Asia/Jerusalem in every runtime | Data correctness / Ingestion | Accepted |
| [ADR-0021](0021-ingestion-run-lease-lock.md) | Serialize ingestion runs with a database lease | Data / Operations | Accepted |
| [ADR-0022](0022-timestamped-immutable-migrations.md) | Timestamped, immutable Prisma migrations; fresh-DB replay check | Data / Operations | Accepted |
| [ADR-0023](0023-relative-dashboard-date-presets.md) | Relative dashboard date presets as calendar-month windows | UI / Data | Accepted |
| [ADR-0024](0024-semantic-refund-flag.md) | Same-sign provider refunds marked with a semantic `isRefund` flag | Data / Business | Accepted |
| [ADR-0025](0025-retire-unseen-pending-rows.md) | Retire pending rows the provider stopped returning; keep foreign pending currency | Data correctness / Ingestion | Accepted |
| [ADR-0026](0026-tool-less-chat-with-server-side-readonly-tools.md) | Free-text chat via a tool-less host CLI and server-side read-only data tools | AI / Security / Privacy | Accepted |
| [ADR-0027](0027-money-decimal-shared-month-and-errors.md) | Money as DECIMAL, one flow-month predicate, one API error policy | Data / Architecture / Security | Accepted |
| [ADR-0028](0028-persisted-background-chat.md) | Persisted chat conversations with background runs and a chat-only sidebar | AI / Reliability / UI / Privacy | Accepted |
| [ADR-0029](0029-script-safety-classes-and-lint-gate.md) | Script layout with safety classes, one RiseUp matcher, ESLint gate | Operations / Data | Accepted |
