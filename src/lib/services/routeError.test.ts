/**
 * Card #53: one error policy for every API route. Known client errors keep
 * their explicit message; everything else is a generic 500 whose body never
 * carries a stack, a Prisma message or any other internal detail.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import { handleRouteError, withRouteErrors } from '../api/routeError';
import { RequestError } from './requestError';

function prismaError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `Invalid \`prisma.budget.delete()\` invocation in /app/src/lib/services/budgetService.ts:66:23 → ${code} secret-detail`,
    { code, clientVersion: '6.19.3', meta: { modelName: 'Budget', target: ['categoryId'] } },
  );
}

async function body(response: Response): Promise<{ error: string }> {
  return (await response.json()) as { error: string };
}

function quietly<T>(fn: () => T): T {
  const original = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = original;
  }
}

test('a JSON SyntaxError from request.json() is a 400', async () => {
  let thrown: unknown;
  try {
    JSON.parse('{"amount": ');
  } catch (error) {
    thrown = error;
  }
  const response = handleRouteError(thrown);
  assert.equal(response.status, 400);
  assert.deepEqual(await body(response), { error: 'Invalid JSON body' });
});

test('Prisma P2025 (record not found) is a 404', async () => {
  const response = handleRouteError(prismaError('P2025'));
  assert.equal(response.status, 404);
  assert.deepEqual(await body(response), { error: 'Not found' });
});

test('Prisma P2002 (unique) and P2003 (foreign key) are 409s', async () => {
  for (const code of ['P2002', 'P2003']) {
    const response = handleRouteError(prismaError(code));
    assert.equal(response.status, 409, code);
    const { error } = await body(response);
    assert.match(error, /^Conflict/);
    assert.doesNotMatch(error, /prisma|secret-detail|budgetService/i);
  }
});

test('anything else is a generic 500 with no stack or internal message', async () => {
  for (const error of [
    new Error('ECONNREFUSED 127.0.0.1:5432 password=hunter2'),
    prismaError('P2024'),
    new TypeError("Cannot read properties of undefined (reading 'name')"),
    'a thrown string',
    undefined,
  ]) {
    const response = quietly(() => handleRouteError(error));
    assert.equal(response.status, 500);
    const text = await response.text();
    assert.equal(text, JSON.stringify({ error: 'Internal server error' }));
  }
});

test('the 500 detail goes to the server log, not the response', () => {
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    handleRouteError(new Error('db down'), 'GET /api/budgets');
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 1);
  assert.match(String(logged[0]![0]), /GET \/api\/budgets/);
  assert.ok(logged[0]!.some((arg) => arg instanceof Error && arg.message === 'db down'));
});

test('a RequestError keeps its explicit status and client-facing message', async () => {
  const response = handleRouteError(new RequestError(400, 'amount must be a non-negative number'));
  assert.equal(response.status, 400);
  assert.deepEqual(await body(response), { error: 'amount must be a non-negative number' });
  const conflict = handleRouteError(new RequestError(409, 'This member still has bank connections'));
  assert.equal(conflict.status, 409);
});

test('withRouteErrors passes responses through and maps thrown errors', async () => {
  const ok = withRouteErrors(async (value: number) => Response.json({ value }));
  assert.deepEqual(await (await ok(7)).json(), { value: 7 });
  const failing = withRouteErrors(async () => {
    throw prismaError('P2025');
  });
  assert.equal((await failing()).status, 404);
});

// Every route module must export only wrapped handlers.
const API_DIR = path.join(__dirname, '..', '..', 'app', 'api');

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return name === 'route.ts' ? [full] : [];
  });
}

test('every API route handler is wrapped with withRouteErrors', () => {
  const files = routeFiles(API_DIR);
  assert.ok(files.length >= 20, `found only ${files.length} route files`);
  for (const file of files) {
    const rel = path.relative(API_DIR, file).split(path.sep).join('/');
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/, `${rel}: unwrapped handler`);
    const handlers = [...source.matchAll(/export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=\s*([A-Za-z]+)\(/g)];
    assert.ok(handlers.length > 0, `${rel}: no exported handlers found`);
    for (const [, method, wrapper] of handlers) {
      assert.equal(wrapper, 'withRouteErrors', `${rel}: ${method} must be withRouteErrors(...)`);
    }
  }
});
