import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM standard nonce size

let cachedKey = null;

// ENV_VAR_ENCRYPTION_KEY never changes for the life of the process — decode it
// once instead of re-deriving on every encrypt/decrypt call.
function getKey() {
  if (cachedKey) return cachedKey;
  const key = Buffer.from(process.env.ENV_VAR_ENCRYPTION_KEY, "base64");
  if (key.length !== 32) {
    throw new Error("ENV_VAR_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  cachedKey = key;
  return cachedKey;
}

// Blob format: "<iv-b64>:<authTag-b64>:<ciphertext-b64>". One choke point for
// EnvVar.value encryption — nothing else in this codebase touches crypto
// directly, so key rotation later only ever means touching this file.
export function encryptSecret(plaintext) {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((b) => b.toString("base64")).join(":");
}

export function decryptSecret(blob) {
  const [ivB64, tagB64, ciphertextB64] = blob.split(":");
  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
