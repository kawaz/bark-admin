import QRCode from "qrcode";
import * as v from "valibot";
import { assetRoutes, staticHtml } from "./assets.ts";
import { clientIp, LOOPBACK, type Cidr } from "./client-ip.ts";
import { BarkServer, RegisterResponseSchema, UpstreamError, type PushResult } from "./bark-server.ts";
import { autoTags, observeRegistration, tailscaleWhois, type TailnetInfo, type Whois } from "./device-info.ts";
import { gateToken, issueRegistration, registrationState } from "./invites.ts";
import { addPageHtml, confirmedPageHtml, notFoundPageHtml } from "./pages/add.ts";
import { parseJsonWith, parseWith } from "./parse.ts";
import { encryptForBark, newCryptoIv, newCryptoKey, randomAlnum } from "./push-crypto.ts";
import {
  archiveDevice,
  finishConfirm,
  freshCrypto,
  listItem,
  patchDevice,
  resolveTargets,
  selectDevices,
  startConfirm,
  upsertRegistration,
  view,
} from "./registry.ts";
import { pushParamFields, pushParamsSchema, type PushParams } from "./schema/push-params.ts";
import {
  ConfirmKindSchema,
  CreateInviteSchema,
  PatchDeviceSchema,
  TagsSchema,
  type ConfirmKind,
  type CryptoKeyOnly,
  type DeviceRecord,
  type Devices,
  type Client,
  ClientSchema,
  type InviteRecord,
  type Tags,
} from "./schema/registry.ts";
import type { Store } from "./store.ts";
import { localIso } from "./time.ts";

// URL は 2 面に分かれる:
// - root: bark-server 互換面。全 endpoint をそのまま bark-server へ透過する (`/r/<token>/*` は登録トークンの prefix を剥がして透過)。
//   中身を見るのは /register の応答を登録簿へ写す 1 点だけ
// - /bark-admin/: 管理面 (UI / 管理 API / タグ宛先の送信 API)

export const ADMIN = "/bark-admin";

export type AppDeps = {
  serverUrl: string;
  store: Store;
  bark: BarkServer;
  now?: () => Date;
  // 端末の IP から tailnet の端末情報を引く (既定は tailscale whois。引けなければ undefined)
  whois?: Whois;
  // X-Forwarded-For を信頼する接続元 (既定は loopback だけ。src/client-ip.ts)
  trustedProxies?: Cidr[];
};

// /bark-admin/push の body: bark V2 パラメータ (device_key / device_keys を除く) + device (タグ filter)
const AdminPushEnvelopeSchema = v.looseObject({ device: v.optional(TagsSchema) });

// register の要求側の key (使用済みの登録トークンでの再登録の判定用)。bark-server と同じく key / device_key の両方を見る
const RegisterKeySchema = v.looseObject({ key: v.optional(v.string()), device_key: v.optional(v.string()) });

// started.key は crypto の時の鍵 (delivery は null)
type ConfirmStart = { kind: "not-found" } | { kind: "no-key" } | { kind: "started"; key: string | null };

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

function html(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
}

function upstreamResponse(up: { status: number; contentType: string | null; body: string }): Response {
  return new Response(up.body, { status: up.status, headers: up.contentType === null ? {} : { "content-type": up.contentType } });
}

// bark-server と同じ形のエラー (Bark アプリが message を表示する)
function barkError(status: number, message: string): Response {
  return json(status, { code: status, message, timestamp: Math.floor(Date.now() / 1000) });
}

// 招待の QR が指す案内ページ
function addUrl(serverUrl: string, invite: string): string {
  return `${serverUrl}${ADMIN}/add/${invite}`;
}

// 登録トークン入りのサーバ URL を Bark に追加させる
function addserverUrl(serverUrl: string, token: string): string {
  return `bark://addserver?address=${serverUrl}/r/${token}`;
}

