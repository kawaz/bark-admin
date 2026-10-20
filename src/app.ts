import { readdirSync } from "node:fs";
import { join } from "node:path";
import QRCode from "qrcode";
import * as v from "valibot";
import { BarkServer, RegisterResponseSchema, UpstreamError } from "./bark-server.ts";
import { addPageHtml, notFoundPageHtml } from "./pages/add.ts";
import { parseJsonWith, parseWith } from "./parse.ts";
import { archiveDevice, patchDevice, resolveTargets, selectDevices, upsertRegistration } from "./registry.ts";
import { pushParamFields, pushParamsSchema } from "./schema/push-params.ts";
import { CreateInviteSchema, PatchDeviceSchema, TagsSchema, type DeviceRecord, type Tags } from "./schema/registry.ts";
import type { Store } from "./store.ts";
import { localIso } from "./time.ts";

export type AppDeps = {
  serverUrl: string;
  store: Store;
  bark: BarkServer;
  now?: () => string;
};

const PUBLIC_DIR = join(import.meta.dir, "..", "public");

// /push の body: bark V2 パラメータ + 宛先指定。宛先は device (タグ filter) か device_key(s) の直指定。
const PushEnvelopeSchema = v.looseObject({
  device: v.optional(TagsSchema),
  device_key: v.optional(v.string()),
  // bark-server はカンマ区切り文字列も受けるので透過時はどちらも通す
  device_keys: v.optional(v.union([v.array(v.string()), v.string()])),
});

