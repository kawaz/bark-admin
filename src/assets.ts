import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 管理 UI の静的ファイルの用意と配信。起動時に src/client/ の各ページの TS を Bun.build で 1 本ずつ bundle し (部品・型・スキーマはサーバと同じ src/ui/ と src/schema/ を使う)、
// src/ui/style.css と合わせてメモリに持つ。内容の hash を版として URL と ETag に使う。
// 古い JS / CSS がブラウザに残って HTML と版がずれないよう:
// - HTML の中の asset 参照に `?v=<hash 先頭 8>` を付ける (HTML が新しければ必ず新しい asset を取る)。bundle は import を持たない 1 本なので、JS の中の参照は無い
// - 応答は `Cache-Control: no-cache` + ETag (毎回検証し、変わっていなければ 304)

export const ASSET_PREFIX = "/bark-admin/assets/";

const SRC_DIR = import.meta.dir;
// 配る JS (ページごとの入口)。名前は `<入口のファイル名>.js`
const ENTRIES = ["index", "device", "add"].map((name) => join(SRC_DIR, "client", `${name}.ts`));

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

type Built = { body: string; etag: string; contentType: string };

function built(body: string, contentType: string): Built {
  return { body, etag: `"${sha256(body).slice(0, 16)}"`, contentType };
}

async function bundle(): Promise<Map<string, string>> {
  const r = await Bun.build({ entrypoints: ENTRIES, target: "browser", format: "esm" });
  if (!r.success) throw new AggregateError(r.logs, "bark-admin: failed to bundle the UI scripts (src/client/)");
  return new Map(await Promise.all(r.outputs.map(async (o) => [o.path.replace(/^.*\//, ""), await o.text()] as const)));
}

const assets = new Map<string, Built>([
  ["style.css", built(readFileSync(join(SRC_DIR, "ui", "style.css"), "utf8"), "text/css; charset=utf-8")],
  ...[...(await bundle())].map(([name, text]): [string, Built] => [name, built(text, "text/javascript; charset=utf-8")]),
]);

// HTML から参照する asset の URL (版つき)。無い名前は版なし
export function assetUrl(name: string): string {
  const b = assets.get(name);
  return b === undefined ? `${ASSET_PREFIX}${name}` : `${ASSET_PREFIX}${name}?v=${b.etag.slice(1, 9)}`;
}

function respond(req: Request, b: Built): Response {
  const headers = { "content-type": b.contentType, "cache-control": "no-cache", etag: b.etag };
  if (req.headers.get("if-none-match") === b.etag) return new Response(null, { status: 304, headers });
  return new Response(b.body, { headers });
}

// 起動時に組んだ HTML (TOP と詳細の枠) を版つき・ETag つきで配る
export function htmlRoute(body: string): (req: Request) => Response {
  const b = built(body, "text/html; charset=utf-8");
  return (req) => respond(req, b);
}

// /bark-admin/assets/<name> の route (名前ごと)
export function assetRoutes(): Record<string, (req: Request) => Response> {
  return Object.fromEntries([...assets].map(([name, b]) => [`${ASSET_PREFIX}${name}`, (req: Request) => respond(req, b)]));
}
