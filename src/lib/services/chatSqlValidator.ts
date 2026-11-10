/**
 * Validator for the chat's `query` tool: model-written SQL that the SERVER
 * executes read-only (card #43, ADR-0026). Pure and side-effect free.
 *
 * Defense layers, outermost first (each is sufficient for writes on its own):
 * 1. This validator: the text must parse (pgsql-ast-parser) as exactly ONE
 *    SELECT / UNION / WITH-of-SELECTs statement. Every AST node type,
 *    function, keyword, cast target and table is checked against an
 *    allowlist; anything unknown is rejected (fail closed). What runs is the
 *    re-serialized AST, never the original text, so comments and
 *    parser-differential tricks are dropped.
 * 2. buildScopedQuery: the statement runs as a subquery under CTEs that shadow
 *    every allowlisted table with an explicit column list, the household
 *    filter and the card-settlement exclusion; schema-qualified names are
 *    rejected so the model can only ever see those CTEs. A LIMIT caps rows.
 * 3. The database: the `finance_chat_ro` role has SELECT on the allowlisted
 *    columns only (no BankCredential, no account numbers / bank identifiers /
 *    e-mails), and every chat transaction is READ ONLY with a 5 s
 *    statement_timeout (see scripts/setup-chat-readonly-role.sql).
 */
import { parse, toSql, type Statement } from 'pgsql-ast-parser';

/** Maximum rows returned to the model per query (one extra is fetched to detect truncation). */
export const CHAT_ROW_CAP = 200;
export const MAX_CHAT_SQL_LENGTH = 4_000;

/**
 * Tables (and the columns of each) the chat may read. The order matters only
 * for readability of the generated CTE list. Deliberately absent:
 * BankCredential (encrypted bank logins), IngestionLease (ingestion run lock), _prisma_migrations,
 * ChatConversation / ChatMessage (persisted chat history, ADR-0027: replayed by
 * the server, never readable by the model),
 * Account.accountNumber, Transaction.txnIdentifier, User.email.
 */
export const CHAT_TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  User: ['id', 'name'],
  Account: ['id', 'userId', 'provider', 'kind', 'displayName', 'balance', 'currency', 'updatedAt'],
  Category: ['id', 'name', 'type', 'group', 'color'],
  Budget: ['id', 'categoryId', 'amount', 'createdAt', 'updatedAt'],
  CategorizationRule: ['id', 'pattern', 'categoryId', 'priority', 'matchMemo', 'createdAt'],
  Transaction: [
    'id',
    'accountId',
    'date',
    'processedDate',
    'chargedAmount',
    'chargedCurrency',
    'originalAmount',
    'originalCurrency',
    'description',
    'memo',
    'rawCategory',
    'categoryId',
    'categorizationSource',
    'createdAt',
    'isTransfer',
    'transferPairId',
    'flowMonth',
    'note',
    'isRefund',
  ],
};

const ALLOWED_TABLES = new Set(Object.keys(CHAT_TABLE_COLUMNS));
const ALLOWED_TABLES_LOWER = new Set([...ALLOWED_TABLES].map((name) => name.toLowerCase()));

/** Column names that are never readable, whatever table they are qualified with. */
const SENSITIVE_COLUMNS = new Set(
  ['accountNumber', 'txnIdentifier', 'email', 'encryptedData', 'iv', 'authTag'].map((c) =>
    c.toLowerCase(),
  ),
);

/** Pure, side-effect-free functions useful for reporting. Everything else is rejected. */
const ALLOWED_FUNCTIONS = new Set([
  // aggregates & window functions
  'sum', 'count', 'avg', 'min', 'max', 'string_agg', 'bool_and', 'bool_or',
  'row_number', 'rank', 'dense_rank', 'lag', 'lead', 'first_value', 'last_value',
  // numeric
  'round', 'abs', 'floor', 'ceil', 'ceiling', 'sign', 'trunc',
  // conditional
  'coalesce', 'nullif', 'greatest', 'least',
  // date/time
  'date_trunc', 'date_part', 'to_char', 'now', 'make_date', 'age', 'timezone',
  // text
  'lower', 'upper', 'length', 'trim', 'btrim', 'ltrim', 'rtrim', 'substr', 'substring',
  'replace', 'concat', 'strpos', 'position', 'left', 'right', 'split_part',
  // sub-query predicates the parser represents as calls
  'exists', 'any', 'all',
]);

const ALLOWED_KEYWORDS = new Set([
  'current_date',
  'current_timestamp',
  'current_time',
  'localtime',
  'localtimestamp',
]);

