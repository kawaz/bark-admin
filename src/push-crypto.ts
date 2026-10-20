// Bark アプリの「推送加密 / Push Encryption」に合わせた暗号化。仕様は Bark の Model/Algorithm.swift (AESCryptoModel) と
// NotificationServiceExtension/Processor/CiphertextProcessor.swift で確認した:
// - AES-256-GCM 固定 (アプリ側の設定は AES256 / GCM / noPadding)
// - 鍵は 32 文字の文字列の UTF-8 バイト列をそのまま使う。IV も 12 文字の文字列の UTF-8 バイト列
// - ciphertext = base64(暗号文 ‖ 16 byte の auth tag) (CryptoSwift の GCM combined)、AAD なし
// - 平文は bark パラメータ全体の JSON。アプリは復号した JSON を通常の通知パラメータとして扱う

export const CRYPTO_KEY_LENGTH = 32;
export const CRYPTO_IV_LENGTH = 12;

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
// 62 の倍数のうち 256 以下で最大の値。これ以上のバイトを捨てると各文字が等確率になる
const REJECT_FROM = 256 - (256 % ALNUM.length);

// [A-Za-z0-9] を CSPRNG から modulo bias なしで length 文字取り出す (rejection sampling)
export function randomAlnum(length: number): string {
  let out = "";
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b >= REJECT_FROM) continue;
      out += ALNUM.charAt(b % ALNUM.length);
      if (out.length === length) break;
    }
  }
  return out;
}

export function newCryptoKey(): string {
  return randomAlnum(CRYPTO_KEY_LENGTH);
}

export function newCryptoIv(): string {
  return randomAlnum(CRYPTO_IV_LENGTH);
}

// plaintext を key / iv で暗号化し、Bark アプリが復号できる ciphertext (base64) を返す
export async function encryptForBark(key: string, iv: string, plaintext: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey("raw", enc.encode(key), { name: "AES-GCM" }, false, ["encrypt"]);
  // WebCrypto の AES-GCM は暗号文の末尾に tag を付けて返す (= Bark の combined と同じ並び)
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv: enc.encode(iv), tagLength: 128 }, cryptoKey, enc.encode(plaintext));
  return Buffer.from(sealed).toString("base64");
}
