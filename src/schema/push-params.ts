import * as v from "valibot";

// bark V2 の通知パラメータの正本。`/push` の検証 (pushParamsSchema) と
// TOP のテストフォーム生成 (GET /api/schema が返す pushParamFields) の両方がここから導かれる。
// 出典: bark-server docs/API_V2.md と Bark docs/en-us/params.md。

type FieldBase = { name: string; group: FieldGroup; description: string };
export type FieldGroup = "content" | "display" | "alert" | "action" | "encryption" | "archive";
export type FieldSpec =
  | (FieldBase & { kind: "text" | "textarea" | "url" })
  | (FieldBase & { kind: "integer"; min: number })
  // 値が "1" のときだけ意味を持つスイッチ
  | (FieldBase & { kind: "flag" })
  | (FieldBase & { kind: "enum"; values: readonly string[] });

export const pushParamFields: readonly FieldSpec[] = [
  { name: "title", kind: "text", group: "content", description: "Push title, shown on the first line" },
  { name: "subtitle", kind: "text", group: "content", description: "Smaller line between title and body" },
  { name: "body", kind: "textarea", group: "content", description: "Push content" },
  { name: "markdown", kind: "textarea", group: "content", description: "Body with basic Markdown. body is ignored when set" },
  { name: "group", kind: "text", group: "display", description: "Message group in Notification Center and history" },
  { name: "icon", kind: "url", group: "display", description: "Icon image URL (iOS 15+)" },
  { name: "image", kind: "url", group: "display", description: "Image URL shown when expanded" },
  { name: "badge", kind: "integer", min: 0, group: "display", description: "App icon badge number. 0 clears it" },
  {
    name: "level",
    kind: "enum",
    values: ["active", "timeSensitive", "passive", "critical"],
    group: "alert",
    description: "Interruption level. critical rings in silent mode",
  },
  {
    name: "volume",
    kind: "enum",
    values: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
    group: "alert",
    description: "Critical alert volume (level=critical only), default 5",
  },
  { name: "call", kind: "flag", group: "alert", description: "Repeat the ringtone for 30 seconds" },
  { name: "sound", kind: "text", group: "alert", description: "Ringtone name, e.g. minuet" },
  { name: "copy", kind: "text", group: "action", description: "Text to copy instead of body" },
  { name: "autoCopy", kind: "flag", group: "action", description: "Copy automatically on arrival" },
  { name: "url", kind: "url", group: "action", description: "URL (or URL scheme) opened on tap" },
  { name: "action", kind: "enum", values: ["alert", "none"], group: "action", description: "alert: action popup / none: open the app only" },
  { name: "ciphertext", kind: "text", group: "encryption", description: "Encrypted push payload" },
  { name: "iv", kind: "text", group: "encryption", description: "IV used for the ciphertext" },
  // isArchive は 1 で保存、それ以外の値で保存しない (未指定はアプリ設定に従う) ので 0 も意味を持つ
  { name: "isArchive", kind: "enum", values: ["1", "0"], group: "archive", description: "1: save to history / 0: do not save" },
  { name: "ttl", kind: "integer", min: 1, group: "archive", description: "Seconds to keep the archived message" },
  { name: "id", kind: "text", group: "archive", description: "Notification id. Same id replaces the previous one" },
  { name: "delete", kind: "flag", group: "archive", description: "Delete the notification given by id" },
];

function fieldSchema(f: FieldSpec): v.GenericSchema<string | number> {
  switch (f.kind) {
    case "text":
    case "textarea":
      return v.string();
    case "url":
      return v.pipe(v.string(), v.url());
    case "integer":
      return v.pipe(v.number(), v.integer(), v.minValue(f.min));
    case "flag":
      return v.literal("1");
    case "enum":
      return v.picklist(f.values);
  }
}

export type PushParams = Record<string, string | number>;

// 未知のキーは拒否する (綴り間違いを bark-server が黙って ExtParams に流すのを防ぐ)
export const pushParamsSchema: v.GenericSchema<unknown, PushParams> = v.pipe(
  v.strictObject(Object.fromEntries(pushParamFields.map((f) => [f.name, v.optional(fieldSchema(f))]))),
  v.check((p) => p["delete"] === undefined || p["id"] !== undefined, "delete requires id"),
  v.transform((p) => {
    const out: PushParams = {};
    for (const [k, val] of Object.entries(p)) if (val !== undefined) out[k] = val;
    return out;
  }),
);
