import * as v from "valibot";

// 登録簿 (devices.json) と招待 (invites.json) の形。手で直せる JSON なので読み込み時に必ず通す。

export const TagsSchema = v.record(v.string(), v.string());
export type Tags = v.InferOutput<typeof TagsSchema>;

// 端末の Bark アプリの暗号化設定に入れる鍵 (AES256 / GCM / noPadding の Key 欄)。文字列の UTF-8 バイト列がそのまま鍵になる
const CryptoKeySchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9]{32}$/, "crypto key must be 32 characters of [A-Za-z0-9]"));

// 登録トークンが持つ鍵 (PATCH で鍵を指定するときも同じ形)
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

// 招待ページを開いたブラウザ (登録トークンに残す)。登録時に device.info の browser_* へ写す
export const InviteBrowserSchema = v.object({
  user_agent: v.optional(v.string()),
  // Sec-CH-UA* ヘッダ (小文字の名前 → 値)。Safari は送らない
  hints: v.optional(v.record(v.string(), v.string())),
});
export type InviteBrowser = v.InferOutput<typeof InviteBrowserSchema>;

// 登録の要求から観察した端末情報。人は編集せず、再登録のたびに丸ごと置き換わる (出どころは src/device-info.ts)
export const DeviceInfoSchema = v.object({
  bark_version: v.optional(v.string()),
  bark_build: v.optional(v.string()),
  // UA の OS 名と版 (`iOS 26.7.1`)
  os_version: v.optional(v.string()),
  user_agent: v.optional(v.string()),
  // Accept-Language の値そのまま
  lang: v.optional(v.string()),
  ts_name: v.optional(v.string()),
  ts_hostname: v.optional(v.string()),
  ts_os: v.optional(v.string()),
  ts_user: v.optional(v.string()),
  ts_ip: v.optional(v.string()),
  browser_user_agent: v.optional(v.string()),
  browser_hints: v.optional(v.record(v.string(), v.string())),
  last_register_at: v.optional(v.string()),
});
export type DeviceInfo = v.InferOutput<typeof DeviceInfoSchema>;

export const DeviceRecordSchema = v.object({
  device_token: v.string(),
  registered_at: v.string(),
  archived_at: v.nullable(v.string()),
  tags: TagsSchema,
  // null は暗号化しない。crypto キーを省いた行 (手で書いた登録簿) も null として読む
  crypto: v.optional(v.nullable(DeviceCryptoSchema), null),
  // 次の登録で埋まる。それまでの行 (と手で書いた行) には無い
  info: v.optional(DeviceInfoSchema),
});
export type DeviceRecord = v.InferOutput<typeof DeviceRecordSchema>;

export const DevicesSchema = v.record(v.string(), DeviceRecordSchema);
export type Devices = v.InferOutput<typeof DevicesSchema>;

// 招待: 再利用できるテンプレ。QR (/bark-admin/add/:invite) はこれを指し、削除するまで何度でも使える
export const InviteRecordSchema = v.object({
  tags: TagsSchema,
  // true なら登録トークンを発行するたびに端末ごとの新しい鍵を作る
  encrypt: v.boolean(),
  created_at: v.string(),
  note: v.optional(v.string()),
});
export type InviteRecord = v.InferOutput<typeof InviteRecordSchema>;

export const InvitesSchema = v.record(v.string(), InviteRecordSchema);
export type Invites = v.InferOutput<typeof InvitesSchema>;

// 登録トークン: 招待ページを開くたびに発行する使い切りのサーバ URL (/r/<token>)。登録に使われたら used_by / used_at を記録する
export const RegistrationRecordSchema = v.object({
  invite: v.string(),
  // 招待の encrypt が true なら、このトークンで登録する端末の鍵 (招待ページに表示する)
  crypto: v.nullable(CryptoKeyOnlySchema),
  browser: v.nullable(InviteBrowserSchema),
  created_at: v.string(),
  expires_at: v.string(),
  used_by: v.nullable(v.string()),
  used_at: v.nullable(v.string()),
});
export type RegistrationRecord = v.InferOutput<typeof RegistrationRecordSchema>;

export const RegistrationsSchema = v.record(v.string(), RegistrationRecordSchema);
export type Registrations = v.InferOutput<typeof RegistrationsSchema>;

// 招待を作り替える前の invites.json の行 (used_by を持つ)。起動時に見つけたら脇へ退ける
export const LegacyInvitesSchema = v.record(v.string(), v.looseObject({ used_by: v.nullable(v.string()) }));

// API で外に出す 1 device の形 (キーだった device_id を中に持つ)。pending_nonce は確認の根拠なので外に出さない
// info の無い行も {} で出す
export type DeviceView = { device_id: string } & Omit<DeviceRecord, "crypto" | "info"> & { crypto: { key: string; confirmed_at: string | null } | null; info: DeviceInfo };

// 一覧 (GET /api/devices) の 1 行。鍵は詳細でだけ見せ、一覧には暗号化の有無と確認状態だけ出す。info は一覧の表示に使う 2 項目だけ
export type DeviceListItem = { device_id: string } & Omit<DeviceRecord, "crypto" | "info"> & {
  crypto: { confirmed_at: string | null } | null;
  info: Pick<DeviceInfo, "ts_hostname" | "os_version">;
};

export const PatchDeviceSchema = v.pipe(
  v.strictObject({
    tags: v.optional(TagsSchema),
    archived_at: v.optional(v.null()),
    crypto: v.optional(v.nullable(CryptoKeyOnlySchema)),
  }),
  v.check((p) => p.tags !== undefined || p.archived_at !== undefined || p.crypto !== undefined, "tags, archived_at or crypto is required"),
);
export type PatchDevice = v.InferOutput<typeof PatchDeviceSchema>;

export const CreateInviteSchema = v.strictObject({ tags: TagsSchema, encrypt: v.optional(v.boolean(), false), note: v.optional(v.string()) });
