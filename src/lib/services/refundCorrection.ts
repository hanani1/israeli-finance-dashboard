/**
 * Guard rails for scripts/mark-transaction-refund.ts (pure, unit-tested).
 * Card #60, ADR-0024 — the historical Pasta Bar correction and any later
 * one-row isRefund correction made outside the UI.
 *
 * - `--id=<transaction id>` and `--backup=<pg_dump path>` are required; the
 *   script refuses to run (even a dry run) without a recent, non-empty
 *   pg_dump file so the dated pre-apply backup can never be skipped.
 * - Dry run by default; `--apply` writes, and also requires
 *   `--confirm-db=<database name>` matching DATABASE_URL so a stray shell
 *   variable cannot point the write at the wrong database.
 * - `--revert` sets isRefund back to false (the same guards apply).
 */
export class RefundCorrectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefundCorrectionError';
  }
}

export const BACKUP_MAX_AGE_HOURS = 24;

export interface RefundCorrectionArgs {
  id: string;
  backup: string;
  apply: boolean;
  revert: boolean;
  confirmDb: string | null;
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

const KNOWN_FLAGS = new Set(['id', 'backup', 'apply', 'revert', 'confirm-db']);

export function parseRefundCorrectionArgs(argv: readonly string[]): RefundCorrectionArgs {
  for (const arg of argv) {
    const name = arg.replace(/^--/, '').split('=')[0] ?? '';
    if (!arg.startsWith('--') || !KNOWN_FLAGS.has(name)) {
      throw new RefundCorrectionError(`Unknown argument: ${arg}`);
    }
  }
  const id = flagValue(argv, 'id')?.trim();
  if (!id) throw new RefundCorrectionError('--id=<transaction id> is required');
  const backup = flagValue(argv, 'backup')?.trim();
  if (!backup) {
    throw new RefundCorrectionError(
      '--backup=<pg_dump path> is required: take a dated pg_dump of the database first',
    );
  }
  const apply = argv.includes('--apply');
  const confirmDb = flagValue(argv, 'confirm-db')?.trim() || null;
  if (apply && !confirmDb) {
    throw new RefundCorrectionError('--apply requires --confirm-db=<database name>');
  }
  return { id, backup, apply, revert: argv.includes('--revert'), confirmDb };
}

export interface BackupFileInfo {
  isFile: boolean;
  size: number;
  mtimeMs: number;
  /** First bytes of the file, decoded as latin1/utf8. */
  head: string;
}

/** pg_dump custom format starts with "PGDMP"; plain format with a SQL comment banner. */
export function looksLikePgDump(head: string): boolean {
  return head.startsWith('PGDMP') || /^--\s*\n--\s*PostgreSQL database dump/.test(head);
}

export function assertUsableBackup(info: BackupFileInfo | null, nowMs: number): void {
  if (!info) throw new RefundCorrectionError('Backup file does not exist');
  if (!info.isFile) throw new RefundCorrectionError('Backup path is not a regular file');
  if (info.size <= 0) throw new RefundCorrectionError('Backup file is empty');
  if (!looksLikePgDump(info.head)) {
    throw new RefundCorrectionError('Backup file does not look like a pg_dump (custom or plain format)');
  }
  const ageHours = (nowMs - info.mtimeMs) / 3_600_000;
  if (ageHours > BACKUP_MAX_AGE_HOURS) {
    throw new RefundCorrectionError(
      `Backup is ${ageHours.toFixed(1)}h old; take a fresh pg_dump (max ${BACKUP_MAX_AGE_HOURS}h)`,
    );
  }
}

/** Database name from a postgres URL (path segment before any query). */
export function databaseNameFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    return name || null;
  } catch {
    return null;
  }
}

export function assertConfirmedDatabase(args: RefundCorrectionArgs, databaseUrl: string | undefined): void {
  if (!args.apply) return;
  const actual = databaseNameFromUrl(databaseUrl);
  if (!actual) throw new RefundCorrectionError('DATABASE_URL is not set or has no database name');
  if (actual !== args.confirmDb) {
    throw new RefundCorrectionError(
      `--confirm-db=${args.confirmDb} does not match the DATABASE_URL database "${actual}"`,
    );
  }
}
