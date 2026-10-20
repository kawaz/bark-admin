import * as v from "valibot";
import { parseJsonWith } from "./parse.ts";
import type { PushParams } from "./schema/push-params.ts";

// bark-server (upstream) との通信。応答の形は bark-server v2.3.9 の route_register.go / route_push.go で確認した。

// 一律の応答: {code, message, timestamp, data?}。register の data は {key, device_key, device_token}
export const RegisterResponseSchema = v.looseObject({
  code: v.number(),
  data: v.looseObject({ device_key: v.string(), device_token: v.string() }),
});

// device_keys で送った時の data は device ごとの結果の配列 (失敗時だけ message が付く)
const BatchPushResponseSchema = v.looseObject({
  code: v.number(),
  message: v.optional(v.string()),
  data: v.optional(
    v.array(
      v.looseObject({
        device_key: v.string(),
        code: v.number(),
        message: v.optional(v.string()),
      }),
    ),
  ),
});

export type Upstream = { status: number; contentType: string | null; body: string };

export class UpstreamError extends Error {}

export class BarkServer {
  constructor(readonly baseUrl: string) {}

  // method / path+query / body をそのまま bark-server に渡し、応答を丸ごと返す
  async forward(
    method: string,
    pathAndQuery: string,
    contentType: string | null,
    body: ArrayBuffer | string | null,
  ): Promise<Upstream> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${pathAndQuery}`, {
        method,
        headers: contentType === null ? {} : { "content-type": contentType },
        // GET / HEAD に body は付けられない。空 body も付けない
        ...(body === null || method === "GET" || method === "HEAD" || (typeof body !== "string" && body.byteLength === 0) ? {} : { body }),
      });
    } catch (e) {
      throw new UpstreamError(`bark-server ${this.baseUrl} unreachable: ${e instanceof Error ? e.message : "fetch failed"}`);
    }
    return { status: res.status, contentType: res.headers.get("content-type"), body: await res.text() };
  }

  async pushBatch(
    params: PushParams,
    deviceKeys: string[],
  ): Promise<{ ok: true; results: { device_id: string; status: number; message?: string }[] } | { ok: false; status: number; message: string }> {
    const up = await this.forward(
      "POST",
      "/push",
      "application/json; charset=utf-8",
      JSON.stringify({ ...params, device_keys: deviceKeys }),
    );
    const r = parseJsonWith(BatchPushResponseSchema, up.body);
    if (!r.ok) return { ok: false, status: up.status, message: `unexpected bark-server response: ${r.error.message}` };
    if (up.status !== 200 || r.value.data === undefined) {
      return { ok: false, status: up.status, message: r.value.message ?? `bark-server returned ${up.status}` };
    }
    return {
      ok: true,
      results: r.value.data.map((d) => ({
        device_id: d.device_key,
        status: d.code,
        ...(d.message !== undefined ? { message: d.message } : {}),
      })),
    };
  }
}
