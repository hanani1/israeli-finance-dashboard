/**
 * Cross-platform encryption key loading.
 *
 * The key is resolved once (then cached) from the first available source:
 *
 *   1. ENCRYPTION_KEY env var           — works everywhere (current behavior).
 *   2. ENCRYPTION_KEY_FILE env var      — path to a file containing the key.
 *      Use with Docker secrets (/run/secrets/...) or systemd LoadCredential
 *      (set ENCRYPTION_KEY_FILE=%d/encryption_key in the unit file).
 *   3. macOS Keychain (darwin only)     — a generic password item looked up
 *      via the `security` CLI. Store it once with:
 *        security add-generic-password -a "$USER" \
 *          -s finance-dashboard.encryption-key -w "$(openssl rand -hex 32)"
 *
 * If no source yields a key, an error is thrown listing all options.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Keychain service name (the -s argument to `security`). */
export const KEYCHAIN_SERVICE = 'finance-dashboard.encryption-key';

const HEX_KEY_PATTERN = /^[0-9a-fA-F]{64}$/;

let cachedKeyHex: string | undefined;

function validateHexKey(hexKey: string, source: string): string {
  const trimmed = hexKey.trim();
  if (!HEX_KEY_PATTERN.test(trimmed)) {
    throw new Error(
      `Encryption key from ${source} must be a 64-character hex string (32 bytes). ` +
        'Generate one with: openssl rand -hex 32',
    );
  }
  return trimmed;
}

function loadFromKeyFile(filePath: string): string {
  let contents: string;
  try {
    contents = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(
      `Failed to read encryption key file at ENCRYPTION_KEY_FILE=${filePath}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateHexKey(contents, `key file ${filePath}`);
}

function loadFromMacKeychain(): string | undefined {
  try {
    // -w prints only the password; execFileSync (no shell) avoids injection.
    const stdout = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return validateHexKey(stdout, `macOS Keychain item "${KEYCHAIN_SERVICE}"`);
  } catch (error) {
    // Re-throw validation errors — a malformed key in the Keychain is a real
    // configuration problem the user must fix, not a "not found" situation.
    if (error instanceof Error && error.message.includes('64-character hex string')) {
      throw error;
    }
    // Item not found (security exits non-zero) — fall through to next source.
    return undefined;
  }
}

/**
 * Resolve the 64-char hex encryption key from the first available source.
 * The result is cached for the lifetime of the process.
 */
export function loadEncryptionKeyHex(): string {
  if (cachedKeyHex) {
    return cachedKeyHex;
  }

  const fromEnv = process.env.ENCRYPTION_KEY;
  if (fromEnv) {
    cachedKeyHex = validateHexKey(fromEnv, 'ENCRYPTION_KEY environment variable');
    return cachedKeyHex;
  }

  const keyFilePath = process.env.ENCRYPTION_KEY_FILE;
  if (keyFilePath) {
    cachedKeyHex = loadFromKeyFile(keyFilePath);
    return cachedKeyHex;
  }

  if (process.platform === 'darwin') {
    const fromKeychain = loadFromMacKeychain();
    if (fromKeychain) {
      cachedKeyHex = fromKeychain;
      return cachedKeyHex;
    }
  }

  throw new Error(
    'No encryption key configured. Provide one via (in priority order):\n' +
      '  1. ENCRYPTION_KEY env var (64-char hex; openssl rand -hex 32)\n' +
      '  2. ENCRYPTION_KEY_FILE env var pointing to a file containing the key\n' +
      `  3. macOS Keychain: security add-generic-password -a "$USER" -s ${KEYCHAIN_SERVICE} -w "<key>"`,
  );
}
