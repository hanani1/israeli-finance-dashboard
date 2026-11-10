import { NextRequest, NextResponse } from 'next/server';
import { withRouteErrors } from '@/lib/api/routeError';
import { runIngestion } from '@/lib/jobs/ingestion';
import {
  deleteCredential,
  getStoredCredentialSnapshot,
  listCredentials,
  restoreCredential,
  upsertCredential,
} from '@/lib/services/credentialService';
import { decideInitialSync, initialSyncOutcome } from '@/lib/services/credentialConnection';
import { resolveIsracardBrowserLaunch } from '@/lib/services/isracardBrowser';

export const dynamic = 'force-dynamic';

export const GET = withRouteErrors(async (): Promise<NextResponse> => {
  const credentials = await listCredentials();
  return NextResponse.json(credentials);
});

interface PostBody {
  userId: string;
  provider: string;
  loginFields: Record<string, string>;
}

export const POST = withRouteErrors(async (request: NextRequest): Promise<NextResponse> => {
  const body = (await request.json()) as PostBody;

  if (!body.userId || !body.provider || typeof body.loginFields !== 'object') {
    return NextResponse.json(
      { error: 'userId, provider and loginFields are required' },
      { status: 400 },
    );
  }

  const previousCredential = await getStoredCredentialSnapshot(body.userId, body.provider);
  let savedCredentialId: string | null = null;

  try {
    const credential = await upsertCredential(body);
    savedCredentialId = credential.id;

    // In Docker there is no host Chrome, and Isracard blocks the library's
    // headless Chromium (403 challenge / 429 on DashboardMonth). Save the
    // credential and let the host-run sync perform the first import.
    const decision = decideInitialSync(
      body.provider,
      body.provider === 'isracard'
        ? resolveIsracardBrowserLaunch(process.env, process.platform)
        : undefined,
    );
    if (decision.mode === 'deferred') {
      const sync = {
        credentialsProcessed: 0,
        accountsUpserted: 0,
        transactionsUpserted: 0,
        rulesApplied: 0,
        llmCategorized: 0,
        transfersDetected: 0,
        cardSettlementsMarked: 0,
        obsoletePendingSnapshotsMarked: 0,
        supersededPendingMarked: 0,
        errors: [],
        warnings: [],
        deferred: true,
        deferredReason: decision.reason,
      };
      return NextResponse.json({ credential, sync }, { status: 201 });
    }

    const sync = await runIngestion({ credentialId: credential.id });
    const outcome = initialSyncOutcome(sync);

    if (outcome !== 'keep') {
      if (previousCredential) {
        await restoreCredential(previousCredential);
      } else {
        await deleteCredential(credential.id);
      }
      // busy: another sync holds the ingestion lock, so this login was never
      // tried. Roll back (a connection is visible only once verified) and let
      // the user retry when the running sync finishes.
      return outcome === 'busy'
        ? NextResponse.json(
            { error: 'Another sync is already running; the connection was not saved. Try again when it finishes.', sync },
            { status: 409 },
          )
        : NextResponse.json(
            { error: 'Initial sync failed; the connection was not saved.', sync },
            { status: 400 },
          );
    }

    return NextResponse.json({ credential, sync }, { status: 201 });
  } catch (error) {
    if (savedCredentialId) {
      if (previousCredential) {
        await restoreCredential(previousCredential);
      } else {
        await deleteCredential(savedCredentialId);
      }
    }
    // Login-field validation is a RequestError(400) with its explicit message;
    // anything else (encryption, DB) is a generic 500 (withRouteErrors).
    throw error;
  }
});
