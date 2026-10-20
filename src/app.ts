import { readdirSync } from "node:fs";
import { join } from "node:path";
import QRCode from "qrcode";
import * as v from "valibot";
import { BarkServer, RegisterResponseSchema, UpstreamError, type PushResult } from "./bark-server.ts";
import { addPageHtml, notFoundPageHtml } from "./pages/add.ts";
import { parseJsonWith, parseWith } from "./parse.ts";
import { encryptForBark, newCryptoIv, newCryptoKey } from "./push-crypto.ts";
import { archiveDevice, listItem, patchDevice, resolveTargets, selectDevices, upsertRegistration } from "./registry.ts";
import { pushParamFields, pushParamsSchema, type PushParams } from "./schema/push-params.ts";
import { CreateInviteSchema, PatchDeviceSchema, TagsSchema, type DeviceCrypto, type DeviceRecord, type Tags } from "./schema/registry.ts";
import type { Store } from "./store.ts";
import { localIso } from "./time.ts";

// URL は 2 面に分かれる:
// - root: bark-server 互換面。全 endpoint をそのまま bark-server へ透過する (`/r/<invite>/*` は prefix を剥がして透過)。
//   中身を見るのは /register の応答を登録簿へ写す 1 点だけ
// - /bark-admin/: 管理面 (UI / 管理 API / タグ宛先の送信 API)

export const ADMIN = "/bark-admin";

export type AppDeps = {
  serverUrl: string;
  store: Store;
  bark: BarkServer;
  now?: () => string;
};

const PUBLIC_DIR = join(import.meta.dir, "..", "public");

// /bark-admin/push の body: bark V2 パラメータ (device_key / device_keys を除く) + device (タグ filter)
const AdminPushEnvelopeSchema = v.looseObject({ device: v.optional(TagsSchema) });

// register の要求側の key (使用済み招待での再登録の判定用)。bark-server と同じく key / device_key の両方を見る
const RegisterKeySchema = v.looseObject({ key: v.optional(v.string()), device_key: v.optional(v.string()) });

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

