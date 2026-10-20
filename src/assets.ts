import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

// 管理 UI の静的ファイル (public/) の配信。起動時に全部読み、内容の hash を版として URL と ETag に使う。
// 古い JS / CSS がブラウザに残って HTML と版がずれないよう:
// - HTML と JS の中の asset 参照 (`/bark-admin/assets/<name>`、JS の `from "./<name>"`) に `?v=<hash 先頭 8>` を付ける (HTML が新しければ必ず新しい asset を取る)
// - 応答は `Cache-Control: no-cache` + ETag (毎回検証し、変わっていなければ 304)

export const ASSET_PREFIX = "/bark-admin/assets/";

const PUBLIC_DIR = join(import.meta.dir, "..", "public");
const ASSET_DIR = join(PUBLIC_DIR, "assets");

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
};

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

type Built = { body: string; etag: string; contentType: string };

// asset 名 → 版 (hash 先頭 8)。JS の import 先 (common.js) は import を持たないので、生の内容の hash がそのまま版になる。
// import する側は、版を書き込んだ後の内容で hash を取り直す (import 先が変われば import する側の版も変わる)
const raw = new Map(readdirSync(ASSET_DIR).map((name) => [name, readFileSync(join(ASSET_DIR, name), "utf8")]));
const rawVersion = new Map([...raw].map(([name, text]) => [name, sha256(text).slice(0, 8)]));

function versionImports(text: string): string {
  return text.replace(/(from\s+"\.\/)([^"?]+)(")/g, (m, head: string, name: string, tail: string) => {
    const ver = rawVersion.get(name);
    return ver === undefined ? m : `${head}${name}?v=${ver}${tail}`;
  });
}

const built = new Map<string, Built>(
  [...raw].map(([name, text]) => {
    const body = extname(name) === ".js" ? versionImports(text) : text;
    const hash = sha256(body);
    return [name, { body, etag: `"${hash.slice(0, 16)}"`, contentType: CONTENT_TYPES[extname(name)] ?? "application/octet-stream" }];
  }),
);

// HTML から参照する asset の URL (版つき)。無い名前は版なし
export function assetUrl(name: string): string {
  const b = built.get(name);
  return b === undefined ? `${ASSET_PREFIX}${name}` : `${ASSET_PREFIX}${name}?v=${b.etag.slice(1, 9)}`;
}

// HTML 中の `/bark-admin/assets/<name>` を版つきの URL にする
export function versionHtml(html: string): string {
  return html.replace(/\/bark-admin\/assets\/([A-Za-z0-9._-]+)/g, (_, name: string) => assetUrl(name));
}

function respond(req: Request, b: Built): Response {
  const headers = { "content-type": b.contentType, "cache-control": "no-cache", etag: b.etag };
  if (req.headers.get("if-none-match") === b.etag) return new Response(null, { status: 304, headers });
  return new Response(b.body, { headers });
}

// public/ の HTML (index.html / device.html) を版つきにして配る
export function staticHtml(file: string): (req: Request) => Response {
  const body = versionHtml(readFileSync(join(PUBLIC_DIR, file), "utf8"));
  const b: Built = { body, etag: `"${sha256(body).slice(0, 16)}"`, contentType: CONTENT_TYPES[".html"] ?? "text/html" };
  return (req) => respond(req, b);
}

// /bark-admin/assets/<name> の route (名前ごと)
export function assetRoutes(): Record<string, (req: Request) => Response> {
  return Object.fromEntries([...built].map(([name, b]) => [`${ASSET_PREFIX}${name}`, (req: Request) => respond(req, b)]));
}
