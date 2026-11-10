/**
 * Prisma-backed LeaseStore for the run-wide ingestion lock (card #48).
 *
 * Every statement is a single atomic SQL command evaluated against the
 * database clock (`now()`), so it is safe over any pooled connection and
 * immune to clock skew between the host worker and the web container.
 * Acquire uses INSERT ... ON CONFLICT DO UPDATE ... WHERE expired: the row
 * lock taken by ON CONFLICT serializes concurrent acquirers, and only the one
 * whose WHERE still holds after re-check gets a RETURNING row.
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { PrismaClient } from '@prisma/client';
import type { LeaseStore } from '@/lib/services/ingestionLock';

type SqlClient = Pick<PrismaClient, '$queryRaw' | '$executeRaw'>;

export function prismaLeaseStore(client: SqlClient): LeaseStore {
  return {
    async tryAcquire(name, holder, ttlMs) {
      const rows = await client.$queryRaw<{ holder: string }[]>`
        INSERT INTO "IngestionLease" ("name", "holder", "acquiredAt", "expiresAt")
        VALUES (${name}, ${holder}, now(), now() + (${ttlMs}::int * interval '1 millisecond'))
        ON CONFLICT ("name") DO UPDATE
          SET "holder" = EXCLUDED."holder",
              "acquiredAt" = EXCLUDED."acquiredAt",
              "expiresAt" = EXCLUDED."expiresAt"
          WHERE "IngestionLease"."expiresAt" <= now()
        RETURNING "holder"`;
      return rows[0]?.holder === holder;
    },
    async renew(name, holder, ttlMs) {
      const updated = await client.$executeRaw`
        UPDATE "IngestionLease"
           SET "expiresAt" = now() + (${ttlMs}::int * interval '1 millisecond')
         WHERE "name" = ${name} AND "holder" = ${holder}`;
      return updated === 1;
    },
    async release(name, holder) {
      await client.$executeRaw`
        DELETE FROM "IngestionLease" WHERE "name" = ${name} AND "holder" = ${holder}`;
    },
  };
}

/** Unique per process and per run, readable when inspecting the table. */
export function leaseHolderId(): string {
  return `${hostname()}:${process.pid}:${randomUUID()}`;
}
