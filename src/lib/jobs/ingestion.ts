/**
 * Ingestion pipeline: scrape bank/card providers and persist transactions.
 *
 * Design goals:
 *  - Deterministic: every transaction gets a stable SHA-256 derived id, so the
 *    same scraped row always maps to the same DB row.
 *  - Idempotent: re-running the job upserts instead of inserting duplicates.
 *    Pending transactions that later settle (same identity fields) are
 *    cleanly updated in place.
 */
import crypto from 'node:crypto';
import { createScraper, CompanyTypes } from 'israeli-bank-scrapers';
import type { ScraperCredentials } from 'israeli-bank-scrapers';
import type { Transaction as ScrapedTransaction } from 'israeli-bank-scrapers/lib/transactions';
import { prisma } from '@/lib/db';
import { decryptSecret } from '@/lib/security/crypto';
import { applyCategorizationRules } from '@/lib/services/ruleEngine';
import { categorizeUnassignedTransactions } from '@/lib/services/llmCategorizationService';
import { detectAndMarkTransfers } from '@/lib/services/transferService';
import { detectAndMarkCardSettlements } from '@/lib/services/cardSettlementService';
import { detectAndMarkSupersededPending } from '@/lib/services/pendingSettlementService';
import {
  restoreReappearedPending,
  retireUnseenPending,
  type ScrapedAccountRows,
} from '@/lib/services/pendingRetirementService';
import { accountKindForProvider } from '@/lib/services/accountKind';
import { prepareLoginFields } from '@/lib/services/providerCredentials';
import { resolveChargedCurrency } from '@/lib/services/scrapedCurrency';
import { normalizeTxnIdentifier, rawTxnIdentifier } from '@/lib/services/pendingSettlement';
import { buildScrapedTransactionWrite } from '@/lib/services/scrapedTransactionWrite';
import { identityDateWindow } from '@/lib/services/transactionIdentity';
import { money } from '@/lib/services/money';
import { launchIsracardBrowser, resolveIsracardBrowserLaunch } from '@/lib/services/isracardBrowser';
import {
  INGESTION_ALREADY_RUNNING,
  INGESTION_LEASE_HEARTBEAT_MS,
  INGESTION_LEASE_NAME,
  INGESTION_LEASE_TTL_MS,
  withLease,
} from '@/lib/services/ingestionLock';
import { leaseHolderId, prismaLeaseStore } from './ingestionLease';
import {
  classifyScrapeFailure,
  incrementalScrapeStart,
  staleSyncWarning,
  uncoveredDays,
} from '@/lib/services/syncCoverage';
import { pinProcessTimeZone } from '@/lib/services/processTimeZone';

// The scrapers parse provider dates in the process-local zone and those
// instants feed computeTransactionId — pin it before anything scrapes, in
// whichever process (worker, Next server via /api/sync) loads ingestion.
pinProcessTimeZone();

const FULL_HISTORY_START = new Date('1970-01-01T00:00:00.000Z');

// max/visaCal login flows regularly exceed the library's default 30s
// navigation timeout; give slow redirects more headroom.
const SCRAPER_TIMEOUT_MS = 120_000;
const SHOW_ISRACARD_BROWSER = process.env.ISRACARD_SHOW_BROWSER === 'true';

export interface IngestionSummary {
  credentialsProcessed: number;
  accountsUpserted: number;
  transactionsUpserted: number;
  rulesApplied: number;
  llmCategorized: number;
  transfersDetected: number;
  cardSettlementsMarked: number;
  obsoletePendingSnapshotsMarked: number;
  supersededPendingMarked: number;
  /** Pending rows hidden because the provider stopped returning them (card #49). */
  pendingRetired: number;
  /** Previously retired pending rows un-hidden because the provider returned them again. */
  pendingRestored: number;
  errors: string[];
  /** Coverage problems that errors=0 does not reveal (stale or gapped credentials). */
  warnings: string[];
  /** Set when the run did nothing because another run holds the lock. */
  skipped?: typeof INGESTION_ALREADY_RUNNING;
}

function emptySummary(): IngestionSummary {
  return {
    credentialsProcessed: 0,
    accountsUpserted: 0,
    transactionsUpserted: 0,
    rulesApplied: 0,
    llmCategorized: 0,
    transfersDetected: 0,
    cardSettlementsMarked: 0,
    obsoletePendingSnapshotsMarked: 0,
    supersededPendingMarked: 0,
    pendingRetired: 0,
    pendingRestored: 0,
    errors: [],
    warnings: [],
  };
}

/**
 * Deterministic transaction id:
 * SHA256(accountId + "_" + date.toISOString() + "_" + chargedAmount + "_" + description)
 */
