/**
 * Authenticated encryption utilities for bank credentials.
 *
 * Algorithm: AES-256-GCM (authenticated encryption — tampering with the
 * ciphertext, IV or auth tag causes decryption to throw).
 *
 * Key: 32-byte key as a 64-character hex string, resolved at runtime from
 * ENCRYPTION_KEY, ENCRYPTION_KEY_FILE, or the macOS Keychain — see
 * keyLoader.ts. Generate one with: openssl rand -hex 32
 */
import crypto from 'node:crypto';
import { loadEncryptionKeyHex } from './keyLoader';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12; // 96-bit IV, recommended for GCM
const KEY_LENGTH_BYTES = 32;
// Without an explicit length, GCM decipher accepts any 4–16 byte tag, so a
// truncated prefix of the real tag would still verify.
const AUTH_TAG_LENGTH_BYTES = 16;

export interface EncryptedPayload {
  /** Base64-encoded ciphertext. */
  ciphertext: string;
  /** Base64-encoded 96-bit initialization vector. */
  iv: string;
  /** Base64-encoded GCM authentication tag. */
  tag: string;
}

function getEncryptionKey(): Buffer {
  // Resolved from ENCRYPTION_KEY, ENCRYPTION_KEY_FILE, or the macOS Keychain
  // (see keyLoader.ts). Format is validated by the loader.
  const key = Buffer.from(loadEncryptionKeyHex(), 'hex');
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(`Encryption key must decode to exactly ${KEY_LENGTH_BYTES} bytes.`);
  }
  return key;
}

/**
 * Encrypt a plaintext secret with AES-256-GCM.
 * A fresh random IV is generated for every call — never reuse IVs with GCM.
 */
export function encryptSecret(plainText: string): EncryptedPayload {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH_BYTES });

  const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

/**
 * Decrypt an AES-256-GCM payload back to plaintext.
 * Throws if the key is wrong or the payload was tampered with.
 */
export function decryptSecret(payload: EncryptedPayload): string {
  const key = getEncryptionKey();
  const iv = Buffer.from(payload.iv, 'base64');
  const ciphertext = Buffer.from(payload.ciphertext, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH_BYTES });
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
