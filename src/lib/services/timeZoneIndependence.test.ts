import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import {
  DAILY_INGESTION_CRON,
  DAILY_INGESTION_CRON_OPTIONS,
  INGESTION_TIME_ZONE,
  pinProcessTimeZone,
} from './processTimeZone';

// Card #46: the same scraped bank row must get the same deterministic id and
// flow month whether ingestion runs on the Mac host (TZ=Asia/Jerusalem) or
// in Docker (no TZ → UTC). Each run is a fresh child process because the
// process time zone is global state.

const PROBE = path.join(__dirname, '__fixtures__', 'timeZoneProbe.ts');
const TSX_CLI = require.resolve('tsx/cli');

interface ProbeRow {
  provider: string;
  date: string;
  id: string;
  flowMonth: string;
}
interface ProbeOutput {
  tzAfterImport: string | undefined;
  unpinned: string[];
  pinned: ProbeRow[];
}

function probe(tz: string | undefined): ProbeOutput {
  const env = { ...process.env };
  if (tz === undefined) delete env.TZ;
  else env.TZ = tz;
  const stdout = execFileSync(process.execPath, [TSX_CLI, PROBE], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  const line = stdout.trim().split('\n').pop() ?? '';
  return JSON.parse(line) as ProbeOutput;
}

const runs = {
  utc: probe('UTC'),
  israel: probe('Asia/Jerusalem'),
  newYork: probe('America/New_York'),
  unset: probe(undefined),
};

test('control: israeli-bank-scrapers date parsing depends on the process time zone', () => {
  // Without the pin the same provider day yields different instants.
  assert.notDeepEqual(runs.utc.unpinned, runs.israel.unpinned);
  assert.equal(runs.utc.unpinned[0], '2026-02-01T00:00:00.000Z');
  assert.equal(runs.israel.unpinned[0], '2026-01-31T22:00:00.000Z');
});

test('loading ingestion pins the process to Asia/Jerusalem in every runtime', () => {
  for (const run of Object.values(runs)) assert.equal(run.tzAfterImport, INGESTION_TIME_ZONE);
});

test('ids and flow months are identical under TZ=UTC, Asia/Jerusalem, America/New_York and unset', () => {
  assert.deepEqual(runs.utc.pinned, runs.israel.pinned);
  assert.deepEqual(runs.newYork.pinned, runs.israel.pinned);
  assert.deepEqual(runs.unset.pinned, runs.israel.pinned);
});

test('pinned provider days are Israel-local midnight and bucket into their Israeli month', () => {
  const byProvider = Object.fromEntries(runs.utc.pinned.map((r) => [r.provider, r]));
  // Feb 1 00:00 Israel (IST, UTC+2) is February, not January.
  assert.equal(byProvider.discount?.date, '2026-01-31T22:00:00.000Z');
  assert.equal(byProvider.discount?.flowMonth, '2026-02');
  assert.equal(byProvider.isracard?.date, '2026-08-31T21:00:00.000Z');
  assert.equal(byProvider.isracard?.flowMonth, '2026-09');
  assert.equal(byProvider.max?.date, '2026-02-28T22:00:00.000Z');
  assert.equal(byProvider.max?.flowMonth, '2026-03');
  assert.equal(byProvider.visaCal?.date, '2026-09-30T21:00:00.000Z');
  assert.equal(byProvider.visaCal?.flowMonth, '2026-10');
  assert.equal(byProvider['visaCal-processed']?.date, '2026-11-30T22:00:00.000Z');
});

test('pinProcessTimeZone sets TZ only when it differs and reports it', () => {
  const warnings: string[] = [];
  const env: NodeJS.ProcessEnv = { ...process.env, TZ: 'UTC' };
  assert.equal(pinProcessTimeZone(env, (m) => warnings.push(m)), true);
  assert.equal(env.TZ, 'Asia/Jerusalem');
  assert.equal(warnings.length, 1);
  assert.equal(pinProcessTimeZone(env, (m) => warnings.push(m)), false);
  assert.equal(warnings.length, 1);
});

test('daily cron is 04:00 in Asia/Jerusalem regardless of host zone', () => {
  assert.equal(DAILY_INGESTION_CRON, '0 4 * * *');
  assert.deepEqual(DAILY_INGESTION_CRON_OPTIONS, { timezone: 'Asia/Jerusalem' });
});
