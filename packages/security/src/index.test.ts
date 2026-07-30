import { describe, expect, it } from "vitest";

import {
  decryptSecret,
  encryptSecret,
  generateOpaqueToken,
  hashOpaqueToken,
  maskIranianPan,
  panLastFour,
} from "./index.js";

const masterKey = `base64:${Buffer.alloc(32, 7).toString("base64")}`;

describe("authenticated secret encryption", () => {
  it("round-trips with purpose and context binding", () => {
    const encrypted = encryptSecret({
      plaintext: "panel-secret",
      masterKey,
      keyId: "k1",
      purpose: "panel-token",
      context: "panel_42",
    });

    expect(decryptSecret({
      ciphertext: encrypted.ciphertext,
      masterKey,
      purpose: "panel-token",
      context: "panel_42",
      expectedKeyId: "k1",
    })).toBe("panel-secret");
  });

  it("rejects purpose confusion and tampering", () => {
    const encrypted = encryptSecret({ plaintext: "secret", masterKey, purpose: "panel-token" });
    expect(() => decryptSecret({ ciphertext: encrypted.ciphertext, masterKey, purpose: "recipient-pan" })).toThrow(
      "authentication failed",
    );

    const tampered = `${encrypted.ciphertext.slice(0, -1)}A`;
    expect(() => decryptSecret({ ciphertext: tampered, masterKey, purpose: "panel-token" })).toThrow(
      "authentication failed",
    );
  });
});

describe("tokens and PAN handling", () => {
  it("generates and hashes opaque session tokens", () => {
    const token = generateOpaqueToken();
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(hashOpaqueToken(token, masterKey)).toMatch(/^[a-f0-9]{64}$/u);
    expect(hashOpaqueToken(token, masterKey)).toBe(hashOpaqueToken(token, masterKey));
  });

  it("masks Iranian card numbers without retaining the middle digits", () => {
    expect(maskIranianPan("6037-9912-3456-7890")).toBe("603799******7890");
    expect(panLastFour("6037 9912 3456 7890")).toBe("7890");
  });
});
