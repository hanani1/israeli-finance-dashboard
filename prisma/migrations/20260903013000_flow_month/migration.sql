-- Additive: optional RiseUp-style cash-flow month (yyyy-MM) per transaction.
-- NULL means "unknown — fall back to the calendar month of `date`".
ALTER TABLE "Transaction" ADD COLUMN "flowMonth" TEXT;

CREATE INDEX "Transaction_flowMonth_idx" ON "Transaction"("flowMonth");
