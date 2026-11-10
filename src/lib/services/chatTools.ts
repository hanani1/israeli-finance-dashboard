/**
 * The chat's server-side data tools (ADR-0026). The model never touches the
 * host: it may only *ask* for one of these by name with JSON arguments; the
 * server validates the request here, builds fixed SQL (or validates the
 * model's SELECT for `query`), and runs it read-only through the
 * `finance_chat_ro` role. Pure and side-effect free — execution lives in
 * chatReadonlyDb.ts.
 */
import { CHAT_ROW_CAP, buildScopedQuery, validateChatSql, type ScopedQuery } from './chatSqlValidator';
import { localDayStart, nextDay } from './localDay';
import { redactTransactionDescription } from './llmCategorizationService';

export interface ToolRequest {
  name: string;
  args: Record<string, unknown>;
}

export type ToolPlan = { ok: true; query: ScopedQuery; summary: string } | { ok: false; error: string };

/** Effective cash-flow month (RiseUp flowMonth, else Israel calendar month), as in flowMonth.ts. */
const EFFECTIVE_MONTH = `COALESCE(t."flowMonth", to_char((t.date AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Jerusalem', 'YYYY-MM'))`;

/** Rows that count as income/expense, as in analyticsService.baseWhere (minus the currency filter: results are per currency). */
const FLOW_ROWS = `t."isTransfer" = false AND (c."group" IS NULL OR c."group" <> 'INVESTMENT')`;

/**
 * Per-row income / expense contributions — SQL mirror of
 * flowClassification.classifyFlow (ADR-0024): an isRefund row (raw negative,
 * same-sign provider refund) is +|amount| income and never an expense;
 * otherwise INCOME-group rows are income and every other row is spend
 * (positive amounts there are refunds that reduce spend).
 */
export const INCOME_FLOW_SQL = `CASE WHEN t."isRefund" THEN -t."chargedAmount" WHEN c."group" = 'INCOME' THEN t."chargedAmount" ELSE 0 END`;
export const EXPENSE_FLOW_SQL = `CASE WHEN t."isRefund" THEN 0 WHEN c."group" = 'INCOME' THEN 0 ELSE -t."chargedAmount" END`;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PATTERN = /^\d{4}-\d{2}$/;

/** Catalog shown to the model (kept short; args are JSON). */
export const CHAT_TOOL_CATALOG = [
  'spending_by_category {"from":"yyyy-MM-dd","to":"yyyy-MM-dd"} — expense total per category and currency (positive refunds net out; isRefund rows are income, not spend; transfers and investments excluded).',
  'monthly_totals {"fromMonth":"yyyy-MM","toMonth":"yyyy-MM"} — income, expenses and net per cash-flow month and currency.',
  'top_merchants {"from":"yyyy-MM-dd","to":"yyyy-MM-dd","direction":"expense"|"income","limit":1-20} — merchants/payers ranked by total.',
  'list_transactions {"from":"yyyy-MM-dd","to":"yyyy-MM-dd","category"?:string,"search"?:string,"limit"?:1-50} — individual transactions, newest first.',
  'account_balances {} — current balance per account and household member.',
  'budgets {"month":"yyyy-MM"} — monthly budget per category with the amount spent that month (ILS).',
  `query {"sql":"SELECT ..."} — one read-only PostgreSQL SELECT over the tables below (max ${CHAT_ROW_CAP} rows). Use only when no other tool fits.`,
];

