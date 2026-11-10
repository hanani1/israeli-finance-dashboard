# ADR-0007: Confirm destructive UI actions

- **Date:** 2026-08-10
- **Status:** Accepted
- **Area:** UI / Safety
- **Owners:** Finance Dashboard maintainers

## Context

Deleting credentials, rules, or household data can interrupt ingestion or remove carefully curated behavior. Immediate destructive buttons are too easy to trigger accidentally, especially on mobile.

## Decision

Route destructive UI actions through a shared accessible confirmation dialog. The dialog names the affected resource and performs the mutation only after explicit confirmation. Backend dependency checks remain authoritative; UI confirmation is not a replacement for server validation.

Every `DELETE` issued from the UI (credentials, rules, household members, budgets) goes through `ConfirmDialog`; its button labels are translated (`common.cancel` / `common.delete` / `common.deleting`). If the confirmed mutation fails, the server's `{ error }` message is shown in the screen's error slot via `apiFetch()` / `describeApiError()` (card #51) rather than failing silently.

## Consequences

### Positive
- Reduces accidental deletion.
- Produces consistent interaction and accessibility behavior across settings screens.

### Negative / risks
- Adds one interaction step to intentional deletions.
- New destructive actions must remember to use the shared component.

## Alternatives considered

- **Immediate deletion plus toast undo:** rejected because credential deletion and server-side effects are not always safely reversible.
- **Browser `confirm()`:** rejected for inconsistent design and limited accessibility/control.

## References

- `src/components/ui/confirm-dialog.tsx`
- `src/app/settings/page.tsx`
- `src/app/budgets/page.tsx` (budget delete, card #51)
- `src/lib/client/api.ts`, `src/lib/services/apiError.ts`
- Commit `1bfc832`
