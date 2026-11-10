-- Additive investment tracking:
-- 1. New INVESTMENT enum values (money moved to/from investment houses is
--    neither income nor expense — mirrors the isTransfer exclusion).
-- 2. CategorizationRule.matchMemo — opt-in memo matching for rules whose
--    merchant only appears in the transfer memo (e.g. "העברה אל: אלטשולר שחם"
--    behind a generic "העברה דיגיטל" description).
-- PostgreSQL 12+ allows ALTER TYPE ... ADD VALUE in a transaction as long as
-- the new value is not used in the same transaction — no data rows here.

-- AlterEnum
ALTER TYPE "CategoryType" ADD VALUE 'INVESTMENT';

-- AlterEnum
ALTER TYPE "CategoryGroup" ADD VALUE 'INVESTMENT';

-- AlterTable
ALTER TABLE "CategorizationRule" ADD COLUMN "matchMemo" BOOLEAN NOT NULL DEFAULT false;
