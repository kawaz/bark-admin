import { createCipheriv, createDecipheriv } from "node:crypto";

// テストでの突き合わせ用。Bark アプリ (CryptoSwift の GCM combined) と同じ組み立てを node:crypto で書いたもの:
// 鍵・IV は文字列の UTF-8 バイト列、ciphertext = base64(暗号文 ‖ 16 byte の tag)

export function nodeEncrypt(key: string, iv: string, plaintext: string): string {
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "utf8"), Buffer.from(iv, "utf8"));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64");
}

export function nodeDecrypt(key: string, iv: string, ciphertext: string): string {
  const combined = Buffer.from(ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "utf8"), Buffer.from(iv, "utf8"));
  decipher.setAuthTag(combined.subarray(combined.length - 16));
  return Buffer.concat([decipher.update(combined.subarray(0, combined.length - 16)), decipher.final()]).toString("utf8");
}
