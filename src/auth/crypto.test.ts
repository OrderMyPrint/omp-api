import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  decryptSecret,
  encryptSecret,
  hotp,
  newTotpSecret,
  totp,
  verifyTotp,
} from "./crypto";

describe("TOTP", () => {
  // RFC 6238 Appendix B test vectors (SHA-1, 8 digits) — we check the last 6 digits,
  // which is exactly what a 6-digit TOTP produces from the same HMAC.
  const rfcSecret = Buffer.from("12345678901234567890");
  const vectors: [number, string][] = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];

  it("matches the RFC 6238 SHA-1 test vectors", () => {
    for (const [seconds, expected] of vectors) {
      expect(hotp(rfcSecret, Math.floor(seconds / 30), 8)).toBe(expected);
    }
  });

  it("round-trips base32 and verifies codes within ±1 step only", () => {
    expect(base32Decode(base32Encode(rfcSecret)).equals(rfcSecret)).toBe(true);
    const secret = newTotpSecret();
    const t = 1_800_000_000_000;
    const code = totp(secret, t);
    expect(verifyTotp(secret, code, t)).not.toBeNull();
    expect(verifyTotp(secret, code, t + 30_000)).not.toBeNull();
    expect(verifyTotp(secret, code, t + 90_000)).toBeNull();
    expect(verifyTotp(secret, "12345", t)).toBeNull();
  });
});

describe("secret encryption", () => {
  it("encrypts with AES-256-GCM and detects tampering", () => {
    const sealed = encryptSecret("JBSWY3DPEHPK3PXP");
    expect(sealed).not.toContain("JBSWY3DPEHPK3PXP");
    expect(decryptSecret(sealed)).toBe("JBSWY3DPEHPK3PXP");
    const parts = sealed.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });
});
