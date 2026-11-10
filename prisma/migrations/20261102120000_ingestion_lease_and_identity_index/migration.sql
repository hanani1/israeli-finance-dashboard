-- Card #48: serialize ingestion runs and index the identity lookup.

-- Run-wide ingestion lock as a lease row (see ADR-0021). A session-level
-- pg_advisory_lock would need connection affinity that Prisma's pool does not
-- give outside a transaction; a lease with expiresAt + heartbeat works over
-- any connection and expires on its own if the holder crashes.
CREATE TABLE "IngestionLease" (
    "name" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "acquiredAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "IngestionLease_pkey" PRIMARY KEY ("name")
);

-- Non-unique on purpose: the transaction identity is fuzzy (±3-day date
-- window, raw and normalized identifier forms), so no exact unique key exists,
-- and existing rows may already share an identifier. The lock above prevents
-- the findFirst -> upsert race; this index only makes that lookup fast.
CREATE INDEX "Transaction_accountId_txnIdentifier_idx" ON "Transaction"("accountId", "txnIdentifier");
