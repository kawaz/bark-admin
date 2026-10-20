import * as v from "valibot";

// 登録簿 (devices.json) と招待 (invites.json) の形。手で直せる JSON なので読み込み時に必ず通す。

export const TagsSchema = v.record(v.string(), v.string());
export type Tags = v.InferOutput<typeof TagsSchema>;

// 端末の Bark アプリの暗号化設定に入れる鍵 (AES256 / GCM / noPadding の Key 欄)。文字列の UTF-8 バイト列がそのまま鍵になる
const CryptoKeySchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9]{32}$/, "crypto key must be 32 characters of [A-Za-z0-9]"));

// 招待が持つ鍵 (PATCH で鍵を指定するときも同じ形)
export const CryptoKeyOnlySchema = v.strictObject({ key: CryptoKeySchema });
export type CryptoKeyOnly = v.InferOutput<typeof CryptoKeyOnlySchema>;

// 端末が持つ鍵と、Bark に正しく設定されたかの確認状態。
// confirmed_at: 暗号化した確認通知の URL (pending_nonce 入り) を端末が開いた日時。復号できた端末だけがその URL を知る
export const DeviceCryptoSchema = v.strictObject({
  key: CryptoKeySchema,
  confirmed_at: v.optional(v.nullable(v.string()), null),
  pending_nonce: v.optional(v.nullable(v.string()), null),
});
export type DeviceCrypto = v.InferOutput<typeof DeviceCryptoSchema>;

export const DeviceRecordSchema = v.object({
  device_token: v.string(),
  registered_at: v.string(),
  archived_at: v.nullable(v.string()),
  tags: TagsSchema,
  // null は暗号化しない。crypto キーを省いた行 (手で書いた登録簿) も null として読む
  crypto: v.optional(v.nullable(DeviceCryptoSchema), null),
});
export type DeviceRecord = v.InferOutput<typeof DeviceRecordSchema>;

export const DevicesSchema = v.record(v.string(), DeviceRecordSchema);
export type Devices = v.InferOutput<typeof DevicesSchema>;

export const InviteRecordSchema = v.object({
  tags: TagsSchema,
  created_at: v.string(),
  used_by: v.nullable(v.string()),
  // 登録時に device へ写す鍵。招待ページで端末の持ち主に見せる
  crypto: v.optional(v.nullable(CryptoKeyOnlySchema), null),
});
export type InviteRecord = v.InferOutput<typeof InviteRecordSchema>;

export const InvitesSchema = v.record(v.string(), InviteRecordSchema);
export type Invites = v.InferOutput<typeof InvitesSchema>;

// API で外に出す 1 device の形 (キーだった device_id を中に持つ)。pending_nonce は確認の根拠なので外に出さない
export type DeviceView = { device_id: string } & Omit<DeviceRecord, "crypto"> & { crypto: { key: string; confirmed_at: string | null } | null };

// 一覧 (GET /api/devices) の 1 行。鍵は詳細でだけ見せ、一覧には暗号化の有無と確認状態だけ出す
export type DeviceListItem = { device_id: string } & Omit<DeviceRecord, "crypto"> & { crypto: { confirmed_at: string | null } | null };

export const PatchDeviceSchema = v.pipe(
  v.strictObject({
    tags: v.optional(TagsSchema),
    archived_at: v.optional(v.null()),
    crypto: v.optional(v.nullable(CryptoKeyOnlySchema)),
  }),
  v.check((p) => p.tags !== undefined || p.archived_at !== undefined || p.crypto !== undefined, "tags, archived_at or crypto is required"),
);
export type PatchDevice = v.InferOutput<typeof PatchDeviceSchema>;

// encrypt: true なら招待に鍵を作り、登録された端末に写す
export const CreateInviteSchema = v.strictObject({ tags: TagsSchema, encrypt: v.optional(v.boolean(), false) });
