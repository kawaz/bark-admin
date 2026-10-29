import * as v from "valibot";

// 登録の要求を送ってきた端末の IP を決める。前段の proxy (caddy-app-proxy の Caddy、loopback から来る) が付ける X-Forwarded-For は、
// 接続元がその proxy (loopback か BARK_ADMIN_TRUSTED_PROXIES の CIDR) の時だけ信頼し、末尾 (= proxy が見た接続元) を使う。
// それ以外の接続元から来た X-Forwarded-For は誰でも書けるので無視し、接続元の IP をそのまま使う

export type Cidr = { family: 4 | 6; bits: bigint; prefix: number };

const IpSchema = v.pipe(v.string(), v.ip());

// IPv4 射影アドレス (::ffff:127.0.0.1) は IPv4 として扱う (デュアルスタックの listen で接続元がこの形になる)
function unmap(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m?.[1] ?? ip;
}

function v4bits(ip: string): bigint | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = (n << 8n) | BigInt(p);
  }
  return n;
}

function v6bits(ip: string): bigint | null {
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" || halves[0] === undefined ? [] : halves[0].split(":");
  const tail = halves.length === 2 && halves[1] !== undefined && halves[1] !== "" ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array.from({ length: fill }, () => "0"), ...tail];
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    n = (n << 16n) | BigInt(Number.parseInt(g, 16));
  }
  return n;
}

function parseIp(raw: string): { family: 4 | 6; bits: bigint } | null {
  const ip = unmap(raw);
  const b4 = v4bits(ip);
  if (b4 !== null) return { family: 4, bits: b4 };
  const b6 = v6bits(ip);
  return b6 === null ? null : { family: 6, bits: b6 };
}

// "10.0.0.0/8" / "fd7a::/48" / 単独の IP (= /32, /128)。読めなければ null
export function parseCidr(raw: string): Cidr | null {
  const [addr, len, ...rest] = raw.trim().split("/");
  if (addr === undefined || rest.length > 0) return null;
  const ip = parseIp(addr);
  if (ip === null) return null;
  const max = ip.family === 4 ? 32 : 128;
  const prefix = len === undefined ? max : Number(len);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  return { family: ip.family, bits: ip.bits, prefix };
}

export const LOOPBACK: Cidr[] = [
  { family: 4, bits: 127n << 24n, prefix: 8 },
  { family: 6, bits: 1n, prefix: 128 },
];

export function inCidr(raw: string, cidr: Cidr): boolean {
  const ip = parseIp(raw);
  if (ip === null || ip.family !== cidr.family) return false;
  const shift = BigInt((ip.family === 4 ? 32 : 128) - cidr.prefix);
  return ip.bits >> shift === cidr.bits >> shift;
}

// BARK_ADMIN_TRUSTED_PROXIES (CIDR のカンマ区切り)。loopback は常に信頼する。読めない要素は起動を止める
export function trustedProxies(env: string | undefined): Cidr[] {
  const extra = (env ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .map((s) => {
      const c = parseCidr(s);
      if (c === null) throw new Error(`BARK_ADMIN_TRUSTED_PROXIES: "${s}" is not a CIDR (e.g. 10.0.0.0/8, fd7a::/48)`);
      return c;
    });
  return [...LOOPBACK, ...extra];
}

// 接続元 (remote) が信頼する proxy なら X-Forwarded-For の末尾を、そうでなければ接続元を返す。IP の形でなければ undefined
export function clientIp(remote: string | undefined, xff: string | null, trusted: Cidr[]): string | undefined {
  const from = remote === undefined ? undefined : unmap(remote);
  if (from !== undefined && trusted.some((c) => inCidr(from, c))) {
    const last = xff?.split(",").at(-1)?.trim();
    if (last !== undefined && v.is(IpSchema, last)) return unmap(last);
  }
  return from !== undefined && v.is(IpSchema, from) ? from : undefined;
}
