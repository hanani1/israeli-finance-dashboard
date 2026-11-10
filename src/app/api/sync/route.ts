import { NextResponse } from 'next/server';
import { withRouteErrors } from '@/lib/api/routeError';
import { runIngestion } from '@/lib/jobs/ingestion';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // an initial full-history scrape can be slow

/**
 * Manually trigger ingestion. Each connection gets one full-history import;
 * after that, manual and scheduled runs use the seven-day incremental window.
 */
export const POST = withRouteErrors(async (): Promise<NextResponse> => {
  const summary = await runIngestion();
  // 409: another run (worker cron, launchd, another tab) holds the ingestion lock.
  const status = summary.skipped ? 409 : summary.errors.length > 0 ? 207 : 200;
  return NextResponse.json(summary, { status });
});