export function computeTransactionId(
  accountId: string,
  date: Date,
  chargedAmount: number,
  description: string,
): string {
  const fingerprint = `${accountId}_${date.toISOString()}_${chargedAmount}_${description}`;
  return crypto.createHash('sha256').update(fingerprint, 'utf8').digest('hex');
}

/** Deterministic account id, stable across scrape runs. */
function computeAccountId(userId: string, provider: string, accountNumber: string): string {
  return crypto
    .createHash('sha256')
    .update(`${userId}_${provider}_${accountNumber}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

/**
 * When a credential last scraped successfully. Account rows are written only
 * by a successful ingestCredential (their balance upsert bumps updatedAt on
 * every success), so the newest one marks the credential's last success.
 */
async function lastSuccessfulSync(userId: string, provider: string): Promise<Date | null> {
  const result = await prisma.account.aggregate({
    where: { userId, provider },
    _max: { updatedAt: true },
  });
  return result._max.updatedAt ?? null;
}

function isSupportedProvider(provider: string): provider is CompanyTypes {
  return Object.values(CompanyTypes).includes(provider as CompanyTypes);
}

/** Upsert one scraped row; returns the id of the stored row. */
async function upsertScrapedTransaction(
  accountId: string,
  txn: ScrapedTransaction,
): Promise<string> {
  const date = new Date(txn.date);
  // Providers move a transaction's date between scrapes (pending time →
  // settled midnight, posting-date corrections). Identify by the stable
  // fields within a small date window; see transactionIdentity.ts.
  // Identifiers are stored normalized (no leading zeros); rows ingested before
  // normalization may still carry the provider's padded form, so match both.
  const identifier = normalizeTxnIdentifier(txn.identifier);
  const rawIdentifier = rawTxnIdentifier(txn.identifier);
  const identifierForms = [identifier, rawIdentifier].filter((v): v is string => v != null);
  const existing = identifier != null
    ? await prisma.transaction.findFirst({
        where: {
          accountId,
          txnIdentifier: { in: identifierForms },
          date: identityDateWindow(date),
          // Compare at the column scale: a raw float with sub-agorot noise
          // would never equal the stored DECIMAL(14,2).
          chargedAmount: money(txn.chargedAmount),
          description: txn.description,
        },
        orderBy: { createdAt: 'asc' },
      })
    : null;
  // The id fingerprint deliberately keeps the RAW scraper number: changing
  // its text form would re-key every existing row (duplicates on re-scrape).
  const id = existing?.id ?? computeTransactionId(accountId, date, txn.chargedAmount, txn.description);

  // Provider-owned fields converge to the latest scrape; user-owned fields
  // (note, category, flags, flow month) are never in the update payload.
  const write = buildScrapedTransactionWrite(accountId, id, txn);
  await prisma.transaction.upsert({ where: { id }, update: write.update, create: write.create });
  return id;
}

/** Scrape a single stored credential and persist its accounts + transactions. */
async function ingestCredential(
  credential: {
    id: string;
    userId: string;
    provider: string;
    encryptedData: string;
    iv: string;
    authTag: string;
    initialSyncCompletedAt: Date | null;
  },
  summary: IngestionSummary,
  lastSuccessfulSyncAt: Date | null,
  startDateOverride?: Date,
): Promise<ScrapedAccountRows[]> {
  if (!isSupportedProvider(credential.provider)) {
    throw new Error(`Unsupported provider "${credential.provider}"`);
  }

  const storedLoginFields = JSON.parse(
    decryptSecret({
      ciphertext: credential.encryptedData,
      iv: credential.iv,
      tag: credential.authTag,
    }),
  ) as Record<string, string>;
  const loginFields = prepareLoginFields(
    credential.provider,
    storedLoginFields,
  ) as ScraperCredentials;

  // A connection's first successful scrape requests all history the provider
  // exposes. Later scheduled/manual syncs reach back to the last successful
  // sync plus an overlap, so a provider outage never leaves a hole.
  // An explicit CLI override still takes precedence.
  let startDate: Date;
  if (startDateOverride) {
    startDate = startDateOverride;
  } else if (!credential.initialSyncCompletedAt) {
    startDate = FULL_HISTORY_START;
    console.log(
      `[ingestion] Initial full-history import: ${credential.provider} (user ${credential.userId})`,
    );
  } else {
    startDate = incrementalScrapeStart(new Date(), lastSuccessfulSyncAt);
    console.log(
      `[ingestion] ${credential.provider}: incremental window from ${startDate.toISOString()} (last success ${lastSuccessfulSyncAt?.toISOString() ?? 'unknown'})`,
    );
  }
  const gapDays = uncoveredDays(startDate, lastSuccessfulSyncAt);
  if (gapDays > 0) {
    summary.warnings.push(
      `[coverage] ${credential.provider}: window starts ${gapDays} day(s) after the last successful sync; rows dated in that gap are not requested.`,
    );
  }

  // Isracard sits behind a Cloudflare managed challenge. On a host with a real
  // Chrome we hand the library a headful browser with a persistent profile so
  // the clearance cookie survives between runs; elsewhere (Docker) the
  // library's own browser is used.
  const isracardLaunch = credential.provider === CompanyTypes.isracard
    ? resolveIsracardBrowserLaunch(process.env, process.platform)
    : undefined;
  const externalBrowser = isracardLaunch ? await launchIsracardBrowser(isracardLaunch) : undefined;
  if (isracardLaunch) {
    console.log(
      `[ingestion] Isracard: host browser ${isracardLaunch.headless ? 'headless' : 'headful'} with profile ${isracardLaunch.userDataDir}`,
    );
  }

  let result;
  try {
    const scraper = createScraper({
      companyId: credential.provider,
      startDate,
      combineInstallments: false,
      verbose: false,
      timeout: SCRAPER_TIMEOUT_MS,
      defaultTimeout: SCRAPER_TIMEOUT_MS,
      ...(externalBrowser
        ? { browser: externalBrowser }
        : {
            // Docker has no X server. Keep Isracard headless unless explicitly
            // enabled for a local interactive debugging session.
            showBrowser: credential.provider === CompanyTypes.isracard && SHOW_ISRACARD_BROWSER,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
          }),
    });

    result = await scraper.scrape(loginFields);
  } finally {
    await externalBrowser?.close();
  }

  if (!result.success || !result.accounts) {
    throw new Error(
      `Scrape failed for provider ${credential.provider}: ${result.errorType ?? 'UNKNOWN'} ${result.errorMessage ?? ''}`.trim(),
    );
  }

  const scrapedAccounts: ScrapedAccountRows[] = [];
  for (const scrapedAccount of result.accounts) {
    const accountId = computeAccountId(
      credential.userId,
      credential.provider,
      scrapedAccount.accountNumber,
    );

    await prisma.account.upsert({
      where: { id: accountId },
      update: {
        balance: money(scrapedAccount.balance ?? 0),
        kind: accountKindForProvider(credential.provider),
      },
      create: {
        id: accountId,
        userId: credential.userId,
        provider: credential.provider,
        kind: accountKindForProvider(credential.provider),
        accountNumber: scrapedAccount.accountNumber,
        displayName: `${credential.provider} •${scrapedAccount.accountNumber.slice(-4)}`,
        balance: money(scrapedAccount.balance ?? 0),
      },
    });
    summary.accountsUpserted += 1;

    const seenIds = new Set<string>();
    for (const txn of scrapedAccount.txns) {
      // Never default a foreign pending charge to ILS (card #49): see scrapedCurrency.ts.
      const normalizedTxn = {
        ...txn,
        chargedCurrency: resolveChargedCurrency(credential.provider, txn),
      };
      seenIds.add(await upsertScrapedTransaction(accountId, normalizedTxn));
      summary.transactionsUpserted += 1;
    }
    const scraped = { accountId, provider: credential.provider, seenIds };
    summary.pendingRestored += await restoreReappearedPending(scraped);
    scrapedAccounts.push(scraped);
  }
  return scrapedAccounts;
}

export interface IngestionOptions {
  categorizeWithLlm?: boolean;
  /** Limit the run to one connection, e.g. immediately after it is saved. */
  credentialId?: string;
  /** Override the scrape start date. Otherwise: full history once, then seven days. */
  startDate?: Date;
  /** If set, only scrape credentials for these providers (e.g. ['max', 'visaCal']). */
  providers?: string[];
}

/**
 * Run a full ingestion cycle: scrape every stored credential, upsert
 * accounts/transactions, then apply categorization rules to anything
 * still uncategorized. Errors on one credential do not abort the others.
 *
 * Runs are serialized across processes (launchd/worker cron, Sync Now,
 * credential save) by a database lease: overlapping runs would start
 * duplicate Chromiums, repeat live bank logins (lockout risk), race the
 * findFirst -> upsert identity lookup, and flip-flop settlement marking.
 * When another run holds the lease this returns immediately with
 * `skipped: 'ingestion already running'`.
 */
export async function runIngestion(
  options: IngestionOptions = {},
): Promise<IngestionSummary> {
  const result = await withLease(prismaLeaseStore(prisma), () => runIngestionLocked(options), {
    name: INGESTION_LEASE_NAME,
    holder: leaseHolderId(),
    ttlMs: INGESTION_LEASE_TTL_MS,
    heartbeatMs: INGESTION_LEASE_HEARTBEAT_MS,
  });
  if (result.acquired) return result.value;
  console.log(`[ingestion] Skipped: ${INGESTION_ALREADY_RUNNING}.`);
  return { ...emptySummary(), skipped: INGESTION_ALREADY_RUNNING };
}

async function runIngestionLocked(options: IngestionOptions): Promise<IngestionSummary> {
  const summary = emptySummary();

  let credentials = await prisma.bankCredential.findMany({
    where: options.credentialId ? { id: options.credentialId } : undefined,
  });
  if (options.providers && options.providers.length > 0) {
    credentials = credentials.filter((c) => options.providers!.includes(c.provider));
  }
  console.log(`[ingestion] Starting run for ${credentials.length} credential(s).`);

  // Accounts whose credential scraped successfully this run; only these can
  // prove that a pending row is no longer returned by the provider.
  const scrapedAccounts: ScrapedAccountRows[] = [];

  for (const credential of credentials) {
    const lastSuccessfulSyncAt = await lastSuccessfulSync(credential.userId, credential.provider);
    try {
      scrapedAccounts.push(
        ...(await ingestCredential(credential, summary, lastSuccessfulSyncAt, options.startDate)),
      );
      if (!credential.initialSyncCompletedAt) {
        await prisma.bankCredential.update({
          where: { id: credential.id },
          data: { initialSyncCompletedAt: new Date() },
        });
      }
      summary.credentialsProcessed += 1;
      console.log(`[ingestion] OK: ${credential.provider} (user ${credential.userId})`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const message = `[ingestion] FAILED (${classifyScrapeFailure(reason)}): ${credential.provider} (user ${credential.userId}): ${reason}`;
      console.error(message);
      summary.errors.push(message);
      const stale = staleSyncWarning(credential.provider, lastSuccessfulSyncAt, new Date());
      if (stale) summary.warnings.push(stale);
    }
  }

  // Pair inter-account transfers before categorization so cash-flow analytics
  // never count them; detection failure must not block the rest of the run.
  try {
    summary.transfersDetected = await detectAndMarkTransfers();
  } catch (error) {
    const message = `[transfers] Detection failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
    console.error(message);
    summary.errors.push(message);
  }

  // Mark covered card settlements and obsolete pending-charge revisions so
  // analytics never double-count card spending; failure must not block the run.
  try {
    const cardSummary = await detectAndMarkCardSettlements();
    summary.cardSettlementsMarked = cardSummary.settlementsMarked;
    summary.obsoletePendingSnapshotsMarked = cardSummary.obsoleteSnapshotsMarked;
  } catch (error) {
    const message = `[card-settlements] Detection failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
    console.error(message);
    summary.errors.push(message);
  }

  // Hide pending card rows superseded by their settled row (Isracard id/text
  // change, Cal no-id snapshots) so a purchase is counted once.
  try {
    const pendingSummary = await detectAndMarkSupersededPending();
    summary.supersededPendingMarked = pendingSummary.supersededMarked;
  } catch (error) {
    const message = `[pending-settlement] Detection failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
    console.error(message);
    summary.errors.push(message);
  }

  // Retire pending rows the provider stopped returning (cancelled
  // authorizations, settled under a different amount) once older than the
  // provider's pending horizon. After the matcher, so matched rows keep its
  // category carry-over; failure must not block the run.
  try {
    summary.pendingRetired = await retireUnseenPending(scrapedAccounts);
  } catch (error) {
    const message = `[pending-retirement] Failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
    console.error(message);
    summary.errors.push(message);
  }

  summary.rulesApplied = await applyCategorizationRules();
  if (options.categorizeWithLlm) {
    try {
      summary.llmCategorized = await categorizeUnassignedTransactions();
    } catch (error) {
      const message = `[categorization] Kiro LLM failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      console.error(message);
      summary.errors.push(message);
    }
  }

  for (const warning of summary.warnings) console.warn(warning);
  console.log(
    `[ingestion] Done. accounts=${summary.accountsUpserted} txns=${summary.transactionsUpserted} transfers=${summary.transfersDetected} settlements=${summary.cardSettlementsMarked} obsoleteSnapshots=${summary.obsoletePendingSnapshotsMarked} supersededPending=${summary.supersededPendingMarked} pendingRetired=${summary.pendingRetired} pendingRestored=${summary.pendingRestored} rules=${summary.rulesApplied} llm=${summary.llmCategorized} errors=${summary.errors.length} warnings=${summary.warnings.length}`,
  );
  return summary;
}
