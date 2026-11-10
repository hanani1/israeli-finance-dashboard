/**
 * Demo data seed: fills an EMPTY database with six months of synthetic household
 * transactions so the dashboard, monthly view, budgets and analytics can be tried
 * (and verified by an agent) without connecting a real bank.
 *
 * Run after `npm run db:seed` (it needs the default categories and users):
 *   npm run db:seed-demo            # insert demo data (refuses if real data exists)
 *   npm run db:seed-demo -- --reset # remove only the demo rows again
 *
 * Every row it creates has an id starting with `demo-`; no bank credentials are
 * created, so the sync worker never tries to log in anywhere for these accounts.
 * All merchants, amounts and account numbers are fictional.
 */
import { CategoryGroup, Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const PREFIX = 'demo-';
const MONTHS = 6;

// Deterministic PRNG so every run produces the same data set.
let seed = 42;
function rand(): number {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
}
function between(min: number, max: number): number {
  return Math.round((min + rand() * (max - min)) * 100) / 100;
}

interface Template {
  description: string;
  category: string;
  group: CategoryGroup;
  /** Negative = expense, positive = income. */
  min: number;
  max: number;
  /** Occurrences per month. */
  perMonth: number;
  /** Fixed day of month, otherwise random. */
  day?: number;
  account: 'bank' | 'card';
}

const V = CategoryGroup.VARIABLE_EXPENSE;
const R = CategoryGroup.RECURRING_EXPENSE;
const I = CategoryGroup.INCOME;

const TEMPLATES: Template[] = [
  { description: 'משכורת חברה לדוגמה בע"מ', category: 'משכורת', group: I, min: 14500, max: 14500, perMonth: 1, day: 1, account: 'bank' },
  { description: 'משכורת סטודיו דמו', category: 'משכורת', group: I, min: 9200, max: 9800, perMonth: 1, day: 9, account: 'bank' },
  { description: 'ביטוח לאומי קצבת ילדים', category: 'קצבאות', group: I, min: 340, max: 340, perMonth: 1, day: 20, account: 'bank' },
  { description: 'שכר דירה - בעל הבית', category: 'דיור', group: R, min: -5600, max: -5600, perMonth: 1, day: 2, account: 'bank' },
  { description: 'עירייה לדוגמה ארנונה', category: 'ארנונה', group: R, min: -640, max: -640, perMonth: 1, day: 5, account: 'bank' },
  { description: 'ועד הבית', category: 'ועד בית', group: R, min: -150, max: -150, perMonth: 1, day: 5, account: 'bank' },
  { description: 'חברת החשמל', category: 'חשמל', group: R, min: -280, max: -520, perMonth: 1, day: 14, account: 'card' },
  { description: 'סלולר דמו', category: 'תקשורת', group: R, min: -89, max: -89, perMonth: 1, day: 10, account: 'card' },
  { description: 'STREAMING DEMO', category: 'דיגיטל', group: R, min: -45, max: -45, perMonth: 1, day: 12, account: 'card' },
  { description: 'גן ילדים השקד', category: 'חינוך', group: R, min: -1900, max: -1900, perMonth: 1, day: 3, account: 'bank' },
  { description: 'ביטוח רכב דמו', category: 'ביטוח', group: R, min: -210, max: -210, perMonth: 1, day: 15, account: 'card' },
  { description: 'סופר השכונה', category: 'סופר', group: V, min: -120, max: -620, perMonth: 7, account: 'card' },
  { description: 'מרכול דוגמה', category: 'סופר', group: V, min: -60, max: -260, perMonth: 4, account: 'card' },
  { description: 'קפה לדוגמה', category: 'אוכל בחוץ', group: V, min: -28, max: -70, perMonth: 5, account: 'card' },
  { description: 'פיצה דמו', category: 'אוכל בחוץ', group: V, min: -90, max: -180, perMonth: 2, account: 'card' },
  { description: 'תחנת דלק דמו', category: 'רכב', group: V, min: -180, max: -320, perMonth: 3, account: 'card' },
  { description: 'רב-קו טעינה', category: 'תחבורה ציבורית', group: V, min: -50, max: -100, perMonth: 1, account: 'card' },
  { description: 'בית מרקחת דמו', category: 'פארמה', group: V, min: -40, max: -160, perMonth: 2, account: 'card' },
  { description: 'חנות בגדים לדוגמה', category: 'ביגוד והנעלה', group: V, min: -120, max: -450, perMonth: 1, account: 'card' },
  { description: 'חדר כושר דמו', category: 'ספורט', group: V, min: -199, max: -199, perMonth: 1, day: 1, account: 'card' },
  { description: 'משיכת מזומן', category: 'מזומן', group: V, min: -200, max: -400, perMonth: 1, account: 'bank' },
];

const DEMO_BUDGETS: Array<[string, CategoryGroup, number]> = [
  ['סופר', V, 3200],
  ['אוכל בחוץ', V, 600],
  ['רכב', V, 900],
];

function dayInMonth(year: number, month: number, day: number): Date {
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  // 10:00 UTC keeps the row on the same calendar day in Asia/Jerusalem.
  return new Date(Date.UTC(year, month, Math.min(day, last), 10));
}

async function reset(): Promise<void> {
  const txns = await prisma.transaction.deleteMany({ where: { id: { startsWith: PREFIX } } });
  const accounts = await prisma.account.deleteMany({ where: { id: { startsWith: PREFIX } } });
  // Only the exact demo budgets (same category and amount) are removed.
  let budgets = 0;
  for (const [name, group, amount] of DEMO_BUDGETS) {
    const removed = await prisma.budget.deleteMany({ where: { amount, category: { name, group } } });
    budgets += removed.count;
  }
  console.log(`Removed ${txns.count} demo transactions, ${accounts.count} demo accounts and ${budgets} demo budgets.`);
}

async function main(): Promise<void> {
  if (process.argv.includes('--reset')) return reset();

  const realTxns = await prisma.transaction.count({ where: { NOT: { id: { startsWith: PREFIX } } } });
  if (realTxns > 0) {
    console.error(`Refusing to add demo data: the database already has ${realTxns} real transactions.`);
    process.exit(1);
  }

  const user = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } });
  const categories = await prisma.category.findMany();
  if (!user || categories.length === 0) {
    console.error('Run `npm run db:seed` first (default categories and users are required).');
    process.exit(1);
  }
  const categoryId = (name: string, group: CategoryGroup): number => {
    const found = categories.find((c) => c.name === name && c.group === group);
    if (!found) throw new Error(`Seed category missing: ${name} (${group})`);
    return found.id;
  };

  const accounts = {
    bank: { id: `${PREFIX}bank`, provider: 'demo', kind: 'BANK' as const, accountNumber: '000-00000', displayName: 'Demo bank •0000' },
    card: { id: `${PREFIX}card`, provider: 'demo', kind: 'CARD' as const, accountNumber: '9999', displayName: 'Demo card •9999' },
  };
  for (const a of Object.values(accounts)) {
    await prisma.account.upsert({ where: { id: a.id }, update: {}, create: { ...a, userId: user.id } });
  }

  const now = new Date();
  const rows: Prisma.TransactionCreateManyInput[] = [];
  for (let back = MONTHS - 1; back >= 0; back--) {
    const ref = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const [y, m] = [ref.getUTCFullYear(), ref.getUTCMonth()];
    let cardTotal = 0;
    for (const t of TEMPLATES) {
      for (let n = 0; n < t.perMonth; n++) {
        const date = dayInMonth(y, m, t.day ?? 1 + Math.floor(rand() * 28));
        if (date > now) continue;
        const amount = t.min === t.max ? t.min : between(t.min, t.max);
        if (t.account === 'card') cardTotal += amount;
        rows.push({
          id: `${PREFIX}${y}${String(m + 1).padStart(2, '0')}-${rows.length}`,
          accountId: accounts[t.account].id,
          txnIdentifier: `${PREFIX}${rows.length}`,
          date,
          processedDate: date,
          chargedAmount: amount,
          originalAmount: amount,
          description: t.description,
          categoryId: categoryId(t.category, t.group),
          categorizationSource: 'RULE',
        });
      }
    }
    // The monthly card bill on the bank account; flagged as a settlement so it
    // is not double-counted against the itemized card rows.
    const billDate = dayInMonth(y, m + 1, 2);
    if (billDate <= now && cardTotal < 0) {
      rows.push({
        id: `${PREFIX}${y}${String(m + 1).padStart(2, '0')}-bill`,
        accountId: accounts.bank.id,
        txnIdentifier: `${PREFIX}bill-${y}-${m + 1}`,
        date: billDate,
        processedDate: billDate,
        chargedAmount: Math.round(cardTotal * 100) / 100,
        originalAmount: Math.round(cardTotal * 100) / 100,
        description: 'חיוב לכרטיס דמו 9999',
        isCardSettlement: true,
        settlesAccountId: accounts.card.id,
        categorizationSource: 'UNASSIGNED',
      });
    }
  }
  await prisma.transaction.createMany({ data: rows, skipDuplicates: true });

  const bankSum = rows.filter((r) => r.accountId === accounts.bank.id).reduce((s, r) => s + Number(r.chargedAmount), 0);
  await prisma.account.update({ where: { id: accounts.bank.id }, data: { balance: Math.round((12000 + bankSum) * 100) / 100 } });

  for (const [name, group, amount] of DEMO_BUDGETS) {
    const id = categoryId(name, group);
    await prisma.budget.upsert({ where: { categoryId: id }, update: {}, create: { categoryId: id, amount } });
  }
  console.log(`Seeded ${rows.length} demo transactions over ${MONTHS} months, 2 demo accounts and ${DEMO_BUDGETS.length} budgets.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
