-- Safety class: READ-ONLY. Card #49 acceptance audit (ADR-0025).
--
--   psql -X -v ON_ERROR_STOP=1 -d <database> -f scripts/audit-pending-currency.sql
--
-- Runs inside a READ ONLY transaction that is rolled back, so it cannot write
-- even by mistake. Works before and after migration
-- 20261103120000_transaction_provider_status (providerStatus /
-- pendingRetiredAt are read through to_jsonb, so a missing column is NULL).
-- The horizon (14 Israeli calendar days) mirrors
-- DEFAULT_PENDING_HORIZON_DAYS in src/lib/services/pendingRetirement.ts.

BEGIN TRANSACTION READ ONLY;

\echo '== 1. Currency values (acceptance: only ISO-4217 codes) =='
SELECT 'chargedCurrency' AS field, "chargedCurrency" AS value, count(*) AS n,
       ("chargedCurrency" ~ '^[A-Z]{3}$') AS is_iso
FROM "Transaction" GROUP BY 2
UNION ALL
SELECT 'originalCurrency', "originalCurrency", count(*),
       ("originalCurrency" ~ '^[A-Z]{3}$')
FROM "Transaction" GROUP BY 2
ORDER BY field, n DESC;

\echo '== 1b. Non-ISO currency rows (acceptance: 0) =='
SELECT count(*) AS non_iso_rows
FROM "Transaction"
WHERE "chargedCurrency" !~ '^[A-Z]{3}$'
   OR ("originalCurrency" IS NOT NULL AND "originalCurrency" !~ '^[A-Z]{3}$');

\echo '== 2. Suspected foreign charges stored as ILS (no chargedCurrency from the provider; non-Isracard) =='
-- Same absolute amount in both fields and a foreign originalCurrency: the
-- pre-#49 ingestion labelled the purchase-currency amount as shekels.
SELECT a.provider, t."originalCurrency", count(*) AS n,
       round(sum(t."chargedAmount")::numeric, 2) AS charged_sum,
       count(*) FILTER (WHERE NOT t."isCardSettlement") AS visible
FROM "Transaction" t JOIN "Account" a ON a.id = t."accountId"
WHERE a.provider <> 'isracard'
  AND t."chargedCurrency" = 'ILS'
  AND t."originalCurrency" IS NOT NULL AND t."originalCurrency" <> 'ILS'
  AND t."originalAmount" IS NOT NULL
  AND abs(abs(t."chargedAmount") - abs(t."originalAmount")) < 0.005
  AND t."chargedAmount" <> 0
GROUP BY 1, 2 ORDER BY n DESC;

\echo '== 3. Visible pending card rows older than the 14-day horizon (acceptance: 0 after the first post-#49 sync) =='
-- Pending = persisted providerStatus 'pending', or a legacy Cal row without
-- an identifier (same rule as isProviderPending). A row the provider still
-- returns as pending is legitimately kept, so a small residue here is expected;
-- rows listed in 3b that are weeks old and absent at the provider are the bug.
WITH pending AS (
  SELECT t.*, a.provider,
         to_jsonb(t) ->> 'providerStatus' AS provider_status,
         ((t.date AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Jerusalem')::date AS local_day
  FROM "Transaction" t JOIN "Account" a ON a.id = t."accountId"
  WHERE a.kind = 'CARD' AND NOT t."isCardSettlement" AND NOT t."isTransfer"
)
SELECT provider, count(*) AS visible_stale_pending,
       round(sum("chargedAmount")::numeric, 2) AS charged_sum,
       min(local_day) AS oldest, max(local_day) AS newest
FROM pending
WHERE (provider_status = 'pending'
       OR (provider_status IS NULL AND provider = 'visaCal' AND "txnIdentifier" IS NULL))
  AND local_day < (now() AT TIME ZONE 'Asia/Jerusalem')::date - 14
GROUP BY provider ORDER BY provider;

\echo '== 3b. The 30 newest such rows (no descriptions beyond 40 chars) =='
WITH pending AS (
  SELECT t.id, a.provider, t."chargedAmount", t."chargedCurrency",
         left(t.description, 40) AS description,
         to_jsonb(t) ->> 'providerStatus' AS provider_status, t."txnIdentifier",
         ((t.date AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Jerusalem')::date AS local_day
  FROM "Transaction" t JOIN "Account" a ON a.id = t."accountId"
  WHERE a.kind = 'CARD' AND NOT t."isCardSettlement" AND NOT t."isTransfer"
)
SELECT local_day, provider, "chargedAmount", "chargedCurrency", description, provider_status
FROM pending
WHERE (provider_status = 'pending'
       OR (provider_status IS NULL AND provider = 'visaCal' AND "txnIdentifier" IS NULL))
  AND local_day < (now() AT TIME ZONE 'Asia/Jerusalem')::date - 14
ORDER BY local_day DESC LIMIT 30;

\echo '== 4. Rows retired by pending retirement so far (pendingRetiredAt set) =='
SELECT a.provider, count(*) AS retired,
       round(sum(t."chargedAmount")::numeric, 2) AS charged_sum,
       max((to_jsonb(t) ->> 'pendingRetiredAt')) AS last_retired_at
FROM "Transaction" t JOIN "Account" a ON a.id = t."accountId"
WHERE to_jsonb(t) ->> 'pendingRetiredAt' IS NOT NULL
GROUP BY 1 ORDER BY 1;

\echo '== 5. providerStatus coverage (NULL = ingested before card #49) =='
SELECT a.provider, coalesce(to_jsonb(t) ->> 'providerStatus', '(null)') AS provider_status, count(*) AS n
FROM "Transaction" t JOIN "Account" a ON a.id = t."accountId"
GROUP BY 1, 2 ORDER BY 1, 2;

ROLLBACK;
