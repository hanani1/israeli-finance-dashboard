# ADR-0029: Script layout with safety classes, one RiseUp matcher, ESLint gate

- **Date:** 2026-11-03
- **Status:** Accepted
- **Area:** Operations | Data
- **Owners:** Finance Dashboard maintainers

## Context

`scripts/` had grown to ~36 files mixing the host worker, data backfills,
provider probes and applied one-offs. Nothing said which ones write the live
database, log in to a bank, or print credentials. The tiered RiseUp matcher was
copied into two scripts and `riseup-compare.ts`/`compare_riseup.py` used two more,
different matchers. There was no linter, so unused code accumulated (a whole
unmounted reconciliation feature, including an API route).

## Decision

1. **Layout.** `scripts/` holds production and maintenance tooling (host worker,
   migration checks, backfills, data fixes, RiseUp import/compare).
   `scripts/diagnostics/` holds provider probes (Isracard inspectors, bounded login
   attempts, `debug-scrape`). Applied one-offs whose job moved into the app are
   deleted (git history keeps them): `compare_riseup.py` (superseded by
   `riseup:compare` + `reconcile-month-vs-riseup.ts`) and `hermes-categorization-*`
   (superseded by the Hermes categorization provider). Scripts scheduled for
   history removal (card #42) stay in place until then.
2. **Safety class header.** Every script starts with
   `Safety class: <READ-ONLY | WRITES DB | TOUCHES PROVIDER | SENSITIVE>[, …]` plus a
   short qualifier (e.g. "only with --apply"). The README "Script index" lists
   what/when/class for each one and must be updated with any new script.
3. **One RiseUp matcher.** `src/lib/services/riseupMatcher.ts` (pure, unit-tested)
   is the only RiseUp ↔ dashboard matcher; any new RiseUp script uses it.
4. **Lint gate.** `npm run lint` (ESLint flat config: `next/core-web-vitals`,
   `next/typescript`, `@typescript-eslint/no-unused-vars` as an error,
   `--max-warnings=0`) and `noUnusedLocals` join `npm test`, `npm run typecheck`
   and `npm run build` as required checks.

## Consequences

### Positive
- The blast radius of a script is visible before running it.
- Matching fixes apply to every RiseUp workflow at once.
- Dead code is caught when written; `next build` also lints.

### Negative / risks
- Paths of the diagnostics changed; old shell history / notes need the new path.
- `riseup:compare` results can differ slightly from earlier reports (stricter,
  tiered matching; the old token-score pairing is gone).

## Alternatives considered

- **Leave the scripts flat and document them only:** the class would not travel
  with the file.
- **Keep `compare_riseup.py` as a second implementation:** two matchers drift.

## References

- Trello card #52; README "Script index"; ADR-0026 (chat-db-readonly.sh was
  removed by card #43, before this reorganization).
