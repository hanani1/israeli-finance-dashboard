# ADR-0010: Use a fast-forward, no-PR workflow while the project is solo

- **Date:** 2026-08-12
- **Status:** Accepted
- **Area:** Development Process / Operations
- **Owners:** Finance Dashboard maintainer

## Context

The project currently has one developer. Mandatory GitHub pull requests add ceremony
without providing independent review, while direct unvalidated edits to remote `main`
would reduce recovery and review opportunities.

## Decision

Use short-lived local branches for non-trivial changes, validate and commit them, then
fast-forward local `main` and push `main` directly to GitHub. Pull requests are not
required unless explicitly requested, a change is unusually risky, or collaborators join.

Required safeguards:

1. Fetch the GitHub remote before integration.
2. Confirm `main` can advance with `git merge --ff-only`; do not create an accidental
   merge commit.
3. Run relevant tests, type checks, builds, and smoke checks before integration.
4. Use Conventional Commit messages.
5. Push through the explicit GitHub URL and never force-push or rewrite pushed history.

Small documentation-only changes may be committed directly on `main` after validation,
but branches remain the preferred default because they isolate in-progress work.

## Consequences

### Positive
- Removes PR overhead for a solo project.
- Retains clean, linear history and branch isolation.
- Makes promotion to `main` an explicit validated step.

### Negative / risks
- There is no independent human approval gate.
- Mistakes reach `main` immediately after push.
- The policy must be revisited when collaborators or automated deployment protections are
  introduced.

## Alternatives considered

- **Mandatory pull requests:** deferred while there is only one developer.
- **Commit every change directly on `main`:** allowed for small documentation changes but
  rejected as the default for non-trivial work because it mixes unfinished and releasable
  state.
- **Squash/rebase before every push:** rejected; fast-forwarding preserves validated commit
  identity and avoids history rewriting.

## References

- `CONTRIBUTING` notes in the README (Development workflow)
