/**
 * Standalone ingestion worker.
 *
 * Usage:
 *   npm run worker            — run continuously, scraping daily at 04:00
 *   npm run sync:once         — full history on first success, then last 7 days
 *   npm run sync:once -- --from=YYYY-MM-DD
 *                             — one-off full-history backfill from the given date
 */
import { loadEnvFile } from 'node:process';
import cron from 'node-cron';
import {
  DAILY_INGESTION_CRON,
  DAILY_INGESTION_CRON_OPTIONS,
  INGESTION_TIME_ZONE,
  pinProcessTimeZone,
} from '../services/processTimeZone';
import { runIngestion } from './ingestion';

try {
  loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
// After .env: a different TZ there must not override the ingestion zone (ADR-0020).
pinProcessTimeZone();

/** `--from=YYYY-MM-DD` → explicit backfill start date (else lifecycle-aware window). */
function parseStartDate(): Date | undefined {
  const arg = process.argv.find((a) => a.startsWith('--from='));
  if (!arg) return undefined;
  const date = new Date(arg.slice('--from='.length));
  if (Number.isNaN(date.getTime())) {
    console.error(`[worker] Ignoring invalid --from date: ${arg}`);
    return undefined;
  }
  return date;
}

/** `--providers=max,visaCal` → only sync these providers (else all). */
function parseProviders(): string[] | undefined {
  const arg = process.argv.find((a) => a.startsWith('--providers='));
  if (!arg) return undefined;
  const providers = arg
    .slice('--providers='.length)
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  return providers.length > 0 ? providers : undefined;
}

async function runOnce(): Promise<void> {
  const startDate = parseStartDate();
  if (startDate) {
    console.log(`[worker] Full-history backfill from ${startDate.toISOString().slice(0, 10)}`);
  }
  const providers = parseProviders();
  if (providers) {
    console.log(`[worker] Limiting sync to providers: ${providers.join(', ')}`);
  }
  const summary = await runIngestion({ categorizeWithLlm: true, startDate, providers });
  if (summary.errors.length > 0) {
    process.exitCode = 1;
  }
}

function main(): void {
  const once = process.argv.includes('--once');

  if (once) {
    void runOnce().finally(() => process.exit(process.exitCode ?? 0));
    return;
  }

  console.log(
    `[worker] Scheduling daily ingestion at 04:00 ${INGESTION_TIME_ZONE} (${DAILY_INGESTION_CRON}), TZ=${process.env.TZ ?? 'system'}`,
  );
  cron.schedule(
    DAILY_INGESTION_CRON,
    async () => {
      try {
        await runIngestion({ categorizeWithLlm: true });
      } catch (error) {
        console.error('[worker] Ingestion run crashed:', error);
      }
    },
    DAILY_INGESTION_CRON_OPTIONS,
  );
}

main();
