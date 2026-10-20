import * as v from "valibot";

// 登録簿 (devices.json) と招待 (invites.json) の形。手で直せる JSON なので読み込み時に必ず通す。

export const TagsSchema = v.record(v.string(), v.string());
export type Tags = v.InferOutput<typeof TagsSchema>;

// 端末の Bark アプリの暗号化設定に入れる鍵 (AES256 / GCM / noPadding の Key 欄)。文字列の UTF-8 バイト列がそのまま鍵になる
export const DeviceCryptoSchema = v.strictObject({
  key: v.pipe(v.string(), v.regex(/^[A-Za-z0-9]{32}$/, "crypto key must be 32 characters of [A-Za-z0-9]")),
});
export type DeviceCrypto = v.InferOutput<typeof DeviceCryptoSchema>;

// null は暗号化しない。crypto キーを省いた行 (手で書いた登録簿) も null として読む
const CryptoFieldSchema = v.optional(v.nullable(DeviceCryptoSchema), null);

export const DeviceRecordSchema = v.object({
  device_token: v.string(),
  registered_at: v.string(),
  archived_at: v.nullable(v.string()),
  tags: TagsSchema,
  crypto: CryptoFieldSchema,
});
export type DeviceRecord = v.InferOutput<typeof DeviceRecordSchema>;

export const DevicesSchema = v.record(v.string(), DeviceRecordSchema);
export type Devices = v.InferOutput<typeof DevicesSchema>;

export const InviteRecordSchema = v.object({
  tags: TagsSchema,
  created_at: v.string(),
  used_by: v.nullable(v.string()),
  // 登録時に device へ写す鍵。招待ページで端末の持ち主に見せる
  crypto: CryptoFieldSchema,
});
export type InviteRecord = v.InferOutput<typeof InviteRecordSchema>;

export const InvitesSchema = v.record(v.string(), InviteRecordSchema);
export type Invites = v.InferOutput<typeof InvitesSchema>;

// API で外に出す 1 device の形 (キーだった device_id を中に持つ)
export type DeviceView = { device_id: string } & DeviceRecord;

// 一覧 (GET /api/devices) の 1 行。鍵は詳細でだけ見せ、一覧には暗号化の有無だけ出す
export type DeviceListItem = { device_id: string } & Omit<DeviceRecord, "crypto"> & { encrypted: boolean };

export const PatchDeviceSchema = v.pipe(
  v.strictObject({
    tags: v.optional(TagsSchema),
    archived_at: v.optional(v.null()),
    crypto: v.optional(v.nullable(DeviceCryptoSchema)),
  }),
  v.check((p) => p.tags !== undefined || p.archived_at !== undefined || p.crypto !== undefined, "tags, archived_at or crypto is required"),
);
export type PatchDevice = v.InferOutput<typeof PatchDeviceSchema>;

// encrypt: true なら招待に鍵を作り、登録された端末に写す
export const CreateInviteSchema = v.strictObject({ tags: TagsSchema, encrypt: v.optional(v.boolean(), false) });
