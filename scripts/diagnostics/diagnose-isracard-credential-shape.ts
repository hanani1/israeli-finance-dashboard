/**
 * Safety class: SENSITIVE (decrypts the stored credential, prints shape only; READ-ONLY database).
 *
 * Read-only diagnostic. Decrypts the stored Isracard credential locally and
 * prints ONLY shape metadata about each field (length, character classes,
 * whether it satisfies Isracard's published password rule). Values are never
 * printed. Nothing is written to the database.
 *
 * Isracard's login page validates the fixed password client-side with
 *   /^(?=.*[0-9])(?=.*[a-zA-Z])([a-zA-Z0-9]+){8,20}$/
 * (UniValidationModule.regExp.PASSWORD, bundles/generalAngular), but the
 * server accepts ASCII punctuation, so the dashboard rule is 8-20 printable
 * ASCII characters (ISRACARD_PASSWORD_PATTERN).
 */
import { PrismaClient } from '@prisma/client';
import { decryptSecret } from '../../src/lib/security/crypto';
import { ISRACARD_PASSWORD_PATTERN } from '../../src/lib/services/providerCredentials';

try {
  process.loadEnvFile('.env');
} catch {
  // rely on environment / Keychain
}

const prisma = new PrismaClient();

function shape(value: string): Record<string, unknown> {
  return {
    length: value.length,
    hasLetter: /[a-zA-Z]/.test(value),
    hasDigit: /[0-9]/.test(value),
    hasNonAlphanumeric: /[^a-zA-Z0-9]/.test(value),
    hasWhitespace: /\s/.test(value),
    hasNonAscii: /[^\x00-\x7F]/.test(value),
    leadingOrTrailingWhitespace: value !== value.trim(),
  };
}

async function main(): Promise<void> {
  // Column-scoped raw query: works even when the local database has not yet
  // applied the latest Prisma migrations, and never triggers a write.
  const rows = await prisma.$queryRaw<
    Array<{ encryptedData: string; iv: string; authTag: string }>
  >`SELECT "encryptedData", "iv", "authTag" FROM "BankCredential" WHERE provider = 'isracard' LIMIT 1`;
  const credential = rows[0];
  if (!credential) {
    console.log('No isracard credential stored.');
    return;
  }
  const fields = JSON.parse(
    decryptSecret({ ciphertext: credential.encryptedData, iv: credential.iv, tag: credential.authTag }),
  ) as Record<string, string>;

  console.log('field names:', Object.keys(fields).sort());
  for (const [key, value] of Object.entries(fields)) {
    console.log(key, JSON.stringify(shape(value)));
  }
  const password = fields.password ?? '';
  console.log('password matches dashboard rule:', ISRACARD_PASSWORD_PATTERN.test(password));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
