/**
 * Credential encryption.
 *
 * AES-256-GCM. Key is 32 bytes, stored at `~/.mnemos/encryption.key` (chmod 600).
 * Each credential is encrypted with a fresh 12-byte IV; ciphertext is stored as
 * `iv.hex:authTag.hex:ciphertext.hex` so storage stays printable.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm" as const;
const KEY_BYTES = 32;
const IV_BYTES = 12;

export function generateEncryptionKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function encryptString(plaintext: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`Encryption key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv) as CipherGCM;
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptString(encoded: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`Encryption key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
  const parts = encoded.split(":");
  if (parts.length !== 3) {
    throw new Error(`Invalid encrypted format. Expected iv:tag:ciphertext.`);
  }
  const [ivHex, tagHex, ctHex] = parts as [string, string, string];
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(tagHex, "hex");
  const ciphertext = Buffer.from(ctHex, "hex");

  const decipher = createDecipheriv(ALGORITHM, key, iv) as DecipherGCM;
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    "utf8",
  );
}
