-- Money as exact decimals (card #53, ADR-0027).
--
-- The money columns were double precision, so totals were float sums and
-- every call site had to remember to round. They become fixed-point
-- DECIMAL(14,2) (agorot; up to 999,999,999,999.99). originalAmount is the
-- merchant-side amount in the ORIGINAL currency and gets scale 3: ISO 4217
-- currencies such as JOD, KWD, BHD, OMR and TND have three minor-unit digits
-- (fils/baisa/millime), so a Petra or Amman purchase must not be rounded.
--
-- Conversion: float8 -> numeric keeps 15 significant digits, which drops the
-- binary-float noise (0.30000000000000004 -> 0.3); round(..., scale) then
-- pins the value to the column scale. Values that genuinely carried more
-- digits than the scale are counted in a NOTICE first (expected: 0 — see the
-- read-only preflight query in ADR-0027).

DO $$
DECLARE
  n_charged  bigint;
  n_original bigint;
  n_balance  bigint;
  n_budget   bigint;
BEGIN
  SELECT count(*) INTO n_charged FROM "Transaction"
    WHERE "chargedAmount"::numeric <> round("chargedAmount"::numeric, 2);
  SELECT count(*) INTO n_original FROM "Transaction"
    WHERE "originalAmount" IS NOT NULL
      AND "originalAmount"::numeric <> round("originalAmount"::numeric, 3);
  SELECT count(*) INTO n_balance FROM "Account"
    WHERE "balance"::numeric <> round("balance"::numeric, 2);
  SELECT count(*) INTO n_budget FROM "Budget"
    WHERE "amount"::numeric <> round("amount"::numeric, 2);
  RAISE NOTICE 'money_decimal: values rounded beyond float noise: chargedAmount=%, originalAmount=%, balance=%, budget=%',
    n_charged, n_original, n_balance, n_budget;
END $$;

-- The isRefund CHECK ("chargedAmount" < 0) is re-validated by the type change.
ALTER TABLE "Transaction"
  ALTER COLUMN "chargedAmount" TYPE DECIMAL(14,2) USING round("chargedAmount"::numeric, 2),
  ALTER COLUMN "originalAmount" TYPE DECIMAL(14,3) USING round("originalAmount"::numeric, 3);

ALTER TABLE "Account" ALTER COLUMN "balance" DROP DEFAULT;
ALTER TABLE "Account"
  ALTER COLUMN "balance" TYPE DECIMAL(14,2) USING round("balance"::numeric, 2);
ALTER TABLE "Account" ALTER COLUMN "balance" SET DEFAULT 0;

ALTER TABLE "Budget"
  ALTER COLUMN "amount" TYPE DECIMAL(14,2) USING round("amount"::numeric, 2);
