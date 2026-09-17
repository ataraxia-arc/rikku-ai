import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { BitgetCredentials } from "@/lib/bitget/types";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

export type EncryptedCredentials = {
  credentialCiphertext: string;
  credentialIv: string;
  credentialAuthTag: string;
  wrappedDataKey: string;
  wrappedDataKeyIv: string;
  keyVersion: 1;
};

function encryptBuffer(plaintext: Buffer, key: Buffer) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

export function parseCredentialEncryptionKey(encoded = process.env.BITGET_CREDENTIAL_ENCRYPTION_KEY) {
  if (!encoded) throw new Error("BITGET_CREDENTIAL_ENCRYPTION_KEY_MISSING");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("BITGET_CREDENTIAL_ENCRYPTION_KEY_INVALID");
  return key;
}

export function encryptBitgetCredentials(
  credentials: BitgetCredentials,
  masterKey = parseCredentialEncryptionKey(),
): EncryptedCredentials {
  const dataKey = randomBytes(32);
  const encryptedCredentials = encryptBuffer(Buffer.from(JSON.stringify(credentials)), dataKey);
  const wrappedKey = encryptBuffer(dataKey, masterKey);

  return {
    credentialCiphertext: encryptedCredentials.ciphertext.toString("base64"),
    credentialIv: encryptedCredentials.iv.toString("base64"),
    credentialAuthTag: encryptedCredentials.authTag.toString("base64"),
    wrappedDataKey: Buffer.concat([wrappedKey.ciphertext, wrappedKey.authTag]).toString("base64"),
    wrappedDataKeyIv: wrappedKey.iv.toString("base64"),
    keyVersion: 1,
  };
}

export function decryptBitgetCredentials(payload: EncryptedCredentials, masterKey: Buffer): BitgetCredentials {
  const wrapped = Buffer.from(payload.wrappedDataKey, "base64");
  const wrappedCiphertext = wrapped.subarray(0, -16);
  const wrappedTag = wrapped.subarray(-16);
  const keyDecipher = createDecipheriv(ALGORITHM, masterKey, Buffer.from(payload.wrappedDataKeyIv, "base64"));
  keyDecipher.setAuthTag(wrappedTag);
  const dataKey = Buffer.concat([keyDecipher.update(wrappedCiphertext), keyDecipher.final()]);

  const decipher = createDecipheriv(ALGORITHM, dataKey, Buffer.from(payload.credentialIv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.credentialAuthTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.credentialCiphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as BitgetCredentials;
}

export function fingerprintApiKey(apiKey: string) {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 24);
}