const ALLOWED_CAST_TYPES = new Set([
  'text', 'varchar', 'character varying', 'char', 'character',
  'numeric', 'decimal', 'int', 'integer', 'int4', 'int8', 'bigint', 'smallint',
  'float', 'float4', 'float8', 'real', 'double precision',
  'date', 'timestamp', 'timestamptz', 'timestamp without time zone', 'timestamp with time zone',
  'interval', 'boolean', 'bool',
]);

/** AST node `type` values that may appear anywhere in an accepted statement. */
const ALLOWED_NODE_TYPES = new Set([
  'select', 'union', 'union all', 'with',
  'table', 'statement',
  'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN',
  'ref', 'call', 'binary', 'unary', 'ternary', 'cast', 'case', 'extract', 'keyword', 'list',
  'integer', 'numeric', 'string', 'boolean', 'null',
]);

/** AST keys that only appear on clauses we refuse (row locks, SELECT INTO, …). */
const FORBIDDEN_KEYS = new Set(['for', 'into', 'skip', 'returning', 'onConflict', 'set']);

const SAFE_IDENTIFIER = /^(\*|[\p{L}\p{N}_ ]{1,63})$/u;

export type SqlValidation = { ok: true; sql: string } | { ok: false; reason: string };

class Rejection extends Error {}

function reject(reason: string): never {
  throw new Rejection(reason);
}

function collectCteNames(node: unknown, names: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectCteNames(item, names);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const record = node as Record<string, unknown>;
  if (record.type === 'with' && Array.isArray(record.bind)) {
    for (const bind of record.bind as Array<{ alias?: { name?: unknown } }>) {
      const name = bind.alias?.name;
      if (typeof name !== 'string') reject('Unnamed CTE.');
      if (ALLOWED_TABLES_LOWER.has(name.toLowerCase())) {
        reject(`CTE name "${name}" would shadow a data table.`);
      }
      names.add(name);
    }
  }
  for (const value of Object.values(record)) collectCteNames(value, names);
}

function checkNode(node: unknown, cteNames: ReadonlySet<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) checkNode(item, cteNames);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const record = node as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (FORBIDDEN_KEYS.has(key) && record[key] !== null && record[key] !== undefined) {
      reject(`"${key}" clauses are not allowed.`);
    }
    // Identifiers (names / aliases) must be plain words: quoted identifiers
    // carrying quotes, semicolons or shell metacharacters are refused even
    // though Postgres would treat them as inert names.
    const value = record[key];
    if ((key === 'name' || key === 'alias') && typeof value === 'string' && !SAFE_IDENTIFIER.test(value)) {
      reject('Identifiers may only contain letters, digits, spaces and underscores.');
    }
  }

  const type = record.type;
  if (type !== undefined) {
    if (typeof type !== 'string' || !ALLOWED_NODE_TYPES.has(type)) {
      reject(`SQL construct "${String(type)}" is not allowed.`);
    }
    switch (type) {
      case 'table': {
        const name = record.name as { name?: unknown; schema?: unknown } | undefined;
        if (!name || typeof name.name !== 'string') reject('Malformed table reference.');
        if (name.schema !== undefined) reject('Schema-qualified tables are not allowed.');
        if (!ALLOWED_TABLES.has(name.name) && !cteNames.has(name.name)) {
          reject(`Table "${name.name}" is not available to the chat.`);
        }
        break;
      }
      case 'ref': {
        const table = record.table as { schema?: unknown } | undefined;
        if (table?.schema !== undefined) reject('Schema-qualified columns are not allowed.');
        const name = record.name;
        if (typeof name === 'string' && SENSITIVE_COLUMNS.has(name.toLowerCase())) {
          reject(`Column "${name}" is not available to the chat.`);
        }
        break;
      }
      case 'call': {
        const fn = record.function as { name?: unknown; schema?: unknown } | undefined;
        if (!fn || typeof fn.name !== 'string') reject('Malformed function call.');
        if (fn.schema !== undefined) reject('Schema-qualified functions are not allowed.');
        if (!ALLOWED_FUNCTIONS.has(fn.name.toLowerCase())) {
          reject(`Function "${fn.name}" is not allowed.`);
        }
        break;
      }
      case 'keyword': {
        const keyword = record.keyword;
        if (typeof keyword !== 'string' || !ALLOWED_KEYWORDS.has(keyword.toLowerCase())) {
          reject(`Keyword "${String(keyword)}" is not allowed.`);
        }
        break;
      }
      case 'cast': {
        const to = record.to as { name?: unknown; schema?: unknown; kind?: unknown } | undefined;
        if (!to || typeof to.name !== 'string' || to.schema !== undefined || to.kind === 'array') {
          reject('Unsupported cast.');
        }
        if (!ALLOWED_CAST_TYPES.has(to.name.toLowerCase())) {
          reject(`Cast to "${to.name}" is not allowed.`);
        }
        break;
      }
      default:
        break;
    }
  }

  for (const value of Object.values(record)) checkNode(value, cteNames);
}

