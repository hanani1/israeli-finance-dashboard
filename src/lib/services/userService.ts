/**
 * Household member (User) service layer.
 *
 * The schema requires a unique email per user; the UI only asks for a name,
 * so a stable local placeholder email is generated when none is provided.
 */
import crypto from 'node:crypto';
import { prisma } from '@/lib/db';
import { RequestError } from '@/lib/services/requestError';

export interface HouseholdMember {
  id: string;
  name: string;
  email: string;
}

function generateLocalEmail(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'member';
  return `${slug}-${crypto.randomBytes(3).toString('hex')}@household.local`;
}

export async function createUser(name: string, email?: string): Promise<HouseholdMember> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new RequestError(400, 'Name must not be empty.');
  }
  return prisma.user.create({
    data: { name: trimmed, email: email?.trim() || generateLocalEmail(trimmed) },
    select: { id: true, name: true, email: true },
  });
}

export async function renameUser(id: string, name: string): Promise<HouseholdMember> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new RequestError(400, 'Name must not be empty.');
  }
  return prisma.user.update({
    where: { id },
    data: { name: trimmed },
    select: { id: true, name: true, email: true },
  });
}

/**
 * Delete a household member. Refuses when the member still owns bank
 * connections or accounts — those carry transaction history and must be
 * removed deliberately first.
 */
export async function deleteUser(id: string): Promise<void> {
  const [credentialCount, accountCount] = await Promise.all([
    prisma.bankCredential.count({ where: { userId: id } }),
    prisma.account.count({ where: { userId: id } }),
  ]);
  if (credentialCount > 0 || accountCount > 0) {
    throw new RequestError(
      409,
      'This member still has bank connections or accounts. Remove their bank connections first.',
    );
  }
  await prisma.user.delete({ where: { id } });
}
