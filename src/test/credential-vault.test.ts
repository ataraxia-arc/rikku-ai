import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptBitgetCredentials, encryptBitgetCredentials, fingerprintApiKey } from "@/lib/security/credential-vault";

describe("credential vault", () => {
  it("round-trips credentials through envelope encryption", () => {
    const key = randomBytes(32);
    const credentials = { apiKey: "public-key-value", apiSecret: "secret-value", passphrase: "passphrase" };
    const encrypted = encryptBitgetCredentials(credentials, key);

    expect(encrypted.credentialCiphertext).not.toContain(credentials.apiSecret);
    expect(encrypted.wrappedDataKey).not.toContain(credentials.apiSecret);
    expect(decryptBitgetCredentials(encrypted, key)).toEqual(credentials);
  });

  it("uses a non-reversible API-key fingerprint", () => {
    expect(fingerprintApiKey("example-api-key")).toMatch(/^[a-f0-9]{24}$/);
    expect(fingerprintApiKey("example-api-key")).not.toContain("example-api-key");
  });
});
