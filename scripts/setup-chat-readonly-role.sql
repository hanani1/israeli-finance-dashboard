-- Safety class: WRITES DB (creates/resets the finance_chat_ro role and its grants).
--
-- Idempotent setup of the SELECT-only Postgres role the finance chat uses
-- (card #43, ADR-0026). Safe to re-run: it creates the role if missing and
-- RESETS its privileges to exactly the allowlist below every time — which
-- also strips grants an older setup may have given (an earlier hand-made
-- finance_chat_ro could read "BankCredential").
--
-- Run as the database owner / a superuser against the app database:
--   psql "postgresql://finance@localhost:5432/finance" -v ON_ERROR_STOP=1 \
--        -f scripts/setup-chat-readonly-role.sql
-- Re-run after every migration that adds columns to an allowlisted table
-- (new columns are NOT readable until granted here).
--
-- No password is set here (never commit one). If your pg_hba requires a
-- password for TCP logins (the docker-compose Postgres does), set it
-- interactively, then put it in CHAT_DB_URL in .env:
--   psql "postgresql://finance@localhost:5432/finance" -c '\password finance_chat_ro'
--   CHAT_DB_URL=postgresql://finance_chat_ro:<password>@localhost:5432/finance

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'finance_chat_ro') THEN
    CREATE ROLE finance_chat_ro LOGIN;
  END IF;
END
$$;

-- Attributes are re-asserted on every run.
ALTER ROLE finance_chat_ro WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
  NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4;
ALTER ROLE finance_chat_ro SET default_transaction_read_only = on;
ALTER ROLE finance_chat_ro SET statement_timeout = '5s';
ALTER ROLE finance_chat_ro SET idle_in_transaction_session_timeout = '15s';

-- Never a member of the built-in data/file roles.
REVOKE pg_read_all_data, pg_write_all_data, pg_read_server_files, pg_write_server_files,
  pg_execute_server_program FROM finance_chat_ro;

-- Start from nothing in this database's public schema.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM finance_chat_ro;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM finance_chat_ro;
REVOKE ALL ON SCHEMA public FROM finance_chat_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM finance_chat_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM finance_chat_ro;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO finance_chat_ro', current_database());
END
$$;
GRANT USAGE ON SCHEMA public TO finance_chat_ro;

-- Column-level SELECT on the reporting tables only. Deliberately NOT granted:
-- "BankCredential" (encrypted bank logins), "IngestionLease" (ingestion run lock), "_prisma_migrations",
-- "ChatConversation" / "ChatMessage" (persisted chat history, ADR-0027 — the model
-- must never read chat history via SQL; the server replays it),
-- "Account"."accountNumber", "Transaction"."txnIdentifier", "User".email.
-- Keep in sync with CHAT_TABLE_COLUMNS in src/lib/services/chatSqlValidator.ts
-- (isCardSettlement is granted for the scoping filter only).
GRANT SELECT (id, name) ON "User" TO finance_chat_ro;
GRANT SELECT (id, "userId", provider, kind, "displayName", balance, currency, "updatedAt")
  ON "Account" TO finance_chat_ro;
GRANT SELECT (id, name, type, "group", color) ON "Category" TO finance_chat_ro;
GRANT SELECT (id, "categoryId", amount, "createdAt", "updatedAt") ON "Budget" TO finance_chat_ro;
GRANT SELECT (id, pattern, "categoryId", priority, "matchMemo", "createdAt")
  ON "CategorizationRule" TO finance_chat_ro;
GRANT SELECT (id, "accountId", date, "processedDate", "chargedAmount", "chargedCurrency",
  "originalAmount", "originalCurrency", description, memo, "rawCategory", "categoryId",
  "categorizationSource", "createdAt", "isTransfer", "transferPairId", "isCardSettlement",
  "flowMonth", note, "isRefund")
  ON "Transaction" TO finance_chat_ro;
