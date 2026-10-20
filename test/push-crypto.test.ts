import { describe, expect, test } from "bun:test";
import { CRYPTO_IV_LENGTH, CRYPTO_KEY_LENGTH, encryptForBark, newCryptoIv, newCryptoKey, randomAlnum } from "../src/push-crypto.ts";
import { nodeDecrypt, nodeEncrypt } from "./node-aes-gcm.ts";

describe("random key / iv", () => {
  test("key is 32 and iv is 12 characters of [A-Za-z0-9]", () => {
    for (let i = 0; i < 200; i++) {
      expect(newCryptoKey()).toMatch(/^[A-Za-z0-9]{32}$/);
      expect(newCryptoIv()).toMatch(/^[A-Za-z0-9]{12}$/);
    }
    expect(CRYPTO_KEY_LENGTH).toBe(32);
    expect(CRYPTO_IV_LENGTH).toBe(12);
  });

  test("every character of the alphabet appears (no character is unreachable)", () => {
    const seen = new Set(randomAlnum(20000));
    expect(seen.size).toBe(62);
  });

  test("consecutive keys differ", () => {
    expect(new Set(Array.from({ length: 50 }, newCryptoKey)).size).toBe(50);
  });
});

describe("encryptForBark", () => {
  const key = "0123456789abcdefghijABCDEFGHIJxy";
  const iv = "IV0123456789";
  const plaintext = JSON.stringify({ title: "暗号化", body: "test", sound: "birdsong", badge: 1 });

  test("matches node:crypto aes-256-gcm with the tag appended", async () => {
    expect(await encryptForBark(key, iv, plaintext)).toBe(nodeEncrypt(key, iv, plaintext));
  });

  test("round-trips through node:crypto decryption", async () => {
    expect(nodeDecrypt(key, iv, await encryptForBark(key, iv, plaintext))).toBe(plaintext);
  });

  test("the sealed bytes are plaintext length + 16 byte tag", async () => {
    const sealed = Buffer.from(await encryptForBark(key, iv, plaintext), "base64");
    expect(sealed.length).toBe(Buffer.byteLength(plaintext, "utf8") + 16);
  });
});
