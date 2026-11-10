/**
 * Database seed script.
 *
 * Idempotent: categories are upserted by unique (name, group), users by email.
 * Run with: npm run db:seed
 *
 * Categories follow the RiseUp-style Hebrew taxonomy, split into three groups:
 * variable expenses, recurring/fixed expenses, and income. Some names repeat
 * across groups (e.g. ספורט is variable + recurring; דיור is a recurring expense
 * and an income line) — hence the (name, group) uniqueness.
 */
import { CategoryGroup, CategoryType, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface SeedCategory {
  name: string;
  color: string;
  group: CategoryGroup;
}

const VARIABLE_EXPENSES: Array<[string, string]> = [
  ['סופר', '#16a34a'],
  ['אוכל בחוץ', '#f97316'],
  ['רכב', '#eab308'],
  ['פארמה', '#ef4444'],
  ['תחבורה ציבורית', '#0ea5e9'],
  ['ביגוד והנעלה', '#ec4899'],
  ['ריהוט ובית', '#a855f7'],
  ['טיפולים', '#14b8a6'],
  ['בייביסיטר', '#f472b6'],
  ['ספורט', '#22c55e'],
  ['תרומה', '#e11d48'],
  ['מזומן', '#78716c'],
];

const RECURRING_EXPENSES: Array<[string, string]> = [
  ['דיור', '#2563eb'],
  ['משכנתא', '#1d4ed8'],
  ['ארנונה', '#0891b2'],
  ['ועד בית', '#0d9488'],
  ['חשמל', '#0284c7'],
  ['תקשורת', '#6366f1'],
  ['דיגיטל', '#8b5cf6'],
  ['ביטוח', '#64748b'],
  ['בריאות', '#dc2626'],
  ['חינוך', '#d97706'],
  ['חוגים', '#7c3aed'],
  ['חוגים וצהרון', '#9333ea'],
  ['הלוואה', '#b45309'],
  ['עמלות', '#94a3b8'],
  ['כללי', '#6b7280'],
  ['ספורט', '#15803d'],
  ['RiseUp', '#4f46e5'],
];

const INCOMES: Array<[string, string]> = [
  ['משכורת', '#10b981'],
  ['קצבאות', '#059669'],
  ['דיור', '#34d399'],
  ['זיכויים', '#84cc16'],
  ['העברות', '#6366f1'],
];

function build(list: Array<[string, string]>, group: CategoryGroup): SeedCategory[] {
  return list.map(([name, color]) => ({ name, color, group }));
}

const DEFAULT_CATEGORIES: SeedCategory[] = [
  ...build(VARIABLE_EXPENSES, CategoryGroup.VARIABLE_EXPENSE),
  ...build(RECURRING_EXPENSES, CategoryGroup.RECURRING_EXPENSE),
  ...build(INCOMES, CategoryGroup.INCOME),
];

const DEFAULT_USERS = [
  { name: 'User 1', email: 'user1@household.local' },
  { name: 'User 2', email: 'user2@household.local' },
];

const PAYMENTS_CATEGORY = {
  id: 39,
  name: 'תשלומים',
  color: '#475569',
  group: CategoryGroup.VARIABLE_EXPENSE,
  type: CategoryType.EXPENSE,
} as const;

function typeForGroup(group: CategoryGroup): CategoryType {
  return group === CategoryGroup.INCOME ? CategoryType.INCOME : CategoryType.EXPENSE;
}

async function main(): Promise<void> {
  // This id is referenced by imported transactions and must remain stable.
  // Upserting by id also repairs an older seed that placed it in recurring.
  await prisma.category.upsert({
    where: { id: PAYMENTS_CATEGORY.id },
    update: {
      name: PAYMENTS_CATEGORY.name,
      color: PAYMENTS_CATEGORY.color,
      group: PAYMENTS_CATEGORY.group,
      type: PAYMENTS_CATEGORY.type,
    },
    create: PAYMENTS_CATEGORY,
  });

  for (const category of DEFAULT_CATEGORIES) {
    const type = typeForGroup(category.group);
    await prisma.category.upsert({
      where: { name_group: { name: category.name, group: category.group } },
      update: { color: category.color, type },
      create: { name: category.name, color: category.color, group: category.group, type },
    });
  }
  console.log(`Seeded ${DEFAULT_CATEGORIES.length + 1} categories.`);

  // Explicit ids do not advance PostgreSQL sequences. Keep future category
  // inserts safely above id 39 on a brand-new database.
  await prisma.$queryRaw`
    SELECT setval(
      pg_get_serial_sequence('"Category"', 'id'),
      (SELECT MAX("id") FROM "Category")
    )
  `;

  for (const user of DEFAULT_USERS) {
    await prisma.user.upsert({ where: { email: user.email }, update: {}, create: user });
  }
  console.log(`Seeded ${DEFAULT_USERS.length} household users.`);
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
