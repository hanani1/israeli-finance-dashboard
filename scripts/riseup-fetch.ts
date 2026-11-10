#!/usr/bin/env node
/**
 * Safety class: TOUCHES PROVIDER, SENSITIVE (RiseUp API with RISEUP_PAT from
 * ~/.hermes/config.yaml; the output file is your full transaction history, mode 0600; no DB access).
 *
 * Fetch every RiseUp transaction per cashflow month into a JSON snapshot for
 * `npm run riseup:compare`:
 *
 *   npm run riseup:fetch -- [--from=2024-05] [--to=<current month>] [--output=data/riseup/<file>.json]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_FROM = '2024-05';
const API_BASE = 'https://input.riseup.co.il';

type RiseUpTransaction = Record<string, unknown> & {
  transactionId: string;
  transactionDate: string;
  cashflowDate?: string;
};

function monthRange(from: string, to: string): string[] {
  const [fromYear = 0, fromMonth = 0] = from.split('-').map(Number);
  const [toYear = 0, toMonth = 0] = to.split('-').map(Number);
  const months: string[] = [];
  for (let year = fromYear, month = fromMonth; year < toYear || (year === toYear && month <= toMonth);) {
    months.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month === 13) { year += 1; month = 1; }
  }
  return months;
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function riseupPat(): Promise<string> {
  const config = await readFile(join(homedir(), '.hermes', 'config.yaml'), 'utf8');
  const match = config.match(/^\s+RISEUP_PAT:\s*["']?([^\s"'#]+)["']?\s*$/m);
  if (!match) throw new Error('RISEUP_PAT was not found in Hermes MCP configuration.');
  const token = match?.[1];
  if (!token) throw new Error('RISEUP_PAT was not found in Hermes MCP configuration.');
  return token;
}

async function main(): Promise<void> {
  const from = process.argv.find((arg) => arg.startsWith('--from='))?.slice(7) ?? DEFAULT_FROM;
  const to = process.argv.find((arg) => arg.startsWith('--to='))?.slice(5) ?? currentMonth();
  const output = process.argv.find((arg) => arg.startsWith('--output='))?.slice(9)
    ?? `data/riseup/transactions-${from}-to-${to}.json`;
  const token = await riseupPat();
  const transactions = new Map<string, RiseUpTransaction>();

  for (const month of monthRange(from, to)) {
    const response = await fetch(`${API_BASE}/api/external/transactions?cashflowMonth=${month}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`RiseUp request for ${month} failed: HTTP ${response.status}`);
    const body = await response.json() as { transactions?: RiseUpTransaction[] };
    for (const transaction of body.transactions ?? []) transactions.set(transaction.transactionId, transaction);
    console.log(`[riseup-fetch] ${month}: ${body.transactions?.length ?? 0} transaction(s)`);
  }

  await mkdir(join(process.cwd(), output, '..'), { recursive: true });
  await writeFile(output, JSON.stringify({ source: 'riseup', from, to, fetchedAt: new Date().toISOString(), transactions: [...transactions.values()] }, null, 2) + '\n', { mode: 0o600 });
  console.log(`[riseup-fetch] wrote ${transactions.size} unique transaction(s) to ${output}`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
