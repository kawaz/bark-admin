import * as v from "valibot";
import { parseJsonWith } from "./parse.ts";
import type { Client, DeviceInfo, DeviceKind, Tags } from "./schema/registry.ts";

// 登録の要求から観察できる端末情報 (device.info) と、そこから作る自動タグ。
// 出どころは 3 つ: Bark アプリの /register の User-Agent / Accept-Language、canddy が付ける X-Forwarded-For を tailscale whois で引いた結果、
// 招待ページを開いたブラウザが JS で送った client (登録トークンの client)。

// Bark アプリの UA は Alamofire の既定形: `Bark/1.6.4 (me.fin.bark; build:8; iOS 26.7.1) Alamofire/5.10.2`
const BARK_UA = /^Bark\/(\S+) \(me\.fin\.bark; build:(\S+); ([A-Za-z]+ [0-9][0-9.]*)\)/;

export type BarkUserAgent = Pick<DeviceInfo, "bark_version" | "bark_build" | "os_version">;

// 形が違う UA (Bark 以外・形式変更) からは何も取らない
export function parseBarkUserAgent(ua: string): BarkUserAgent {
  const m = BARK_UA.exec(ua);
  if (m === null || m[1] === undefined || m[2] === undefined || m[3] === undefined) return {};
  return { bark_version: m[1], bark_build: m[2], os_version: m[3] };
}

// Accept-Language (`ja;q=1.0, en;q=0.9`) の先頭の言語の主タグを小文字で (`en-US` → `en`)
export function firstLanguage(acceptLanguage: string): string | undefined {
  const tag = acceptLanguage.split(",")[0]?.split(";")[0]?.trim().split("-")[0]?.toLowerCase();
  return tag === undefined || !/^[a-z]{1,8}$/.test(tag) ? undefined : tag;
}

// `tailscale whois --json <ip>` の出力のうち使う所だけ。OSVersion / DeviceModel 等は null のことがあるので全部 nullable で受ける
const WhoisSchema = v.looseObject({
  Node: v.looseObject({
    Name: v.optional(v.nullable(v.string())),
    ComputedName: v.optional(v.nullable(v.string())),
    Hostinfo: v.optional(
      v.nullable(
        v.looseObject({
          OS: v.optional(v.nullable(v.string())),
          Hostname: v.optional(v.nullable(v.string())),
        }),
      ),
    ),
  }),
  UserProfile: v.optional(v.nullable(v.looseObject({ LoginName: v.optional(v.nullable(v.string())) }))),
});

export type TailnetInfo = Pick<DeviceInfo, "ts_name" | "ts_machine" | "ts_hostname" | "ts_os" | "ts_user" | "ts_ip">;

function present(s: string | null | undefined): string | undefined {
  return s === null || s === undefined || s === "" ? undefined : s;
}

// whois の JSON を info の ts_* にする。読めない JSON は ts_ip だけ
export function whoisToInfo(json: string, ip: string): TailnetInfo {
  const r = parseJsonWith(WhoisSchema, json);
  if (!r.ok) return { ts_ip: ip };
  const { Node, UserProfile } = r.value;
  return {
    ts_name: present(Node.Name)?.replace(/\.$/, ""),
    ts_machine: present(Node.ComputedName),
    ts_hostname: present(Node.Hostinfo?.Hostname),
    ts_os: present(Node.Hostinfo?.OS),
    ts_user: present(UserProfile?.LoginName),
    ts_ip: ip,
  };
}

// whois の実装 (テストでは差し替える)。IP から tailnet の端末情報を引く。引けなければ空
export type Whois = (ip: string) => Promise<TailnetInfo>;

// macOS の Tailscale.app 同梱 CLI。PATH には無い前提で絶対パスで呼ぶ
const TAILSCALE = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

export const tailscaleWhois: Whois = async (ip) => {
  try {
    const proc = Bun.spawn([TAILSCALE, "whois", "--json", ip], { stdout: "pipe", stderr: "ignore", timeout: 2000 });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? whoisToInfo(out, ip) : {};
  } catch (e) {
    // CLI が無い・起動できない時も登録は通す
    if (e instanceof Error) return {};
    throw e;
  }
};

const IpSchema = v.pipe(v.string(), v.ip());

// canddy が付ける X-Forwarded-For の末尾 (= canddy が見た接続元)。IP の形でなければ無し
export function forwardedIp(xff: string | null): string | undefined {
  const last = xff?.split(",").at(-1)?.trim();
  return last !== undefined && v.is(IpSchema, last) ? last : undefined;
}

// 招待ページのブラウザが送った client から端末の種類を決める。よく使われる判定をそのまま:
// iPad の Safari はデスクトップ表示で Macintosh / MacIntel を名乗るので、MacIntel かつタッチ点が 2 以上を iPad とみなす
export function deviceKind(c: Client): DeviceKind | undefined {
  if (c.platform === "MacIntel" && c.max_touch_points > 1) return "ipad";
  if (c.user_agent.includes("iPad")) return "ipad";
  if (c.user_agent.includes("iPhone")) return "iphone";
  if (c.user_agent.includes("Macintosh") && c.max_touch_points <= 1) return "mac";
  if (c.user_agent.includes("Android")) return "android";
  return undefined;
}

const KIND_OS: Record<DeviceKind, string> = { ipad: "ipados", iphone: "ios", mac: "macos", android: "android" };

// 登録の要求 1 回分の観察値。再登録のたびに丸ごと置き換える
export function observeRegistration(p: { headers: Headers; tailnet: TailnetInfo; client: Client | null; now: string }): DeviceInfo {
  const ua = present(p.headers.get("user-agent"));
  const c = p.client;
  return {
    ...(ua === undefined ? {} : parseBarkUserAgent(ua)),
    user_agent: ua,
    lang: present(p.headers.get("accept-language")),
    ...p.tailnet,
    ...(c === null
      ? {}
      : {
          device_kind: deviceKind(c),
          browser_user_agent: present(c.user_agent),
          browser_platform: present(c.platform),
          browser_max_touch_points: String(c.max_touch_points),
          browser_language: present(c.language),
          browser_screen: `${c.screen.w}x${c.screen.h}@${c.screen.dpr}`,
        }),
    last_register_at: p.now,
  };
}

// info から作るタグ。owner は人が決めるものなので作らない。
// name は Tailscale のマシン名 (ts_machine)。Hostinfo.Hostname は iPadOS が localhost を返すので使わない。
// os は招待ページで判定した端末の種類を優先する (Bark の UA も Tailscale も iPad を iOS と報告する)
export function autoTags(info: DeviceInfo): Tags {
  const tags: Tags = {};
  const name = info.ts_machine?.toLowerCase();
  const os = info.device_kind === undefined ? (info.ts_os ?? info.os_version?.split(" ")[0])?.toLowerCase() : KIND_OS[info.device_kind];
  const lang = info.lang === undefined ? undefined : firstLanguage(info.lang);
  if (name !== undefined) tags["name"] = name;
  if (os !== undefined) tags["os"] = os;
  if (lang !== undefined) tags["lang"] = lang;
  if (info.ts_user !== undefined) tags["ts_user"] = info.ts_user;
  return tags;
}
