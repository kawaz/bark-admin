import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { createApp } from "../src/app.ts";
import { BarkServer } from "../src/bark-server.ts";
import { parseJsonWith } from "../src/parse.ts";
import { openStore, type Store } from "../src/store.ts";

// 偽 bark-server: 届いた要求を記録し、bark-server v2.3.9 と同じ形で応答する
type Received = { method: string; path: string; search: string; body: string };
const received: Received[] = [];
const BodySchema = v.looseObject({ device_keys: v.optional(v.array(v.string())) });

const fakeBark = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = await req.text();
    received.push({ method: req.method, path: url.pathname, search: url.search, body });
    const ts = 1;
    if (url.pathname === "/ping") return Response.json({ code: 200, message: "pong", timestamp: ts });
    if (url.pathname === "/register") {
      const token = url.searchParams.get("devicetoken") ?? "";
      if (token === "") return Response.json({ code: 400, message: "device token is empty", timestamp: ts }, { status: 400 });
      const key = url.searchParams.get("key") || "NEWKEY";
      return Response.json({ code: 200, message: "success", data: { key, device_key: key, device_token: token }, timestamp: ts });
    }
    if (url.pathname === "/push") {
      const r = parseJsonWith(BodySchema, body);
      const keys = r.ok ? (r.value.device_keys ?? []) : [];
      if (keys.length === 0) return Response.json({ code: 200, message: "success", timestamp: ts });
      return Response.json({
        code: 200,
        message: "success",
        data: keys.map((k) => (k === "BAD" ? { device_key: k, code: 400, message: "failed to get device token" } : { device_key: k, code: 200 })),
        timestamp: ts,
      });
    }
    return new Response("not found", { status: 404 });
  },
});

let dir: string;
let store: Store;
let server: ReturnType<typeof Bun.serve>;
let base: string;

afterAll(() => {
  fakeBark.stop(true);
});

beforeEach(async () => {
  received.length = 0;
  dir = await mkdtemp(join(tmpdir(), "bark-admin-app-"));
  store = openStore(join(dir, "devices.json"));
  await store.devices.update(() => ({
    next: {
      A: { device_token: "ta", registered_at: "t0", archived_at: null, tags: { owner: "kawaz", name: "iphone" } },
      B: { device_token: "tb", registered_at: "t0", archived_at: null, tags: { owner: "kawaz", name: "ipad" } },
      C: { device_token: "tc", registered_at: "t0", archived_at: null, tags: { owner: "other" } },
      D: { device_token: "td", registered_at: "t0", archived_at: "t1", tags: { owner: "kawaz", name: "old" } },
    },
    result: null,
  }));
  const app = createApp({ serverUrl: "https://bark.example", store, bark: new BarkServer(fakeBark.url.origin), now: () => "NOW" });
  server = Bun.serve({ port: 0, routes: app.routes, fetch: app.fetch });
  base = server.url.origin;
});
afterEach(async () => {
  server.stop(true);
  await rm(dir, { recursive: true, force: true });
});

function post(path: string, body: unknown, method = "POST") {
  return fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function pushedKeys(): string[][] {
  return received
    .filter((r) => r.path === "/push")
    .map((r) => {
      const p = parseJsonWith(BodySchema, r.body);
      return p.ok ? (p.value.device_keys ?? []) : [];
    });
}

describe("POST /push", () => {
  test("device filter resolves active devices and sends one batch with device_keys", async () => {
    const res = await post("/push", { device: { owner: "kawaz" }, title: "t", body: "b" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: [{ device_id: "A", status: 200 }, { device_id: "B", status: 200 }], skipped: 1 });
    expect(pushedKeys()).toEqual([["A", "B"]]);
    const sent = received.find((r) => r.path === "/push");
    expect(sent && JSON.parse(sent.body)).toEqual({ title: "t", body: "b", device_keys: ["A", "B"] });
  });

  test("filter is AND of exact matches", async () => {
    await post("/push", { device: { owner: "kawaz", name: "ipad" }, body: "b" });
    expect(pushedKeys()).toEqual([["B"]]);
  });

  test("no device filter = all active devices", async () => {
    await post("/push", { body: "b" });
    expect(pushedKeys()).toEqual([["A", "B", "C"]]);
  });

  test("no match returns 404 without calling bark-server", async () => {
    const res = await post("/push", { device: { owner: "nobody" }, body: "b" });
    expect(res.status).toBe(404);
    expect(received).toHaveLength(0);
  });

  test("per-device failure is reported in sent", async () => {
    await store.devices.update((cur) => ({ next: { ...cur, BAD: { device_token: "x", registered_at: "t0", archived_at: null, tags: { owner: "z" } } }, result: null }));
    const res = await post("/push", { device: { owner: "z" }, body: "b" });
    expect(await res.json()).toEqual({ sent: [{ device_id: "BAD", status: 400, message: "failed to get device token" }], skipped: 0 });
  });

  test("device_key is passed through as-is with the bark-server response", async () => {
    const res = await post("/push", { device_key: "ZZZ", body: "b" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ code: 200, message: "success", timestamp: 1 });
    const sent = received.find((r) => r.path === "/push");
    expect(sent && JSON.parse(sent.body)).toEqual({ body: "b", device_key: "ZZZ" });
  });

  test("device_keys is passed through as-is", async () => {
    await post("/push", { device_keys: ["X", "Y"], body: "b" });
    expect(pushedKeys()).toEqual([["X", "Y"]]);
  });

  test("device and device_key together is rejected", async () => {
    expect((await post("/push", { device: { owner: "kawaz" }, device_key: "X" })).status).toBe(400);
  });

  test("invalid params are rejected before bark-server", async () => {
    const res = await post("/push", { body: "b", level: "loud" });
    expect(res.status).toBe(400);
    expect(received).toHaveLength(0);
  });
});

describe("devices API", () => {
  test("GET /api/devices is jsonl of active devices, filterable, archived=1 includes archived", async () => {
    const IdSchema = v.object({ device_id: v.string() });
    const ids = async (q: string) => {
      const res = await fetch(`${base}/api/devices${q}`);
      expect(res.headers.get("content-type")).toContain("application/jsonl");
      return (await res.text())
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => {
          const r = parseJsonWith(IdSchema, l);
          return r.ok ? r.value.device_id : r.error.message;
        });
    };
    expect(await ids("")).toEqual(["A", "B", "C"]);
    expect(await ids("?owner=kawaz")).toEqual(["A", "B"]);
    expect(await ids("?owner=kawaz&archived=1")).toEqual(["A", "B", "D"]);
  });

  test("PATCH replaces tags, DELETE archives, PATCH archived_at null restores", async () => {
    expect(await (await post("/api/devices/A", { tags: { owner: "x" } }, "PATCH")).json()).toMatchObject({ device_id: "A", tags: { owner: "x" } });
    expect(await (await fetch(`${base}/api/devices/A`, { method: "DELETE" })).json()).toMatchObject({ archived_at: "NOW" });
    expect((await store.devices.read())["A"]?.archived_at).toBe("NOW");
    expect(await (await post("/api/devices/A", { archived_at: null }, "PATCH")).json()).toMatchObject({ archived_at: null });
  });

  test("unknown device is 404", async () => {
    expect((await fetch(`${base}/api/devices/NOPE`)).status).toBe(404);
    expect((await fetch(`${base}/api/devices/NOPE`, { method: "DELETE" })).status).toBe(404);
  });
});

