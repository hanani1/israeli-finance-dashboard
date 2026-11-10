-- Category 39 (תשלומים) is variable spending, not a recurring fixed expense.
-- Keep the stable id because transactions, rules, and budgets reference it.
UPDATE "Category"
SET "group" = 'VARIABLE_EXPENSE'::"CategoryGroup",
    "type" = 'EXPENSE'::"CategoryType"
WHERE "id" = 39;
