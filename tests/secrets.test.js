import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret } from "../src/crypto/secrets.js";

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a plaintext value", () => {
    const blob = encryptSecret("super-secret-value");
    expect(decryptSecret(blob)).toBe("super-secret-value");
  });

  it("produces a different blob (different IV) for the same plaintext each call", () => {
    const a = encryptSecret("same-value");
    const b = encryptSecret("same-value");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same-value");
    expect(decryptSecret(b)).toBe("same-value");
  });

  it("round-trips an empty string", () => {
    const blob = encryptSecret("");
    expect(decryptSecret(blob)).toBe("");
  });

  it("throws when the ciphertext has been tampered with", () => {
    const blob = encryptSecret("tamper-me");
    const [iv, tag, ciphertext] = blob.split(":");
    const tamperedByte = Buffer.from(ciphertext, "base64");
    tamperedByte[0] ^= 0xff;
    const tampered = [iv, tag, tamperedByte.toString("base64")].join(":");
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("throws when the auth tag has been tampered with", () => {
    const blob = encryptSecret("tamper-me");
    const [iv, tag, ciphertext] = blob.split(":");
    const tamperedTag = Buffer.from(tag, "base64");
    tamperedTag[0] ^= 0xff;
    const tampered = [iv, tamperedTag.toString("base64"), ciphertext].join(":");
    expect(() => decryptSecret(tampered)).toThrow();
  });
});
