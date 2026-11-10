/**
 * Bank credential service layer.
 *
 * Login fields are serialized to JSON and encrypted with AES-256-GCM before
 * they touch the database. Plaintext secrets are never returned to callers —
 * list operations expose metadata only.
 */
import { prisma } from '@/lib/db';
import { encryptSecret } from '@/lib/security/crypto';
import { prepareLoginFields } from '@/lib/services/providerCredentials';

export interface CredentialInput {
  userId: string;
  provider: string;
  /** Provider login fields, e.g. { username, password } or { id, card6Digits, password }. */
  loginFields: Record<string, string>;
}

export interface CredentialMetadata {
  id: string;
  userId: string;
  userName: string;
  provider: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredCredentialSnapshot {
  id: string;
  userId: string;
  provider: string;
  encryptedData: string;
  iv: string;
  authTag: string;
  initialSyncCompletedAt: Date | null;
}

/** Create or replace the credential for (userId, provider). */
export async function upsertCredential(input: CredentialInput): Promise<CredentialMetadata> {
  const fields = prepareLoginFields(input.provider, input.loginFields);

  const payload = encryptSecret(JSON.stringify(fields));

  const credential = await prisma.bankCredential.upsert({
    where: { userId_provider: { userId: input.userId, provider: input.provider } },
    update: {
      encryptedData: payload.ciphertext,
      iv: payload.iv,
      authTag: payload.tag,
      // Treat replaced login details as a fresh connection. A failed automatic
      // scrape leaves this null so the next sync retries the full import.
      initialSyncCompletedAt: null,
    },
    create: {
      userId: input.userId,
      provider: input.provider,
      encryptedData: payload.ciphertext,
      iv: payload.iv,
      authTag: payload.tag,
    },
    include: { user: { select: { name: true } } },
  });

  return toMetadata(credential);
}

export async function getStoredCredentialSnapshot(
  userId: string,
  provider: string,
): Promise<StoredCredentialSnapshot | null> {
  return prisma.bankCredential.findUnique({
    where: { userId_provider: { userId, provider } },
    select: {
      id: true,
      userId: true,
      provider: true,
      encryptedData: true,
      iv: true,
      authTag: true,
      initialSyncCompletedAt: true,
    },
  });
}

export async function restoreCredential(snapshot: StoredCredentialSnapshot): Promise<void> {
  await prisma.bankCredential.update({
    where: { id: snapshot.id },
    data: {
      encryptedData: snapshot.encryptedData,
      iv: snapshot.iv,
      authTag: snapshot.authTag,
      initialSyncCompletedAt: snapshot.initialSyncCompletedAt,
    },
  });
}

export async function listCredentials(): Promise<CredentialMetadata[]> {
  const credentials = await prisma.bankCredential.findMany({
    include: { user: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return credentials.map(toMetadata);
}

export async function deleteCredential(id: string): Promise<void> {
  await prisma.bankCredential.delete({ where: { id } });
}

function toMetadata(credential: {
  id: string;
  userId: string;
  provider: string;
  createdAt: Date;
  updatedAt: Date;
  user: { name: string };
}): CredentialMetadata {
  return {
    id: credential.id,
    userId: credential.userId,
    userName: credential.user.name,
    provider: credential.provider,
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt,
  };
}
