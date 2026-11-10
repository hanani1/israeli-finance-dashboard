-- Semantic same-sign refund flag (card #60, ADR-0024). The raw provider
-- chargedAmount/sign is preserved; isRefund only changes how the row is
-- classified (+|amount| income). Existing rows default to false.
ALTER TABLE "Transaction" ADD COLUMN "isRefund" BOOLEAN NOT NULL DEFAULT false;

-- The flag is only meaningful on negative raw amounts: positive refunds are
-- already handled by sign (they reduce expenses), and keeping it negative-only
-- keeps the classification linear for grouped sums.
ALTER TABLE "Transaction"
  ADD CONSTRAINT "Transaction_isRefund_negative_check"
  CHECK (NOT "isRefund" OR "chargedAmount" < 0);
