-- Add a finer category grouping (variable/recurring expense, income) and make
-- category names unique per group (names repeat across groups).

-- CreateEnum
CREATE TYPE "CategoryGroup" AS ENUM ('VARIABLE_EXPENSE', 'RECURRING_EXPENSE', 'INCOME');

-- AlterTable (default lets existing rows get a value; they are retagged by the seed)
ALTER TABLE "Category" ADD COLUMN "group" "CategoryGroup" NOT NULL DEFAULT 'VARIABLE_EXPENSE';

-- Replace the name-only unique with a (name, group) compound unique
DROP INDEX "Category_name_key";
CREATE UNIQUE INDEX "Category_name_group_key" ON "Category"("name", "group");