function html(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function upstreamResponse(up: { status: number; contentType: string | null; body: string }): Response {
  return new Response(up.body, { status: up.status, headers: up.contentType === null ? {} : { "content-type": up.contentType } });
}

// bark-server と同じ形のエラー (Bark アプリが message を表示する)
function barkError(status: number, message: string): Response {
  return json(status, { code: status, message, timestamp: Math.floor(Date.now() / 1000) });
}

function inviteUrls(serverUrl: string, invite: string): { add_url: string; addserver_url: string } {
  return {
    add_url: `${serverUrl}${ADMIN}/add/${invite}`,
    addserver_url: `bark://addserver?address=${serverUrl}/r/${invite}`,
  };
}

function newInviteId(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("base64url");
}

function requestedKey(url: URL, contentType: string | null, body: ArrayBuffer): string {
  const fromQuery = url.searchParams.get("key") || url.searchParams.get("device_key");
  if (fromQuery) return fromQuery;
  if (body.byteLength === 0) return "";
  const text = new TextDecoder().decode(body);
  if (contentType?.startsWith("application/json")) {
    const r = parseJsonWith(RegisterKeySchema, text);
    return r.ok ? r.value.key || r.value.device_key || "" : "";
  }
  const form = new URLSearchParams(text);
  return form.get("key") || form.get("device_key") || "";
}

export function createApp(deps: AppDeps) {
  const { store, bark, serverUrl } = deps;
  const now = deps.now ?? (() => localIso());

  async function withUpstream(fn: () => Promise<Response>): Promise<Response> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof UpstreamError) return barkError(502, e.message);
      throw e;
    }
  }

  // ---------- bark-server 互換面 (root) ----------

  // path (bark-server 側のパス) で bark-server へ透過する。/register だけは応答を登録簿へ写す。
  // invite は /r/<invite>/* 経由のときの招待。
  async function passThrough(req: Request, path: string, invite: string | null): Promise<Response> {
    const url = new URL(req.url);
    const contentType = req.headers.get("content-type");
    const body = await req.arrayBuffer();
    const isRegister = path === "/register";

    let inviteTags: Tags = {};
    let inviteCrypto: DeviceCrypto | null = null;
    let inviteUnused = false;
    if (invite !== null) {
      const rec = (await store.invites.read())[invite];
      if (rec === undefined) return barkError(404, "invite not found. Ask for a new invite link");
      if (isRegister) {
        // アプリは起動のたびに追加済みサーバへ同じ URL で再登録してくるので、
        // 使用済みの招待でも、使った本人 (used_by) の key での再登録は通す
        if (rec.used_by !== null && requestedKey(url, contentType, body) !== rec.used_by) {
          return barkError(410, "invite already used. Ask for a new invite link");
        }
        inviteTags = rec.tags;
        inviteCrypto = rec.crypto;
        inviteUnused = rec.used_by === null;
      }
    }

    return withUpstream(async () => {
      const up = await bark.forward(req.method, `${path}${url.search}`, contentType, body);
      if (isRegister && up.status === 200) {
        const reg = parseJsonWith(RegisterResponseSchema, up.body);
        if (reg.ok && reg.value.code === 200) await recordRegistration(reg.value.data.device_key, reg.value.data.device_token, inviteTags, inviteCrypto, invite, inviteUnused);
      }
      return upstreamResponse(up);
    });
  }

  async function recordRegistration(
    deviceId: string,
    deviceToken: string,
    tags: Tags,
    crypto: DeviceCrypto | null,
    invite: string | null,
    inviteUnused: boolean,
  ) {
    const at = now();
    await store.devices.update((cur) => ({ next: upsertRegistration(cur, { deviceId, deviceToken, tags, crypto, now: at }).devices, result: null }));
    if (invite !== null && inviteUnused) {
      await store.invites.update((cur) => {
        const rec = cur[invite];
        if (rec === undefined || rec.used_by !== null) return { result: null };
        return { next: { ...cur, [invite]: { ...rec, used_by: deviceId } }, result: null };
      });
    }
  }

  // ---------- 管理面 (/bark-admin/) ----------

  async function adminPush(req: Request): Promise<Response> {
    // body は常に JSON として読む (curl -d の既定 Content-Type が form でも送れるように Content-Type は見ない)
    const env = parseJsonWith(AdminPushEnvelopeSchema, await req.text());
    if (!env.ok) return json(400, { error: env.error.message });
    const { device, ...rest } = env.value;
    if ("ciphertext" in rest || "iv" in rest) {
      return json(400, { error: "ciphertext / iv cannot be given. Send plain parameters; devices with a crypto key get them encrypted by bark-admin" });
    }
    // device_key / device_keys は pushParamsSchema に無いのでここで 400 になる (宛先は device で指定する)
    const params = parseWith(pushParamsSchema, rest);
    if (!params.ok) return json(400, { error: params.error.message });

    const devices = await store.devices.read();
    const { deviceIds, skipped } = resolveTargets(devices, device ?? {});
    if (deviceIds.length === 0) {
      return json(404, { error: `no active device matches the device filter. Check GET ${ADMIN}/api/devices`, sent: [], skipped });
    }
    // 鍵を持つ端末は 1 台ずつ暗号化して送り、残りは device_keys で一括
    const encrypted: { id: string; key: string }[] = [];
    const plain: string[] = [];
    for (const id of deviceIds) {
      const c = devices[id]?.crypto ?? null;
      if (c === null) plain.push(id);
      else encrypted.push({ id, key: c.key });
    }
    return withUpstream(async () => {
      const [batch, sealed] = await Promise.all([
        plain.length === 0 ? Promise.resolve(null) : bark.pushBatch(params.value, plain),
        Promise.all(encrypted.map((t) => pushEncrypted(params.value, t))),
      ]);
      if (batch !== null && !batch.ok) return json(502, { error: batch.message, upstream_status: batch.status });
      const results = new Map<string, PushResult & { encrypted: boolean }>();
      for (const r of batch?.results ?? []) results.set(r.device_id, { ...r, encrypted: false });
      for (const r of sealed) results.set(r.device_id, { ...r, encrypted: true });
      // 結果は宛先の並び順で返す
      const sent = deviceIds.flatMap((id) => results.get(id) ?? []);
      return json(200, { sent, skipped });
    });
  }

  async function pushEncrypted(params: PushParams, target: { id: string; key: string }): Promise<PushResult> {
    const iv = newCryptoIv();
    const ciphertext = await encryptForBark(target.key, iv, JSON.stringify(params));
    return bark.pushEncrypted(target.id, { ciphertext, iv });
  }

  async function listDevices(req: Request): Promise<Response> {
    const q = new URL(req.url).searchParams;
    const filter: Tags = {};
    for (const key of new Set(q.keys())) {
      if (key === "archived") continue;
      const vals = q.getAll(key);
      if (vals.length > 1) return json(400, { error: `tag "${key}" is given more than once (filters are AND of exact matches)` });
      filter[key] = vals[0] ?? "";
    }
    const list = selectDevices(await store.devices.read(), filter, q.get("archived") === "1");
    const body = list.map((d) => `${JSON.stringify(listItem(d))}\n`).join("");
    return new Response(body, { headers: { "content-type": "application/jsonl; charset=utf-8" } });
  }

  async function updateDevice(id: string, fn: (rec: DeviceRecord) => DeviceRecord): Promise<Response> {
    const updated = await store.devices.update((cur) => {
      const rec = cur[id];
      if (rec === undefined) return { result: null };
      const next = fn(rec);
      return { next: { ...cur, [id]: next }, result: next };
    });
    return updated === null ? json(404, { error: `device ${id} not found` }) : json(200, { device_id: id, ...updated });
  }

  async function createInvite(req: Request): Promise<Response> {
    const r = parseJsonWith(CreateInviteSchema, await req.text());
    if (!r.ok) return json(400, { error: r.error.message });
    const invite = newInviteId();
    const createdAt = now();
    const crypto = r.value.encrypt ? { key: newCryptoKey() } : null;
    await store.invites.update((cur) => ({
      next: { ...cur, [invite]: { tags: r.value.tags, created_at: createdAt, used_by: null, crypto } },
      result: null,
    }));
    return json(201, { invite, ...inviteUrls(serverUrl, invite), crypto });
  }

  async function inviteQr(invite: string): Promise<Response> {
    if ((await store.invites.read())[invite] === undefined) return json(404, { error: `invite ${invite} not found` });
    const svg = await QRCode.toString(inviteUrls(serverUrl, invite).add_url, { type: "svg", margin: 2 });
    return new Response(svg, { headers: { "content-type": "image/svg+xml" } });
  }

  async function addPage(invite: string): Promise<Response> {
    const rec = (await store.invites.read())[invite];
    if (rec === undefined) return html(404, notFoundPageHtml("この招待リンクは登録簿にない。管理画面で招待を作り直す。"));
    return html(200, addPageHtml({ addserverUrl: inviteUrls(serverUrl, invite).addserver_url, tags: rec.tags, used: rec.used_by !== null, cryptoKey: rec.crypto?.key ?? null }));
  }

  const assets = Object.fromEntries(
    readdirSync(join(PUBLIC_DIR, "assets")).map((name) => [`${ADMIN}/assets/${name}`, new Response(Bun.file(join(PUBLIC_DIR, "assets", name)))]),
  );

  const routes = {
    "/": Response.redirect(`${ADMIN}/`, 302),
    [ADMIN]: Response.redirect(`${ADMIN}/`, 302),
    [`${ADMIN}/`]: new Response(Bun.file(join(PUBLIC_DIR, "index.html"))),
    [`${ADMIN}/devices/:id`]: new Response(Bun.file(join(PUBLIC_DIR, "device.html"))),
    ...assets,
    [`${ADMIN}/add/:invite`]: { GET: (req: Bun.BunRequest<"/bark-admin/add/:invite">) => addPage(req.params.invite) },
    [`${ADMIN}/push`]: { POST: adminPush },
    [`${ADMIN}/api/schema`]: { GET: () => json(200, { fields: pushParamFields }) },
    [`${ADMIN}/api/devices`]: { GET: listDevices },
    [`${ADMIN}/api/devices/:id`]: {
      GET: async (req: Bun.BunRequest<"/bark-admin/api/devices/:id">) => {
        const rec = (await store.devices.read())[req.params.id];
        return rec === undefined ? json(404, { error: `device ${req.params.id} not found` }) : json(200, { device_id: req.params.id, ...rec });
      },
      PATCH: async (req: Bun.BunRequest<"/bark-admin/api/devices/:id">) => {
        const r = parseJsonWith(PatchDeviceSchema, await req.text());
        if (!r.ok) return json(400, { error: r.error.message });
        return updateDevice(req.params.id, (rec) => patchDevice(rec, r.value));
      },
      DELETE: (req: Bun.BunRequest<"/bark-admin/api/devices/:id">) => {
        const at = now();
        return updateDevice(req.params.id, (rec) => archiveDevice(rec, at));
      },
    },
    // 鍵を作り直して保存し、鍵入りの device を返す (詳細画面の「鍵を作り直す」/「暗号化する」)
    [`${ADMIN}/api/devices/:id/crypto`]: {
      POST: (req: Bun.BunRequest<"/bark-admin/api/devices/:id/crypto">) => {
        const key = newCryptoKey();
        return updateDevice(req.params.id, (rec) => ({ ...rec, crypto: { key } }));
      },
    },
    [`${ADMIN}/api/invites`]: { POST: createInvite },
    [`${ADMIN}/api/invites/:invite/qr.svg`]: {
      GET: (req: Bun.BunRequest<"/bark-admin/api/invites/:invite/qr.svg">) => inviteQr(req.params.invite),
    },
  };

  // routes に無いパス: /bark-admin/ 配下は 404、それ以外 (root) は bark-server 互換面として透過
  function fallback(req: Request): Promise<Response> | Response {
    const { pathname } = new URL(req.url);
    if (pathname.startsWith(`${ADMIN}/`)) return json(404, { error: `not found. The admin UI is at ${ADMIN}/` });
    const m = /^\/r\/([^/]+)(\/.*)?$/.exec(pathname);
    if (m?.[1] !== undefined) return passThrough(req, m[2] ?? "/", m[1]);
    return passThrough(req, pathname, null);
  }

  return { routes, fetch: fallback };
}