function isRealDate(label: string): boolean {
  const parsed = new Date(`${label}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === label;
}

/** UTC instant as the 'YYYY-MM-DD HH:MM:SS.mmm' literal Postgres compares with timestamp(3) columns. */
function timestampParam(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

class ArgError extends Error {}

function dateArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !DATE_PATTERN.test(value) || !isRealDate(value)) {
    throw new ArgError(`"${key}" must be a date formatted yyyy-MM-dd.`);
  }
  return value;
}

function monthArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !MONTH_PATTERN.test(value) || !isRealDate(`${value}-01`)) {
    throw new ArgError(`"${key}" must be a month formatted yyyy-MM.`);
  }
  return value;
}

function limitArg(args: Record<string, unknown>, key: string, max: number, fallback: number): number {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ArgError(`"${key}" must be a positive integer.`);
  }
  return Math.min(value, max);
}

function optionalText(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 100) {
    throw new ArgError(`"${key}" must be a string of at most 100 characters.`);
  }
  return value;
}

/** [gte, lt) instants for an inclusive Israel-local day range. */
function dayWindow(args: Record<string, unknown>): [string, string] {
  const from = dateArg(args, 'from');
  const to = dateArg(args, 'to');
  if (from > to) throw new ArgError('"from" must not be after "to".');
  return [timestampParam(localDayStart(from)), timestampParam(localDayStart(nextDay(to)))];
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Validates a tool request and turns it into a scoped, parameterized query.
 * `userId` is the household-member filter from the page (null = everyone);
 * it is applied by the scoping CTEs, never by the model.
 */
export function planToolRequest(request: ToolRequest, userId: string | null): ToolPlan {
  const { name, args } = request;
  const scoped = (sql: string, params: unknown[] = [], rowCap?: number): ScopedQuery =>
    buildScopedQuery(sql, { userId, params, rowCap });
  try {
    switch (name) {
      case 'spending_by_category': {
        const [gte, lt] = dayWindow(args);
        return {
          ok: true,
          summary: `spending_by_category ${String(args.from)}..${String(args.to)}`,
          query: scoped(
            `SELECT COALESCE(c.name, 'Uncategorized') AS category, c."group" AS "group", t."chargedCurrency" AS currency, ` +
              `ROUND(SUM(${EXPENSE_FLOW_SQL})::numeric, 2) AS spent, COUNT(*) AS transactions ` +
              `FROM "Transaction" t LEFT JOIN "Category" c ON c.id = t."categoryId" ` +
              `WHERE ${FLOW_ROWS} AND t."isRefund" = false AND (c."group" IS NULL OR c."group" <> 'INCOME') ` +
              `AND t.date >= $2::timestamp AND t.date < $3::timestamp ` +
              `GROUP BY 1, 2, 3 ORDER BY spent DESC`,
            [gte, lt],
          ),
        };
      }
      case 'monthly_totals': {
        const fromMonth = monthArg(args, 'fromMonth');
        const toMonth = monthArg(args, 'toMonth');
        if (fromMonth > toMonth) throw new ArgError('"fromMonth" must not be after "toMonth".');
        return {
          ok: true,
          summary: `monthly_totals ${fromMonth}..${toMonth}`,
          query: scoped(
            `SELECT ${EFFECTIVE_MONTH} AS month, t."chargedCurrency" AS currency, ` +
              `ROUND(SUM(${INCOME_FLOW_SQL})::numeric, 2) AS income, ` +
              `ROUND(SUM(${EXPENSE_FLOW_SQL})::numeric, 2) AS expenses ` +
              `FROM "Transaction" t LEFT JOIN "Category" c ON c.id = t."categoryId" ` +
              `WHERE ${FLOW_ROWS} AND ${EFFECTIVE_MONTH} BETWEEN $2 AND $3 ` +
              `GROUP BY 1, 2 ORDER BY 1, 2`,
            [fromMonth, toMonth],
          ),
        };
      }
      case 'top_merchants': {
        const [gte, lt] = dayWindow(args);
        const direction = args.direction ?? 'expense';
        if (direction !== 'expense' && direction !== 'income') {
          throw new ArgError('"direction" must be "expense" or "income".');
        }
        const limit = limitArg(args, 'limit', 20, 10);
        const filter =
          direction === 'income'
            ? `(t."isRefund" OR (c."group" = 'INCOME' AND t."chargedAmount" > 0))`
            : `t."isRefund" = false AND c."group" IS DISTINCT FROM 'INCOME' AND t."chargedAmount" < 0`;
        return {
          ok: true,
          summary: `top_merchants ${direction} ${String(args.from)}..${String(args.to)}`,
          query: scoped(
            `SELECT t.description AS merchant, t."chargedCurrency" AS currency, ` +
              `ROUND(SUM(ABS(t."chargedAmount"))::numeric, 2) AS total, COUNT(*) AS transactions ` +
              `FROM "Transaction" t LEFT JOIN "Category" c ON c.id = t."categoryId" ` +
              `WHERE ${FLOW_ROWS} AND ${filter} AND t.date >= $2::timestamp AND t.date < $3::timestamp ` +
              `GROUP BY 1, 2 ORDER BY total DESC LIMIT $4`,
            [gte, lt, limit],
          ),
        };
      }
      case 'list_transactions': {
        const [gte, lt] = dayWindow(args);
        const category = optionalText(args, 'category');
        const search = optionalText(args, 'search');
        const limit = limitArg(args, 'limit', 50, 25);
        return {
          ok: true,
          summary: `list_transactions ${String(args.from)}..${String(args.to)}${category ? ` category=${category}` : ''}${search ? ` search=${search}` : ''}`,
          query: scoped(
            `SELECT to_char((t.date AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Jerusalem', 'YYYY-MM-DD') AS date, ` +
              `t.description, t.memo, t."chargedAmount" AS amount, t."chargedCurrency" AS currency, ` +
              `c.name AS category, t."isTransfer" AS "isTransfer", t."isRefund" AS "isRefund" ` +
              `FROM "Transaction" t LEFT JOIN "Category" c ON c.id = t."categoryId" ` +
              `WHERE t.date >= $2::timestamp AND t.date < $3::timestamp ` +
              `AND ($4::text IS NULL OR c.name = $4::text) ` +
              `AND ($5::text IS NULL OR t.description ILIKE '%' || $5::text || '%' OR t.memo ILIKE '%' || $5::text || '%') ` +
              `ORDER BY t.date DESC LIMIT $6`,
            [gte, lt, category, search === null ? null : escapeLike(search), limit],
          ),
        };
      }
      case 'account_balances':
        return {
          ok: true,
          summary: 'account_balances',
          query: scoped(
            `SELECT u.name AS member, a."displayName" AS account, a.provider, a.kind, a.balance, a.currency, a."updatedAt" AS "updatedAt" ` +
              `FROM "Account" a JOIN "User" u ON u.id = a."userId" ORDER BY u.name, a."displayName"`,
          ),
        };
      case 'budgets': {
        const month = monthArg(args, 'month');
        return {
          ok: true,
          summary: `budgets ${month}`,
          query: scoped(
            `SELECT c.name AS category, b.amount AS budget, COALESCE(s.spent, 0) AS spent ` +
              `FROM "Budget" b JOIN "Category" c ON c.id = b."categoryId" ` +
              `LEFT JOIN (SELECT t."categoryId", ROUND(SUM(-t."chargedAmount")::numeric, 2) AS spent FROM "Transaction" t ` +
              `WHERE t."isTransfer" = false AND t."isRefund" = false AND t."chargedCurrency" = 'ILS' AND ${EFFECTIVE_MONTH} = $2 GROUP BY 1) s ` +
              `ON s."categoryId" = b."categoryId" ORDER BY c.name`,
            [month],
          ),
        };
      }
      case 'query': {
        const sql = args.sql;
        if (typeof sql !== 'string') throw new ArgError('"sql" must be a string.');
        const validation = validateChatSql(sql);
        if (!validation.ok) return { ok: false, error: `SQL rejected: ${validation.reason}` };
        return { ok: true, summary: `query ${validation.sql}`, query: scoped(validation.sql) };
      }
      default:
        return { ok: false, error: `Unknown tool "${name}".` };
    }
  } catch (error) {
    if (error instanceof ArgError) return { ok: false, error: `Invalid arguments for ${name}: ${error.message}` };
    throw error;
  }
}

