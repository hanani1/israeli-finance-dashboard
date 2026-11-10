import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BACKUP_MAX_AGE_HOURS,
  RefundCorrectionError,
  assertConfirmedDatabase,
  assertUsableBackup,
  databaseNameFromUrl,
  parseRefundCorrectionArgs,
} from './refundCorrection';

test('mark-transaction-refund refuses to run without --id or --backup', () => {
  assert.throws(() => parseRefundCorrectionArgs(['--backup=/tmp/x.dump']), RefundCorrectionError);
  assert.throws(() => parseRefundCorrectionArgs(['--id=abc']), /--backup=<pg_dump path> is required/);
  assert.throws(() => parseRefundCorrectionArgs(['--id=abc', '--backup=']), RefundCorrectionError);
});

test('dry run is the default; --apply also needs --confirm-db; --revert is parsed', () => {
  assert.deepEqual(parseRefundCorrectionArgs(['--id=abc', '--backup=/tmp/x.dump']), {
    id: 'abc',
    backup: '/tmp/x.dump',
    apply: false,
    revert: false,
    confirmDb: null,
  });
  assert.throws(() => parseRefundCorrectionArgs(['--id=abc', '--backup=/tmp/x.dump', '--apply']), /confirm-db/);
  const args = parseRefundCorrectionArgs(['--id=abc', '--backup=/tmp/x.dump', '--apply', '--revert', '--confirm-db=fd_60']);
  assert.equal(args.apply, true);
  assert.equal(args.revert, true);
  assert.equal(args.confirmDb, 'fd_60');
});

test('unknown or misspelled flags are rejected (no silent --aply dry runs)', () => {
  assert.throws(() => parseRefundCorrectionArgs(['--id=abc', '--backup=/tmp/x', '--aply']), /Unknown argument/);
  assert.throws(() => parseRefundCorrectionArgs(['--id=abc', '--backup=/tmp/x', 'apply']), /Unknown argument/);
});

const now = Date.parse('2026-11-02T12:00:00Z');
const goodDump = { isFile: true, size: 4096, mtimeMs: now - 3_600_000, head: 'PGDMP\u0001\u000e' };

test('a recent non-empty pg_dump (custom or plain) is accepted', () => {
  assert.doesNotThrow(() => assertUsableBackup(goodDump, now));
  assert.doesNotThrow(() =>
    assertUsableBackup({ ...goodDump, head: '--\n-- PostgreSQL database dump\n--\n' }, now),
  );
});

test('missing, empty, non-dump, directory or stale backups are refused', () => {
  assert.throws(() => assertUsableBackup(null, now), /does not exist/);
  assert.throws(() => assertUsableBackup({ ...goodDump, size: 0 }, now), /empty/);
  assert.throws(() => assertUsableBackup({ ...goodDump, isFile: false }, now), /regular file/);
  assert.throws(() => assertUsableBackup({ ...goodDump, head: 'hello' }, now), /pg_dump/);
  const stale = { ...goodDump, mtimeMs: now - (BACKUP_MAX_AGE_HOURS + 1) * 3_600_000 };
  assert.throws(() => assertUsableBackup(stale, now), /fresh pg_dump/);
});

test('--apply only proceeds when --confirm-db names the DATABASE_URL database', () => {
  assert.equal(databaseNameFromUrl('postgresql://127.0.0.1:5432/fd_60?schema=public'), 'fd_60');
  assert.equal(databaseNameFromUrl(undefined), null);
  const apply = parseRefundCorrectionArgs(['--id=a', '--backup=/b', '--apply', '--confirm-db=fd_60']);
  assert.doesNotThrow(() => assertConfirmedDatabase(apply, 'postgresql://127.0.0.1:5432/fd_60?schema=public'));
  assert.throws(
    () => assertConfirmedDatabase(apply, 'postgresql://127.0.0.1:5432/finance?schema=public'),
    /does not match/,
  );
  const dry = parseRefundCorrectionArgs(['--id=a', '--backup=/b']);
  assert.doesNotThrow(() => assertConfirmedDatabase(dry, 'postgresql://127.0.0.1:5432/finance'));
});