function newId(): string {
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
  const clock = deps.now ?? (() => new Date());
  const now = () => localIso(clock());
  const whois = deps.whois ?? tailscaleWhois;
  const trusted = deps.trustedProxies ?? LOOPBACK;

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
  // token は /r/<token>/* 経由のときの登録トークン。
  // remote は接続元の実 IP (Bun の server.requestIP)。X-Forwarded-For を信頼するかの判定に使う
  async function passThrough(req: Request, remote: string | undefined, path: string, token: string | null): Promise<Response> {
    const url = new URL(req.url);
    const contentType = req.headers.get("content-type");
    const body = await req.arrayBuffer();
    const isRegister = path === "/register";

    // 登録トークンを使う登録 (consume) でだけ招待のタグと鍵を写す (再登録で人が直したタグや作り直した鍵を戻さない)。招待ページから届いた client は再登録でも写し続ける
    let use: { token: string; tags: Tags; crypto: CryptoKeyOnly | null } | null = null;
    let client: Client | null = null;
    if (token !== null) {
      const rec = (await store.registrations.read())[token];
      if (rec === undefined) return barkError(404, "registration link not found. Open the invite page again");
      const invite = (await store.invites.read())[rec.invite];
      const gate = gateToken(rec, { isRegister, requestedKey: isRegister ? requestedKey(url, contentType, body) : "", inviteExists: invite !== undefined, now: clock() });
      if (gate.kind === "gone") return barkError(410, gate.message);
      if (gate.consume && invite !== undefined) use = { token, tags: invite.tags, crypto: rec.crypto };
      client = rec.client;
    }

    // whois は bark-server の応答を待つ間に引いておく
    const ip = isRegister ? clientIp(remote, req.headers.get("x-forwarded-for"), trusted) : undefined;
    const tailnet: Promise<TailnetInfo | undefined> = ip === undefined ? Promise.resolve(undefined) : whois(ip);

    return withUpstream(async () => {
      const up = await bark.forward(req.method, `${path}${url.search}`, contentType, body);
      if (isRegister && up.status === 200) {
        const reg = parseJsonWith(RegisterResponseSchema, up.body);
        if (reg.ok && reg.value.code === 200) {
          await recordRegistration(reg.value.data.device_key, reg.value.data.device_token, use, { headers: req.headers, tailnet: await tailnet, client });
        }
      }
      return upstreamResponse(up);
    });
  }

  async function recordRegistration(
    deviceId: string,
    deviceToken: string,
    use: { token: string; tags: Tags; crypto: CryptoKeyOnly | null } | null,
    seen: { headers: Headers; tailnet: TailnetInfo | undefined; client: Client | null },
  ) {
    const at = now();
    const info = observeRegistration({ ...seen, now: at });
    const reg = { deviceId, deviceToken, tags: use?.tags ?? {}, crypto: use?.crypto ?? null, info, autoTags: autoTags(info), now: at };
    await store.devices.update((cur) => ({ next: upsertRegistration(cur, reg).devices, result: null }));
    if (use === null) return;
    await store.registrations.update((cur) => {
      const rec = cur[use.token];
      if (rec === undefined || rec.used_by !== null) return { result: null };
      return { next: { ...cur, [use.token]: { ...rec, used_by: deviceId, used_at: at } }, result: null };
    });
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
    return updated === null ? json(404, { error: `device ${id} not found` }) : json(200, view(id, updated));
  }

  // 確認: nonce 入りの URL を通知で送り、タップで開かれると finishDeviceConfirm が kind の確認済みを記録する。
  // delivery は平文で送り「通知が届くか」を、crypto は暗号化して送り「鍵が Bark に正しく設定されたか」を確かめる (復号できた端末だけが URL を知る)
  async function startDeviceConfirm(id: string, kind: ConfirmKind): Promise<Response> {
    const nonce = randomAlnum(22);
    const started = await store.devices.update((cur): { next?: Devices; result: ConfirmStart } => {
      const r = cur[id];
      if (r === undefined) return { result: { kind: "not-found" } };
      const next = startConfirm(r, kind, nonce);
      if (next === null) return { result: { kind: "no-key" } };
      return { next: { ...cur, [id]: next }, result: { kind: "started", key: next.crypto?.key ?? null } };
    });
    if (started.kind === "not-found") return json(404, { error: `device ${id} not found` });
    if (started.kind === "no-key") return json(409, { error: `device ${id} has no crypto key. Set one with POST ${ADMIN}/api/devices/${id}/crypto first` });
    const url = `${serverUrl}${ADMIN}/api/devices/${encodeURIComponent(id)}/confirm/${kind}/${nonce}`;
    const key = started.key;
    return withUpstream(async () => {
      const r =
        kind === "crypto" && key !== null
          ? await pushEncrypted({ title: "bark-admin 暗号化の確認", body: `この通知をタップすると暗号化の確認が完了する\ndevice: ${id}`, url }, { id, key })
          : await bark.pushPlain(id, { title: "bark-admin 受信の確認", body: `この通知をタップすると受信確認が完了する\ndevice: ${id}`, url });
      const sent = { ...r, encrypted: kind === "crypto" };
      if (r.status === 200) return json(200, { sent });
      return json(502, { error: `bark-server did not accept the confirm notification: ${r.message ?? `status ${r.status}`}`, sent });
    });
  }

  async function finishDeviceConfirm(id: string, kind: ConfirmKind, nonce: string): Promise<Response> {
    const at = now();
    const confirmed = await store.devices.update((cur) => {
      const r = cur[id];
      const next = r === undefined ? null : finishConfirm(r, kind, nonce, at);
      return next === null ? { result: null } : { next: { ...cur, [id]: next }, result: next };
    });
    if (confirmed === null) return html(404, notFoundPageHtml("この確認リンクは使用済みか古い。確認を送り直す。", "確認リンクが見つからない"));
    return html(200, confirmedPageHtml({ kind, deviceId: id, device: confirmed }));
  }

  // URL の kind (delivery / crypto)。それ以外は 404
  function confirmKind(raw: string): ConfirmKind | null {
    const r = parseWith(ConfirmKindSchema, raw);
    return r.ok ? r.value : null;
  }

  async function createInvite(req: Request): Promise<Response> {
    const r = parseJsonWith(CreateInviteSchema, await req.text());
    if (!r.ok) return json(400, { error: r.error.message });
    const invite = newId();
    const rec: InviteRecord = { tags: r.value.tags, encrypt: r.value.encrypt, created_at: now() };
    await store.invites.update((cur) => ({ next: { ...cur, [invite]: rec }, result: null }));
    return json(201, inviteView(invite, rec, 0));
  }

  // registered はこの招待から登録された端末の数 (使用済みの登録トークンの数)
  function inviteView(invite: string, rec: InviteRecord, registered: number) {
    return { invite, add_url: addUrl(serverUrl, invite), ...rec, registered };
  }

  async function listInvites(): Promise<Response> {
    const [invites, regs] = await Promise.all([store.invites.read(), store.registrations.read()]);
    const used = Object.values(regs).filter((t) => t.used_by !== null);
    const body = Object.entries(invites)
      .map(([id, rec]) => `${JSON.stringify(inviteView(id, rec, used.filter((t) => t.invite === id).length))}\n`)
      .join("");
    return new Response(body, { headers: { "content-type": "application/jsonl; charset=utf-8" } });
  }

  // 招待を消し、その招待の未使用の登録トークンも消す (使用済みは端末の再登録のために残す)
  async function deleteInvite(invite: string): Promise<Response> {
    const found = await store.invites.update((cur) => {
      if (cur[invite] === undefined) return { result: false };
      return { next: Object.fromEntries(Object.entries(cur).filter(([id]) => id !== invite)), result: true };
    });
    if (!found) return json(404, { error: `invite ${invite} not found` });
    await store.registrations.update((cur) => ({ next: Object.fromEntries(Object.entries(cur).filter(([, t]) => t.invite !== invite || t.used_by !== null)), result: null }));
    return new Response(null, { status: 204 });
  }

  async function inviteQr(invite: string): Promise<Response> {
    if ((await store.invites.read())[invite] === undefined) return json(404, { error: `invite ${invite} not found` });
    const svg = await QRCode.toString(addUrl(serverUrl, invite), { type: "svg", margin: 2 });
    return new Response(svg, { headers: { "content-type": "image/svg+xml" } });
  }

  // 開くたびに登録トークンを発行し、そのトークン入りのサーバ URL と (暗号化するなら) 端末ごとの新しい鍵を見せる
  async function addPage(req: Request, invite: string): Promise<Response> {
    const rec = (await store.invites.read())[invite];
    if (rec === undefined) return html(404, notFoundPageHtml("この招待リンクは登録簿にない (削除されたかもしれない)。管理画面で招待を作り直す。"));
    const token = newId();
    const key = rec.encrypt ? newCryptoKey() : null;
    const at = clock();
    await store.registrations.update((cur) => ({ next: issueRegistration(cur, token, { invite, key, now: at }), result: null }));
    return html(200, addPageHtml({ addserverUrl: addserverUrl(serverUrl, token), token, tags: rec.tags, encrypted: key !== null }), { "cache-control": "no-store" });
  }

  // 招待ページが登録の完了を見る。鍵は返さない (crypto-key で取る)
  async function registrationStatus(token: string): Promise<Response> {
    const [regs, invites, devices] = await Promise.all([store.registrations.read(), store.invites.read(), store.devices.read()]);
    const rec = regs[token];
    if (rec === undefined) return json(404, { error: `registration ${token} not found. Open the invite page again` });
    const dev = rec.used_by === null ? undefined : devices[rec.used_by];
    return json(200, {
      token,
      state: registrationState(rec, { inviteExists: invites[rec.invite] !== undefined, now: clock() }),
      used_by: rec.used_by,
      used_at: rec.used_at,
      expires_at: rec.expires_at,
      encrypted: rec.crypto !== null,
      device:
        rec.used_by === null || dev === undefined
          ? null
          : {
              device_id: rec.used_by,
              tags: dev.tags,
              ...(dev.info === undefined ? {} : { info: dev.info }),
              // 招待ページの受信確認・暗号化の段が見る
              delivery: { confirmed_at: dev.delivery?.confirmed_at ?? null },
              crypto: dev.crypto === null ? null : { confirmed_at: dev.crypto.confirmed_at },
            },
    });
  }

  // 招待ページの JS が送る端末の手がかり (iPad と Mac を見分ける platform / maxTouchPoints 等)。登録の時に device.info と os タグへ写す
  async function registrationClient(token: string, req: Request): Promise<Response> {
    const r = parseJsonWith(ClientSchema, await req.text());
    if (!r.ok) return json(400, { error: r.error.message });
    const found = await store.registrations.update((cur) => {
      const rec = cur[token];
      return rec === undefined ? { result: false } : { next: { ...cur, [token]: { ...rec, client: r.value } }, result: true };
    });
    return found ? new Response(null, { status: 204 }) : json(404, { error: `registration ${token} not found. Open the invite page again` });
  }

  // 登録できた端末に貼る鍵。招待ページのコピーボタンが押された時に取る (登録前は 409、鍵の無いトークンは 404)
  async function registrationKey(token: string): Promise<Response> {
    const rec = (await store.registrations.read())[token];
    if (rec === undefined) return json(404, { error: `registration ${token} not found. Open the invite page again` });
    if (rec.crypto === null) return json(404, { error: `registration ${token} has no crypto key (the invite does not encrypt)` });
    if (rec.used_by === null) return json(409, { error: `registration ${token} is not used yet. Add the server in Bark first` });
    return Response.json({ key: rec.crypto.key }, { headers: { "cache-control": "no-store" } });
  }

  const routes = {
    "/": Response.redirect(`${ADMIN}/`, 302),
    [ADMIN]: Response.redirect(`${ADMIN}/`, 302),
    // HTML と静的ファイルは版つき URL・no-cache・ETag で配る (src/assets.ts)
    [`${ADMIN}/`]: staticHtml("index.html"),
    [`${ADMIN}/devices/:id`]: staticHtml("device.html"),
    ...assetRoutes(),
    [`${ADMIN}/add/:invite`]: { GET: (req: Bun.BunRequest<"/bark-admin/add/:invite">) => addPage(req, req.params.invite) },
    [`${ADMIN}/push`]: { POST: adminPush },
    [`${ADMIN}/api/schema`]: { GET: () => json(200, { fields: pushParamFields }) },
    // 今の公開名 (server_url のホスト名)。画面が端末の info.server_host と見比べて、古い公開名で追加された端末に注記する
    [`${ADMIN}/api/config`]: { GET: () => json(200, { server_host: new URL(serverUrl).hostname }) },
    [`${ADMIN}/api/devices`]: { GET: listDevices },
    [`${ADMIN}/api/devices/:id`]: {
      GET: async (req: Bun.BunRequest<"/bark-admin/api/devices/:id">) => {
        const rec = (await store.devices.read())[req.params.id];
        return rec === undefined ? json(404, { error: `device ${req.params.id} not found` }) : json(200, view(req.params.id, rec));
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
    // 鍵を作り (作り直し) 保存し、鍵入りの device を返す (詳細画面の「暗号化キーを設定」/「鍵を作り直す」)。確認状態は未確認に戻る
    [`${ADMIN}/api/devices/:id/crypto`]: {
      POST: (req: Bun.BunRequest<"/bark-admin/api/devices/:id/crypto">) => {
        const key = newCryptoKey();
        return updateDevice(req.params.id, (rec) => ({ ...rec, crypto: freshCrypto({ key }) }));
      },
    },
    [`${ADMIN}/api/devices/:id/confirm/:kind`]: {
      POST: (req: Bun.BunRequest<"/bark-admin/api/devices/:id/confirm/:kind">) => {
        const kind = confirmKind(req.params.kind);
        return kind === null ? json(404, { error: `unknown confirm kind ${req.params.kind}. Use delivery or crypto` }) : startDeviceConfirm(req.params.id, kind);
      },
    },
    // 確認通知の url。iPhone の Safari で開かれるので HTML を返す
    [`${ADMIN}/api/devices/:id/confirm/:kind/:nonce`]: {
      GET: (req: Bun.BunRequest<"/bark-admin/api/devices/:id/confirm/:kind/:nonce">) => {
        const kind = confirmKind(req.params.kind);
        return kind === null ? html(404, notFoundPageHtml("この確認リンクは形が違う。確認を送り直す。", "確認リンクが見つからない")) : finishDeviceConfirm(req.params.id, kind, req.params.nonce);
      },
    },
    [`${ADMIN}/api/invites`]: { GET: listInvites, POST: createInvite },
    [`${ADMIN}/api/registrations/:token`]: {
      GET: (req: Bun.BunRequest<"/bark-admin/api/registrations/:token">) => registrationStatus(req.params.token),
    },
    [`${ADMIN}/api/registrations/:token/client`]: {
      POST: (req: Bun.BunRequest<"/bark-admin/api/registrations/:token/client">) => registrationClient(req.params.token, req),
    },
    [`${ADMIN}/api/registrations/:token/crypto-key`]: {
      GET: (req: Bun.BunRequest<"/bark-admin/api/registrations/:token/crypto-key">) => registrationKey(req.params.token),
    },
    [`${ADMIN}/api/invites/:invite`]: {
      DELETE: (req: Bun.BunRequest<"/bark-admin/api/invites/:invite">) => deleteInvite(req.params.invite),
    },
    [`${ADMIN}/api/invites/:invite/qr.svg`]: {
      GET: (req: Bun.BunRequest<"/bark-admin/api/invites/:invite/qr.svg">) => inviteQr(req.params.invite),
    },
  };

  // routes に無いパス: /bark-admin/ 配下は 404、それ以外 (root) は bark-server 互換面として透過
  function fallback(req: Request, server: Bun.Server<undefined>): Promise<Response> | Response {
    const remote = server.requestIP(req)?.address;
    const { pathname } = new URL(req.url);
    if (pathname.startsWith(`${ADMIN}/`)) return json(404, { error: `not found. The admin UI is at ${ADMIN}/` });
    const m = /^\/r\/([^/]+)(\/.*)?$/.exec(pathname);
    if (m?.[1] !== undefined) return passThrough(req, remote, m[2] ?? "/", m[1]);
    return passThrough(req, remote, pathname, null);
  }

  return { routes, fetch: fallback };
}
