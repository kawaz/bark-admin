import * as v from "valibot";
import { parseJsonWith } from "../parse.ts";
import { DeviceInfoSchema, TagsSchema } from "../schema/registry.ts";

// 管理 API の応答の形 (ブラウザ側の境界)。fetch の本文はここで型付きにしてから画面へ渡す。形は src/app.ts の応答と同じ

const Confirmed = v.object({ confirmed_at: v.nullable(v.string()) });

export const ConfigSchema = v.object({ server_host: v.string() });

const deviceCommon = {
  device_id: v.string(),
  registered_at: v.string(),
  archived_at: v.nullable(v.string()),
  tags: TagsSchema,
  delivery: Confirmed,
  migrated_to: v.nullable(v.string()),
  migrated_at: v.nullable(v.string()),
  migrated_from: v.nullable(v.string()),
};

// GET /api/devices の 1 行 (鍵は持たない)
export const DeviceListItemSchema = v.object({
  ...deviceCommon,
  crypto: v.nullable(Confirmed),
  info: v.object({ ts_hostname: v.optional(v.string()), os_version: v.optional(v.string()), server_host: v.optional(v.string()) }),
});
export type DeviceListItem = v.InferOutput<typeof DeviceListItemSchema>;

// GET /api/devices/:id (鍵を持つ)
export const DeviceViewSchema = v.object({
  ...deviceCommon,
  crypto: v.nullable(v.object({ key: v.string(), confirmed_at: v.nullable(v.string()) })),
  info: DeviceInfoSchema,
});
export type DeviceView = v.InferOutput<typeof DeviceViewSchema>;

export const InviteSchema = v.object({ invite: v.string(), add_url: v.string(), tags: TagsSchema, encrypt: v.boolean(), created_at: v.string(), registered: v.number() });
export type Invite = v.InferOutput<typeof InviteSchema>;

const PushSentSchema = v.object({ device_id: v.string(), status: v.number(), message: v.optional(v.string()), encrypted: v.boolean() });

// POST /bark-admin/push の 200 応答
export const PushResultSchema = v.object({ sent: v.array(PushSentSchema), skipped: v.number() });
export type PushResult = v.InferOutput<typeof PushResultSchema>;

// 失敗応答は {error} か bark 形式の {message} を持つ
const ErrorBodySchema = v.union([v.object({ error: v.string() }), v.object({ message: v.string() })]);

// GET /api/registrations/:token (招待ページが段の進み具合に使う)
export const RegistrationStatusSchema = v.object({
  state: v.picklist(["unused", "used", "expired", "invite-deleted"]),
  used_by: v.nullable(v.string()),
  device: v.nullable(v.object({ device_id: v.string(), tags: TagsSchema, delivery: Confirmed, crypto: v.nullable(Confirmed) })),
});
export type RegistrationStatus = v.InferOutput<typeof RegistrationStatusSchema>;

export const CryptoKeySchema = v.object({ key: v.string() });

export type Fetched<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

// 失敗応答の本文から、人に見せる 1 行を取り出す
export function errorText(status: number, statusText: string, text: string): string {
  const r = parseJsonWith(ErrorBodySchema, text);
  if (r.ok) return "error" in r.value ? r.value.error : r.value.message;
  return text === "" ? `${status} ${statusText}` : text;
}

// 応答を schema で型付きにする。2xx でなければ本文のエラー文を返す
export async function readJson<S extends v.GenericSchema>(res: Response, schema: S): Promise<Fetched<v.InferOutput<S>>> {
  return typedBody(res, await res.text(), schema);
}

// 読み終えた本文を型付きにする (本文そのものも画面に見せる時に使う)
export function typedBody<S extends v.GenericSchema>(res: Response, text: string, schema: S): Fetched<v.InferOutput<S>> {
  if (!res.ok) return { ok: false, status: res.status, error: errorText(res.status, res.statusText, text) };
  const r = parseJsonWith(schema, text);
  return r.ok ? { ok: true, value: r.value } : { ok: false, status: res.status, error: `応答の形が違う: ${r.error.message}` };
}

// JSON Lines の一覧 (GET /api/devices, /api/invites)
export async function readJsonl<S extends v.GenericSchema>(res: Response, schema: S): Promise<Fetched<v.InferOutput<S>[]>> {
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, error: errorText(res.status, res.statusText, text) };
  const out: v.InferOutput<S>[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const r = parseJsonWith(schema, line);
    if (!r.ok) return { ok: false, status: res.status, error: `応答の形が違う: ${r.error.message}` };
    out.push(r.value);
  }
  return { ok: true, value: out };
}

// 本文を読まない操作 (204 等) の失敗だけを文にする
export async function failure(res: Response): Promise<string | null> {
  if (res.ok) return null;
  return errorText(res.status, res.statusText, await res.text());
}

export function postJson(url: string, body: object): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