const ISO_DATE_LIKE = /^\d{4}-\d{2}(-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?)?)?$/;

/**
 * Normalizes one database value for the model: numerics/bigints become
 * numbers, dates ISO strings, and every other string goes through the same
 * long-numeric-identifier redaction as the categorizer (dates and months are
 * kept so answers can cite them).
 */
export function redactResultValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    if (ISO_DATE_LIKE.test(value)) return value;
    return redactTransactionDescription(value);
  }
  // Prisma.Decimal and similar numeric wrappers.
  if (typeof value === 'object' && value !== null && 'toNumber' in value) {
    const toNumber = (value as { toNumber?: unknown }).toNumber;
    if (typeof toNumber === 'function') return Number(toNumber.call(value));
  }
  return redactTransactionDescription(JSON.stringify(value));
}

export interface ToolResult {
  rows: Record<string, unknown>[];
  truncated: boolean;
}

/** Redacts every row and applies the row cap (the query fetches one extra row to detect truncation). */
export function shapeToolRows(rows: readonly Record<string, unknown>[], rowCap = CHAT_ROW_CAP): ToolResult {
  const capped = rows.slice(0, rowCap).map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) out[key] = redactResultValue(value);
    return out;
  });
  return { rows: capped, truncated: rows.length > rowCap };
}
