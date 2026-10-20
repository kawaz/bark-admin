import * as v from "valibot";

// 外部から来る値 (HTTP body / JSON ファイル / TOML / bark-server の応答) を型付きにする境界。
// unknown はこのファイルの中だけで扱う。

export type ParseError = { kind: "invalid-syntax" | "invalid-shape"; message: string };
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: ParseError };

export function parseWith<S extends v.GenericSchema>(schema: S, raw: unknown): Parsed<v.InferOutput<S>> {
  const r = v.safeParse(schema, raw);
  return r.success
    ? { ok: true, value: r.output }
    : { ok: false, error: { kind: "invalid-shape", message: v.summarize(r.issues) } };
}

export function parseJsonWith<S extends v.GenericSchema>(schema: S, text: string): Parsed<v.InferOutput<S>> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: { kind: "invalid-syntax", message: e instanceof Error ? e.message : "JSON.parse failed" } };
  }
  return parseWith(schema, raw);
}

export function parseTomlWith<S extends v.GenericSchema>(schema: S, text: string): Parsed<v.InferOutput<S>> {
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(text);
  } catch (e) {
    return { ok: false, error: { kind: "invalid-syntax", message: e instanceof Error ? e.message : "TOML parse failed" } };
  }
  return parseWith(schema, raw);
}
