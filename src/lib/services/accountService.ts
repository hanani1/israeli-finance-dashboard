/**
 * Account balance service. Balances are the *current amount in the bank* (a
 * point-in-time figure from the last scrape) — deliberately separate from the
 * period income/expenses/net analytics. Only BANK-kind accounts participate:
 * a card provider's "balance" is upcoming charges, not money the household
 * holds, so card accounts are excluded from the current-balance card.
 */
import { AccountKind } from '@prisma/client';
import { prisma } from '@/lib/db';
import { moneyToNumber, sumMoney } from '@/lib/services/money';

export interface AccountBalance {
  id: string;
  displayName: string;
  provider: string;
  userName: string;
  balance: number;
  currency: string;
  updatedAt: Date;
}

export interface AccountBalancesResult {
  accounts: AccountBalance[];
  /** Sum of balances (naive across currencies; ILS-only in practice today). */
  total: number;
  currency: string;
}

export async function listAccountBalances(options: {
  userId?: string;
}): Promise<AccountBalancesResult> {
  const accounts = await prisma.account.findMany({
    where: {
      kind: AccountKind.BANK,
      ...(options.userId ? { userId: options.userId } : {}),
    },
    include: { user: { select: { name: true } } },
    orderBy: { balance: 'desc' },
  });

  const mapped: AccountBalance[] = accounts.map((a) => ({
    id: a.id,
    displayName: a.displayName,
    provider: a.provider,
    userName: a.user.name,
    balance: moneyToNumber(a.balance),
    currency: a.currency,
    updatedAt: a.updatedAt,
  }));

  const total = moneyToNumber(sumMoney(accounts.map((a) => a.balance)));
  const currency = mapped[0]?.currency ?? 'ILS';
  return { accounts: mapped, total, currency };
}
