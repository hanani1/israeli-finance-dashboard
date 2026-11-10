# ADR-0009: Invoke Kiro CLI headlessly for LLM categorization

- **Date:** 2026-08-11
- **Status:** Accepted
- **Area:** AI / Privacy / Operations
- **Owners:** Finance Dashboard maintainers

## Context

The application needs initial intelligent categorization but has no OpenAI, Anthropic, Bedrock, Ollama, or LM Studio configuration. The development host already has Kiro CLI authenticated and can select `gpt-5.6-sol`. Kiro CLI documents `chat --no-interactive` for automation.

## Decision

When explicitly enabled, the ingestion worker invokes:

```bash
kiro-cli chat --no-interactive \
  --agent finance-categorizer \
  --model gpt-5.6-sol \
  --effort low \
  --wrap never \
  'Categorize the transactions in the runtime prompt resource and follow its exact response markers.'
```

Use a dedicated agent with no tools. Write category metadata, amounts, opaque batch indexes, and descriptions with long numeric identifiers redacted to a mode-`0600`, gitignored runtime resource; remove it in `finally` after the CLI exits. The process argument contains only a fixed instruction. Use per-invocation nonce markers, valid JSON, every expected index exactly once, and existing category IDs. Apply one bounded batch (maximum 100) atomically with source `LLM`. Do not retry automatically; timeout or validation/auth/model failure leaves rows unassigned and records an ingestion error.

Only the host cron worker and explicit `npm run categorize:once` command invoke Kiro. The unauthenticated web `POST /api/sync` route does not, preventing remote users on the trusted network from spending credits. This is opt-in because each invocation consumes Kiro credits and sends the redacted prompt to the Kiro model service.

## VM and container boundary

- **Supported VM approach:** install and authenticate Kiro CLI for the same OS user that runs the host worker/cron, keep the repository (including `.kiro/agents`) available, and verify `kiro-cli whoami` before enabling.
- **Current Docker worker:** unsupported by default because the image does not contain Kiro CLI or the user's `~/.kiro` authentication/session state.
- **Container enablement, if later required:** deliberately install a compatible Kiro CLI, supply a narrowly scoped persistent Kiro configuration/auth volume, copy the agent definition, and reassess secret isolation. Do not casually mount the entire home directory or Docker socket.

## Consequences

### Positive
- Reuses the model entitlement already available on the host.
- Avoids a separate API key and provider SDK.
- Dedicated no-tools execution limits agent capabilities.

### Negative / risks
- Scheduled runs depend on Kiro login/session validity, CLI availability, model availability, and credits.
- Chat stdout has no documented machine-readable mode; marker extraction and strict validation are required.
- The temporary mode-`0600` resource still contains redacted financial descriptions while a run is active; privileged host users can read it. An abrupt crash may leave it briefly, but the next run removes a lock whose owner is dead or whose age exceeds the configured timeout.
- Docker portability is reduced unless Kiro is explicitly provisioned in the container.

## Alternatives considered

- **One-time categorization in an interactive Kiro session:** works for existing data but not future cron runs.
- **Local Ollama:** strongest local privacy but not currently installed and requires model/runtime capacity.
- **Direct cloud APIs:** straightforward application integration but require separate keys, billing, and provider-specific privacy acceptance.
- **Kiro ACP over stdin:** may avoid per-run startup and temporary prompt resources, but adds a persistent JSON-RPC client/session lifecycle; reconsider if startup cost or residual temp-file exposure becomes material.

## Validation

A harmless headless probe using `gpt-5.6-sol` returned the requested markers successfully and consumed 0.25 Kiro credits on 2026-08-11.

## References

- `.kiro/agents/finance-categorizer.json`
- `src/lib/services/llmCategorizationService.ts`
- Kiro CLI `chat --no-interactive` documentation
- ADR-0005
