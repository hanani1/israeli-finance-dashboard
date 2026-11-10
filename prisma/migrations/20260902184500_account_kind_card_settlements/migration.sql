-- Additive migration: account kind + card settlement/revision flags.
-- No destructive changes; existing rows get safe defaults and are backfilled
-- by scripts/backfill-card-settlements.ts.

-- CreateEnum
CREATE TYPE "AccountKind" AS ENUM ('BANK', 'CARD');

-- AlterTable: Account.kind (BANK default; card providers set by backfill)
ALTER TABLE "Account" ADD COLUMN "kind" "AccountKind" NOT NULL DEFAULT 'BANK';

-- AlterTable: Transaction card settlement / obsolete-revision marking
ALTER TABLE "Transaction" ADD COLUMN "isCardSettlement" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Transaction" ADD COLUMN "settlesAccountId" TEXT;