const TOP_LEVEL_TYPES = new Set(['select', 'union', 'union all', 'with']);

/**
 * Accepts exactly one read-only SELECT over the chat tables and returns its
 * canonical re-serialization, or a reason that can be shown to the model.
 */
export function validateChatSql(input: string): SqlValidation {
  const text = input.trim();
  if (!text) return { ok: false, reason: 'Empty SQL.' };
  if (text.length > MAX_CHAT_SQL_LENGTH) {
    return { ok: false, reason: `SQL longer than ${MAX_CHAT_SQL_LENGTH} characters.` };
  }
  if (/[\u0000`]/.test(text)) return { ok: false, reason: 'SQL contains forbidden characters.' };
  if (/\$\d/.test(text) || text.includes('$$')) {
    return { ok: false, reason: 'Parameters and dollar-quoted strings are not allowed.' };
  }

  let statements: Statement[];
  try {
    statements = parse(text);
  } catch {
    return { ok: false, reason: 'SQL could not be parsed (use plain PostgreSQL SELECT syntax).' };
  }
  if (statements.length !== 1 || !statements[0]) {
    return { ok: false, reason: 'Exactly one SQL statement is allowed.' };
  }
  const statement = statements[0];
  if (!TOP_LEVEL_TYPES.has(statement.type)) {
    return { ok: false, reason: 'Only SELECT statements are allowed.' };
  }

  try {
    const cteNames = new Set<string>();
    collectCteNames(statement, cteNames);
    checkNode(statement, cteNames);
    const sql = toSql.statement(statement).trim();
    // Belt and braces: the re-serialized text must itself re-parse to one
    // statement of the same shape.
    const reparsed = parse(sql);
    if (reparsed.length !== 1 || reparsed[0]?.type !== statement.type) {
      reject('SQL did not round-trip safely.');
    }
    return { ok: true, sql };
  } catch (error) {
    if (error instanceof Rejection) return { ok: false, reason: error.message };
    return { ok: false, reason: 'SQL could not be validated.' };
  }
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export interface ScopedQuery {
  text: string;
  params: unknown[];
}

/**
 * Wraps an already-validated SELECT (or a typed tool's fixed SELECT) so that
 * every table name resolves to a CTE exposing only allowlisted columns, the
 * household filter ($1 = userId or NULL for everyone) and no superseded card
 * settlement rows, with a hard row cap. Typed-tool parameters start at $2.
 */
export function buildScopedQuery(
  innerSql: string,
  options: { userId?: string | null; params?: readonly unknown[]; rowCap?: number },
): ScopedQuery {
  const rowCap = options.rowCap ?? CHAT_ROW_CAP;
  const cols = (table: string): string =>
    (CHAT_TABLE_COLUMNS[table] ?? []).map(quoteIdentifier).join(', ');
  const householdAccounts = `SELECT "id" FROM public."Account" WHERE $1::text IS NULL OR "userId" = $1::text`;
  const ctes = [
    `"User" AS NOT MATERIALIZED (SELECT ${cols('User')} FROM public."User" WHERE $1::text IS NULL OR "id" = $1::text)`,
    `"Account" AS NOT MATERIALIZED (SELECT ${cols('Account')} FROM public."Account" WHERE $1::text IS NULL OR "userId" = $1::text)`,
    `"Category" AS NOT MATERIALIZED (SELECT ${cols('Category')} FROM public."Category")`,
    `"Budget" AS NOT MATERIALIZED (SELECT ${cols('Budget')} FROM public."Budget")`,
    `"CategorizationRule" AS NOT MATERIALIZED (SELECT ${cols('CategorizationRule')} FROM public."CategorizationRule")`,
    `"Transaction" AS NOT MATERIALIZED (SELECT ${cols('Transaction')} FROM public."Transaction" ` +
      `WHERE "isCardSettlement" = false AND "accountId" IN (${householdAccounts}))`,
  ];
  const inner = innerSql.trim().replace(/;\s*$/, '');
  return {
    text: `WITH ${ctes.join(',\n')}\nSELECT * FROM (${inner}) AS chat_result LIMIT ${rowCap + 1}`,
    params: [options.userId ?? null, ...(options.params ?? [])],
  };
}
