import * as v from "valibot";

// 登録簿 (devices.json) と招待 (invites.json) の形。手で直せる JSON なので読み込み時に必ず通す。

export const TagsSchema = v.record(v.string(), v.string());
export type Tags = v.InferOutput<typeof TagsSchema>;

export const DeviceRecordSchema = v.object({
  device_token: v.string(),
  registered_at: v.string(),
  archived_at: v.nullable(v.string()),
  tags: TagsSchema,
});
export type DeviceRecord = v.InferOutput<typeof DeviceRecordSchema>;

export const DevicesSchema = v.record(v.string(), DeviceRecordSchema);
export type Devices = v.InferOutput<typeof DevicesSchema>;

export const InviteRecordSchema = v.object({
  tags: TagsSchema,
  created_at: v.string(),
  used_by: v.nullable(v.string()),
});
export type InviteRecord = v.InferOutput<typeof InviteRecordSchema>;

export const InvitesSchema = v.record(v.string(), InviteRecordSchema);
export type Invites = v.InferOutput<typeof InvitesSchema>;

// API で外に出す 1 device の形 (キーだった device_id を中に持つ)
export type DeviceView = { device_id: string } & DeviceRecord;

export const PatchDeviceSchema = v.pipe(
  v.strictObject({
    tags: v.optional(TagsSchema),
    archived_at: v.optional(v.null()),
  }),
  v.check((p) => p.tags !== undefined || p.archived_at !== undefined, "tags or archived_at is required"),
);
export type PatchDevice = v.InferOutput<typeof PatchDeviceSchema>;

export const CreateInviteSchema = v.strictObject({ tags: TagsSchema });
