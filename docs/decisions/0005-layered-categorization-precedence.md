# ADR-0005: Layer categorization with explicit precedence

- **Date:** 2026-08-11
- **Status:** Accepted
- **Area:** Business / Data / AI
- **Owners:** Finance Dashboard maintainers

## Context

Recurring merchants are best handled deterministically, new descriptions benefit from an initial intelligent guess, and users must always retain final control. Re-ingestion must not rewrite prior decisions.

## Decision

Apply categorization in this order:

1. Preserve every existing category assignment during ingestion.
2. Apply deterministic substring rules only where `categoryId IS NULL`.
3. If enabled, ask the configured LLM to classify only remaining unassigned transactions.
4. Allow manual selection to override the result and mark it `MANUAL`.

Track provenance as `UNASSIGNED`, `RULE`, `LLM`, or `MANUAL`. LLM output must reference an existing category ID and pass strict structural validation before any database update. A failed LLM run leaves rows unassigned.

## Consequences

### Positive
- User intent and deterministic rules are never overwritten by probabilistic output.
- New imports receive useful initial categories without requiring a rule for every merchant.
- Provenance remains visible and auditable.

### Negative / risks
- LLM classifications can be wrong and require review.
- Category quality depends on descriptions and available category taxonomy.
- Remote model use creates privacy and credit/cost considerations.

## Alternatives considered

- **LLM before rules:** rejected because it wastes credits and can override known recurring behavior.
- **LLM-generated rules automatically:** rejected initially; a mistaken generalization has broader impact than one assignment.
- **Manual/rules only:** retained as the fallback but insufficient for the requested initial experience.

## References

- `src/lib/services/ruleEngine.ts`
- `src/lib/services/llmCategorizationService.ts`
- ADR-0009
