-- Persist the scraper's pending/completed status and record when a pending
-- row the provider stopped returning was retired (card #49, ADR-0025).
-- Both columns are nullable; existing rows are unchanged (null = unknown /
-- never retired). No row is deleted or re-hidden by this migration.
ALTER TABLE "Transaction" ADD COLUMN "providerStatus" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "pendingRetiredAt" TIMESTAMP(3);
