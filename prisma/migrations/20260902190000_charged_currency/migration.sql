-- Multi-currency settlement tracking:
-- chargedAmount is the settlement amount; chargedCurrency records which
-- currency it settled in. Existing rows default to ILS (the settlement
-- currency for Israeli bank/card scrapes); re-ingestion updates any
-- foreign-settled rows with the scraper-provided value.

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "chargedCurrency" TEXT NOT NULL DEFAULT 'ILS';