describe("register via invite", () => {
  async function invite(tags: Record<string, string>) {
    const res = await post("/api/invites", { tags });
    expect(res.status).toBe(201);
    return v.parse(v.object({ invite: v.string(), add_url: v.string(), addserver_url: v.string() }), await res.json());
  }

  test("invite URLs embed the invite in the server address", async () => {
    const inv = await invite({ owner: "kawaz" });
    expect(inv.add_url).toBe(`https://bark.example/add/${inv.invite}`);
    expect(inv.addserver_url).toBe(`bark://addserver?address=https://bark.example/r/${inv.invite}`);
    const page = await (await fetch(`${base}/add/${inv.invite}`)).text();
    expect(page).toContain(`bark://addserver?address=https://bark.example/r/${inv.invite}`);
    expect(page).toContain("https://apps.apple.com/app/bark-custom-notifications/id1403753865");
    const qr = await fetch(`${base}/api/invites/${inv.invite}/qr.svg`);
    expect(qr.headers.get("content-type")).toBe("image/svg+xml");
  });

  test("register is forwarded to bark-server and upserts the device with the invite tags, once", async () => {
    const inv = await invite({ owner: "kawaz", name: "new" });
    expect((await fetch(`${base}/r/${inv.invite}/ping`)).status).toBe(200);
    const res = await fetch(`${base}/r/${inv.invite}/register?devicetoken=tok&key=`);
    expect(res.status).toBe(200);
    expect(received.at(-1)).toMatchObject({ method: "GET", path: "/register", search: "?devicetoken=tok&key=" });
    expect((await store.devices.read())["NEWKEY"]).toEqual({ device_token: "tok", registered_at: "NOW", archived_at: null, tags: { owner: "kawaz", name: "new" } });
    expect((await store.invites.read())[inv.invite]?.used_by).toBe("NEWKEY");

    // 使った本人の再登録 (アプリ起動時) は通り、token だけ更新される
    expect((await fetch(`${base}/r/${inv.invite}/register?devicetoken=tok2&key=NEWKEY`)).status).toBe(200);
    expect((await store.devices.read())["NEWKEY"]?.device_token).toBe("tok2");

    // 別の端末は使用済み招待で登録できない
    const before = received.length;
    expect((await fetch(`${base}/r/${inv.invite}/register?devicetoken=other&key=`)).status).toBe(410);
    expect(received).toHaveLength(before);
  });

  test("unknown invite is 404 for ping, register and the add page", async () => {
    expect((await fetch(`${base}/r/nope/ping`)).status).toBe(404);
    expect((await fetch(`${base}/r/nope/register?devicetoken=t&key=`)).status).toBe(404);
    expect((await fetch(`${base}/add/nope`)).status).toBe(404);
    expect(received).toHaveLength(0);
  });

  test("plain /register adds an untagged device; existing key keeps its tags", async () => {
    await fetch(`${base}/register?devicetoken=t1&key=`);
    expect((await store.devices.read())["NEWKEY"]?.tags).toEqual({});
    await fetch(`${base}/register?devicetoken=t9&key=A`);
    expect((await store.devices.read())["A"]).toEqual({ device_token: "t9", registered_at: "t0", archived_at: null, tags: { owner: "kawaz", name: "iphone" } });
  });

  test("bark-server errors are passed through without touching the registry", async () => {
    const res = await fetch(`${base}/register?devicetoken=&key=`);
    expect(res.status).toBe(400);
    expect(Object.keys(await store.devices.read())).toEqual(["A", "B", "C", "D"]);
  });
});

describe("routing", () => {
  test("bark URL form /<key>/<body> is not forwarded", async () => {
    expect((await fetch(`${base}/A/hello`)).status).toBe(404);
    expect(received).toHaveLength(0);
  });

  test("schema endpoint and pages are served", async () => {
    expect((await (await fetch(`${base}/api/schema`)).text())).toContain('"name":"title"');
    expect((await fetch(`${base}/`)).headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${base}/devices/A`)).headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${base}/assets/index.js`)).status).toBe(200);
  });
});