// register の要求側の key (再登録の判定用)。bark-server と同じく key / device_key の両方を見る
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
    add_url: `${serverUrl}/add/${invite}`,
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

  async function push(req: Request): Promise<Response> {
    // body は常に JSON として読む (curl -d の既定 Content-Type が form でも送れるように Content-Type は見ない)
    const env = parseJsonWith(PushEnvelopeSchema, await req.text());
    if (!env.ok) return json(400, { error: env.error.message });
    const { device, device_key, device_keys, ...rest } = env.value;
    const params = parseWith(pushParamsSchema, rest);
    if (!params.ok) return json(400, { error: params.error.message });

    return withUpstream(async () => {
      if (device_key !== undefined || device_keys !== undefined) {
        if (device !== undefined) return json(400, { error: "specify either device (tag filter) or device_key(s), not both" });
        // bark 互換: 宛先もパラメータもそのまま bark-server に渡し、応答も丸ごと返す
        const direct = {
          ...params.value,
          ...(device_key !== undefined ? { device_key } : {}),
          ...(device_keys !== undefined ? { device_keys } : {}),
        };
        return upstreamResponse(await bark.forward("POST", "/push", "application/json; charset=utf-8", JSON.stringify(direct)));
      }
      const { deviceIds, skipped } = resolveTargets(await store.devices.read(), device ?? {});
      if (deviceIds.length === 0) {
        return json(404, { error: "no active device matches the device filter. Check GET /api/devices", sent: [], skipped });
      }
      const r = await bark.pushBatch(params.value, deviceIds);
      if (!r.ok) return json(502, { error: r.message, upstream_status: r.status });
      return json(200, { sent: r.results, skipped });
    });
  }

  async function register(req: Request, invite: string | null): Promise<Response> {
    const url = new URL(req.url);
    const contentType = req.headers.get("content-type");
    const body = await req.arrayBuffer();

    let inviteTags: Tags = {};
    let inviteUnused = false;
    if (invite !== null) {
      const rec = (await store.invites.read())[invite];
      if (rec === undefined) return barkError(404, "invite not found. Ask for a new invite link");
      // URL に招待が入ったサーバはアプリ起動のたびに同じ URL で再登録してくるので、
      // 使用済みの招待でも、使った本人 (used_by) の key での再登録は通す
      if (rec.used_by !== null && requestedKey(url, contentType, body) !== rec.used_by) {
        return barkError(410, "invite already used. Ask for a new invite link");
      }
      inviteTags = rec.tags;
      inviteUnused = rec.used_by === null;
    }

    return withUpstream(async () => {
      const up = await bark.forward(req.method, `/register${url.search}`, contentType, body);
      const reg = up.status === 200 ? parseJsonWith(RegisterResponseSchema, up.body) : null;
      if (reg?.ok && reg.value.code === 200) {
        const deviceId = reg.value.data.device_key;
        const deviceToken = reg.value.data.device_token;
        const at = now();
        await store.devices.update((cur) => {
          const { devices } = upsertRegistration(cur, { deviceId, deviceToken, tags: inviteTags, now: at });
          return { next: devices, result: null };
        });
        if (invite !== null && inviteUnused) {
          await store.invites.update((cur) => {
            const rec = cur[invite];
            if (rec === undefined || rec.used_by !== null) return { result: null };
            return { next: { ...cur, [invite]: { ...rec, used_by: deviceId } }, result: null };
          });
        }
      }
      return upstreamResponse(up);
    });
  }

  async function ping(invite: string | null): Promise<Response> {
    if (invite !== null && (await store.invites.read())[invite] === undefined) {
      return barkError(404, "invite not found. Ask for a new invite link");
    }
    return withUpstream(async () => upstreamResponse(await bark.forward("GET", "/ping", null, null)));
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
    const body = list.map((d) => `${JSON.stringify(d)}\n`).join("");
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
    await store.invites.update((cur) => ({
      next: { ...cur, [invite]: { tags: r.value.tags, created_at: createdAt, used_by: null } },
      result: null,
    }));
    return json(201, { invite, ...inviteUrls(serverUrl, invite) });
  }

  async function inviteQr(invite: string): Promise<Response> {
    if ((await store.invites.read())[invite] === undefined) return json(404, { error: `invite ${invite} not found` });
    const svg = await QRCode.toString(inviteUrls(serverUrl, invite).add_url, { type: "svg", margin: 2 });
    return new Response(svg, { headers: { "content-type": "image/svg+xml" } });
  }

  async function addPage(invite: string): Promise<Response> {
    const rec = (await store.invites.read())[invite];
    if (rec === undefined) return html(404, notFoundPageHtml("この招待リンクは無効です。管理画面で招待を作り直してください。"));
    return html(200, addPageHtml({ addserverUrl: inviteUrls(serverUrl, invite).addserver_url, tags: rec.tags, used: rec.used_by !== null }));
  }

  const assets = Object.fromEntries(
    readdirSync(join(PUBLIC_DIR, "assets")).map((name) => [`/assets/${name}`, new Response(Bun.file(join(PUBLIC_DIR, "assets", name)))]),
  );

  const routes = {
    "/": new Response(Bun.file(join(PUBLIC_DIR, "index.html"))),
    "/devices/:id": new Response(Bun.file(join(PUBLIC_DIR, "device.html"))),
    ...assets,

    "/push": { POST: push },
    "/ping": { GET: () => ping(null) },
    "/healthz": { GET: () => withUpstream(async () => upstreamResponse(await bark.forward("GET", "/healthz", null, null))) },
    "/register": { GET: (req: Request) => register(req, null), POST: (req: Request) => register(req, null) },
    "/r/:invite/ping": { GET: (req: Bun.BunRequest<"/r/:invite/ping">) => ping(req.params.invite) },
    "/r/:invite/register": {
      GET: (req: Bun.BunRequest<"/r/:invite/register">) => register(req, req.params.invite),
      POST: (req: Bun.BunRequest<"/r/:invite/register">) => register(req, req.params.invite),
    },
    "/add/:invite": { GET: (req: Bun.BunRequest<"/add/:invite">) => addPage(req.params.invite) },

    "/api/schema": { GET: () => json(200, { fields: pushParamFields }) },
    "/api/devices": { GET: listDevices },
    "/api/devices/:id": {
      GET: async (req: Bun.BunRequest<"/api/devices/:id">) => {
        const rec = (await store.devices.read())[req.params.id];
        return rec === undefined ? json(404, { error: `device ${req.params.id} not found` }) : json(200, { device_id: req.params.id, ...rec });
      },
      PATCH: async (req: Bun.BunRequest<"/api/devices/:id">) => {
        const r = parseJsonWith(PatchDeviceSchema, await req.text());
        if (!r.ok) return json(400, { error: r.error.message });
        return updateDevice(req.params.id, (rec) => patchDevice(rec, r.value));
      },
      DELETE: (req: Bun.BunRequest<"/api/devices/:id">) => {
        const at = now();
        return updateDevice(req.params.id, (rec) => archiveDevice(rec, at));
      },
    },
    "/api/invites": { POST: createInvite },
    "/api/invites/:invite/qr.svg": { GET: (req: Bun.BunRequest<"/api/invites/:invite/qr.svg">) => inviteQr(req.params.invite) },
  };

  // bark の URL 形式 (/<key>/<body> 等) を含め、上に無いパスは透過せず 404
  function fallback(): Response {
    return json(404, { error: "not found. Send notifications with POST /push" });
  }

  return { routes, fetch: fallback };
}
