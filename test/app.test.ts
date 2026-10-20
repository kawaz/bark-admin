import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { createApp } from "../src/app.ts";
import { BarkServer } from "../src/bark-server.ts";
import { parseJsonWith } from "../src/parse.ts";
import { openStore, type Store } from "../src/store.ts";
import { nodeDecrypt } from "./node-aes-gcm.ts";

// 偽 bark-server: 届いた要求を記録し、bark-server v2.3.9 と同じ形で応答する
type Received = { method: string; path: string; search: string; body: string };
const received: Received[] = [];
const BodySchema = v.looseObject({ device_keys: v.optional(v.array(v.string())) });
const SealedBodySchema = v.strictObject({ device_key: v.string(), ciphertext: v.string(), iv: v.string() });

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
      // device_key 1 台の送信: 失敗は HTTP status と code が同じ値になる
      if (keys.length === 0) {
        if (body.includes('"device_key":"BADENC"')) return Response.json({ code: 400, message: "failed to get device token", timestamp: ts }, { status: 400 });
        return Response.json({ code: 200, message: "success", timestamp: ts });
      }
      return Response.json({
        code: 200,
        message: "success",
        data: keys.map((k) => (k === "BAD" ? { device_key: k, code: 400, message: "failed to get device token" } : { device_key: k, code: 200 })),
        timestamp: ts,
      });
    }
    return Response.json({ code: 200, message: "echo", timestamp: ts }, { headers: { "x-fake": "1" } });
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
      A: { device_token: "ta", registered_at: "t0", archived_at: null, tags: { owner: "kawaz", name: "iphone" }, crypto: null },
      B: { device_token: "tb", registered_at: "t0", archived_at: null, tags: { owner: "kawaz", name: "ipad" }, crypto: null },
      C: { device_token: "tc", registered_at: "t0", archived_at: null, tags: { owner: "other" }, crypto: null },
      D: { device_token: "td", registered_at: "t0", archived_at: "t1", tags: { owner: "kawaz", name: "old" }, crypto: null },
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

const KEY_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const KEY_B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

async function setCrypto(id: string, key: string) {
  await store.devices.update((cur) => {
    const rec = cur[id];
    return rec === undefined ? { result: null } : { next: { ...cur, [id]: { ...rec, crypto: { key, confirmed_at: null, pending_nonce: null } } }, result: null };
  });
}

// device_key 1 台で届いた暗号化の送信
function sealedPushes() {
  return received.filter((r) => r.path === "/push").flatMap((r) => {
    const p = parseJsonWith(SealedBodySchema, r.body);
    return p.ok ? [p.value] : [];
  });
}

function pushedKeys(): string[][] {
  return received
    .filter((r) => r.path === "/push")
    .map((r) => {
      const p = parseJsonWith(BodySchema, r.body);
      return p.ok ? (p.value.device_keys ?? []) : [];
    });
}

describe("POST /bark-admin/push", () => {
  test("device filter resolves active devices and sends one batch with device_keys", async () => {
    const res = await post("/bark-admin/push", { device: { owner: "kawaz" }, title: "t", body: "b" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sent: [
        { device_id: "A", status: 200, encrypted: false },
        { device_id: "B", status: 200, encrypted: false },
      ],
      skipped: 1,
    });
    expect(pushedKeys()).toEqual([["A", "B"]]);
    const sent = received.find((r) => r.path === "/push");
    expect(sent && JSON.parse(sent.body)).toEqual({ title: "t", body: "b", device_keys: ["A", "B"] });
  });

  test("filter is AND of exact matches", async () => {
    await post("/bark-admin/push", { device: { owner: "kawaz", name: "ipad" }, body: "b" });
    expect(pushedKeys()).toEqual([["B"]]);
  });

  test("no device filter = all active devices", async () => {
    await post("/bark-admin/push", { body: "b" });
    expect(pushedKeys()).toEqual([["A", "B", "C"]]);
  });

  test("no match returns 404 without calling bark-server", async () => {
    const res = await post("/bark-admin/push", { device: { owner: "nobody" }, body: "b" });
    expect(res.status).toBe(404);
    expect(received).toHaveLength(0);
  });

  test("per-device failure is reported in sent", async () => {
    await store.devices.update((cur) => ({ next: { ...cur, BAD: { device_token: "x", registered_at: "t0", archived_at: null, tags: { owner: "z" }, crypto: null } }, result: null }));
    const res = await post("/bark-admin/push", { device: { owner: "z" }, body: "b" });
    expect(await res.json()).toEqual({ sent: [{ device_id: "BAD", status: 400, message: "failed to get device token", encrypted: false }], skipped: 0 });
  });

  test("device_key / device_keys are rejected (destinations are given by device)", async () => {
    expect((await post("/bark-admin/push", { device_key: "X", body: "b" })).status).toBe(400);
    expect((await post("/bark-admin/push", { device_keys: ["X"], body: "b" })).status).toBe(400);
    expect(received).toHaveLength(0);
  });

  test("invalid params are rejected before bark-server", async () => {
    const res = await post("/bark-admin/push", { body: "b", level: "loud" });
    expect(res.status).toBe(400);
    expect(received).toHaveLength(0);
  });
});

describe("POST /bark-admin/push to devices with a crypto key", () => {
  test("encrypted devices get {device_key, ciphertext, iv} one by one, the rest one batch", async () => {
    await setCrypto("A", KEY_A);
    await setCrypto("C", KEY_B);
    const res = await post("/bark-admin/push", { title: "t", body: "b", badge: 2 });
    expect(res.status).toBe(200);
    // 宛先の並び順で、暗号化したかどうかが付く
    expect(await res.json()).toEqual({
      sent: [
        { device_id: "A", status: 200, encrypted: true },
        { device_id: "B", status: 200, encrypted: false },
        { device_id: "C", status: 200, encrypted: true },
      ],
      skipped: 1,
    });
    expect(pushedKeys().filter((k) => k.length > 0)).toEqual([["B"]]);
    const sealed = sealedPushes().toSorted((x, y) => x.device_key.localeCompare(y.device_key));
    expect(sealed.map((p) => p.device_key)).toEqual(["A", "C"]);
    for (const [p, key] of [
      [sealed[0], KEY_A],
      [sealed[1], KEY_B],
    ] as const) {
      expect(p?.iv).toMatch(/^[A-Za-z0-9]{12}$/);
      // 平文は device / device_key を含まない bark パラメータ全体
      expect(p && JSON.parse(nodeDecrypt(key, p.iv, p.ciphertext))).toEqual({ title: "t", body: "b", badge: 2 });
    }
    expect(sealed[0]?.iv).not.toBe(sealed[1]?.iv);
  });

  test("only encrypted targets: bark-server gets no batch", async () => {
    await setCrypto("A", KEY_A);
    const res = await post("/bark-admin/push", { device: { name: "iphone" }, body: "b" });
    expect(await res.json()).toEqual({ sent: [{ device_id: "A", status: 200, encrypted: true }], skipped: 0 });
    expect(pushedKeys()).toEqual([[]]);
    expect(sealedPushes()).toHaveLength(1);
  });

  test("per-device failure of an encrypted push is reported", async () => {
    await store.devices.update((cur) => ({
      next: { ...cur, BADENC: { device_token: "x", registered_at: "t0", archived_at: null, tags: { owner: "z" }, crypto: { key: KEY_A, confirmed_at: null, pending_nonce: null } } },
      result: null,
    }));
    const res = await post("/bark-admin/push", { device: { owner: "z" }, body: "b" });
    expect(await res.json()).toEqual({ sent: [{ device_id: "BADENC", status: 400, message: "failed to get device token", encrypted: true }], skipped: 0 });
  });

  test("ciphertext / iv in the body are rejected", async () => {
    expect((await post("/bark-admin/push", { ciphertext: "x", body: "b" })).status).toBe(400);
    expect((await post("/bark-admin/push", { iv: "x", body: "b" })).status).toBe(400);
    expect(received).toHaveLength(0);
  });
});

describe("devices API", () => {
  test("GET /bark-admin/api/devices is jsonl of active devices, filterable, archived=1 includes archived", async () => {
    const IdSchema = v.object({ device_id: v.string() });
    const ids = async (q: string) => {
      const res = await fetch(`${base}/bark-admin/api/devices${q}`);
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
    expect(await (await post("/bark-admin/api/devices/A", { tags: { owner: "x" } }, "PATCH")).json()).toMatchObject({ device_id: "A", tags: { owner: "x" } });
    expect(await (await fetch(`${base}/bark-admin/api/devices/A`, { method: "DELETE" })).json()).toMatchObject({ archived_at: "NOW" });
    expect((await store.devices.read())["A"]?.archived_at).toBe("NOW");
    expect(await (await post("/bark-admin/api/devices/A", { archived_at: null }, "PATCH")).json()).toMatchObject({ archived_at: null });
  });

  test("the list shows only crypto.confirmed_at, the detail shows the key, neither shows the nonce", async () => {
    await setCrypto("A", KEY_A);
    await fetch(`${base}/bark-admin/api/devices/A/crypto/confirm`, { method: "POST" });
    const nonce = (await store.devices.read())["A"]?.crypto?.pending_nonce ?? "";
    expect(nonce).not.toBe("");
    const lines = (await (await fetch(`${base}/bark-admin/api/devices?name=iphone`)).text()).split("\n").filter((l) => l !== "");
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { device_id: "A", device_token: "ta", registered_at: "t0", archived_at: null, tags: { owner: "kawaz", name: "iphone" }, crypto: { confirmed_at: null } },
    ]);
    expect(lines.join("")).not.toContain(KEY_A);
    const detail = await (await fetch(`${base}/bark-admin/api/devices/A`)).text();
    expect(JSON.parse(detail)).toMatchObject({ crypto: { key: KEY_A, confirmed_at: null } });
    expect(detail).not.toContain(nonce);
    expect(await (await fetch(`${base}/bark-admin/api/devices/B`)).json()).toMatchObject({ crypto: null });
  });

  test("POST /crypto generates and stores a new key, PATCH sets or clears it", async () => {
    const CryptoView = v.object({ crypto: v.object({ key: v.string() }) });
    const first = v.parse(CryptoView, await (await fetch(`${base}/bark-admin/api/devices/A/crypto`, { method: "POST" })).json()).crypto.key;
    expect(first).toMatch(/^[A-Za-z0-9]{32}$/);
    expect((await store.devices.read())["A"]?.crypto).toEqual({ key: first, confirmed_at: null, pending_nonce: null });
    const second = v.parse(CryptoView, await (await fetch(`${base}/bark-admin/api/devices/A/crypto`, { method: "POST" })).json()).crypto.key;
    expect(second).not.toBe(first);

    expect(await (await post("/bark-admin/api/devices/A", { crypto: { key: KEY_B } }, "PATCH")).json()).toMatchObject({ crypto: { key: KEY_B } });
    expect(await (await post("/bark-admin/api/devices/A", { crypto: null }, "PATCH")).json()).toMatchObject({ crypto: null });
    expect((await fetch(`${base}/bark-admin/api/devices/NOPE/crypto`, { method: "POST" })).status).toBe(404);
  });

  test("confirm sends an encrypted notification whose url carries the nonce; only that nonce confirms, once", async () => {
    await setCrypto("A", KEY_A);
    const res = await fetch(`${base}/bark-admin/api/devices/A/crypto/confirm`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: { device_id: "A", status: 200, encrypted: true } });
    const nonce = (await store.devices.read())["A"]?.crypto?.pending_nonce ?? "";
    expect(nonce).toMatch(/^[A-Za-z0-9]{22}$/);

    // 確認通知は暗号化されていて、平文の url は bark-server に渡らない
    const [sealed] = sealedPushes();
    expect(sealed?.device_key).toBe("A");
    expect(received.at(-1)?.body).not.toContain(nonce);
    const url = `https://bark.example/bark-admin/api/devices/A/crypto/confirm/${nonce}`;
    expect(sealed && JSON.parse(nodeDecrypt(KEY_A, sealed.iv, sealed.ciphertext))).toEqual({
      title: "bark-admin 暗号化の確認",
      body: "この通知をタップすると確認が完了する",
      url,
    });

    // 違う nonce は 404 で状態を変えない
    const wrong = await fetch(`${base}/bark-admin/api/devices/A/crypto/confirm/WRONG${nonce.slice(5)}`);
    expect(wrong.status).toBe(404);
    expect((await store.devices.read())["A"]?.crypto).toEqual({ key: KEY_A, confirmed_at: null, pending_nonce: nonce });

    const ok = await fetch(`${base}/bark-admin/api/devices/A/crypto/confirm/${nonce}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/html");
    expect(await ok.text()).toContain("暗号化を確認できた");
    expect((await store.devices.read())["A"]?.crypto).toEqual({ key: KEY_A, confirmed_at: "NOW", pending_nonce: null });
    expect(await (await fetch(`${base}/bark-admin/api/devices/A`)).json()).toMatchObject({ crypto: { key: KEY_A, confirmed_at: "NOW" } });

    // 同じ URL は 2 回目は効かない
    expect((await fetch(`${base}/bark-admin/api/devices/A/crypto/confirm/${nonce}`)).status).toBe(404);

    // 鍵を作り直すと未確認に戻る
    await fetch(`${base}/bark-admin/api/devices/A/crypto`, { method: "POST" });
    expect((await store.devices.read())["A"]?.crypto?.confirmed_at).toBeNull();
  });

  test("confirm needs a key (409) and an existing device (404); a newer confirm replaces the nonce", async () => {
    expect((await fetch(`${base}/bark-admin/api/devices/B/crypto/confirm`, { method: "POST" })).status).toBe(409);
    expect((await fetch(`${base}/bark-admin/api/devices/NOPE/crypto/confirm`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${base}/bark-admin/api/devices/B/crypto/confirm/anything`)).status).toBe(404);
    expect(received).toHaveLength(0);

    await setCrypto("A", KEY_A);
    await fetch(`${base}/bark-admin/api/devices/A/crypto/confirm`, { method: "POST" });
    const first = (await store.devices.read())["A"]?.crypto?.pending_nonce ?? "";
    await fetch(`${base}/bark-admin/api/devices/A/crypto/confirm`, { method: "POST" });
    expect((await fetch(`${base}/bark-admin/api/devices/A/crypto/confirm/${first}`)).status).toBe(404);
  });

  test.each([
    ["too short", "abc"],
    ["33 characters", `${KEY_A}A`],
    ["not alphanumeric", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-"],
  ])("PATCH rejects a crypto key that is %s", async (_, key) => {
    expect((await post("/bark-admin/api/devices/A", { crypto: { key } }, "PATCH")).status).toBe(400);
    expect((await store.devices.read())["A"]?.crypto).toBeNull();
  });

  test("unknown device is 404", async () => {
    expect((await fetch(`${base}/bark-admin/api/devices/NOPE`)).status).toBe(404);
    expect((await fetch(`${base}/bark-admin/api/devices/NOPE`, { method: "DELETE" })).status).toBe(404);
  });
});

describe("register via invite", () => {
  async function invite(tags: Record<string, string>, encrypt?: boolean) {
    const res = await post("/bark-admin/api/invites", { tags, ...(encrypt === undefined ? {} : { encrypt }) });
    expect(res.status).toBe(201);
    return v.parse(
      v.object({ invite: v.string(), add_url: v.string(), addserver_url: v.string(), crypto: v.nullable(v.object({ key: v.string() })) }),
      await res.json(),
    );
  }

  test("encrypt: true puts a key on the invite, shows it on the add page and copies it to the registered device", async () => {
    const inv = await invite({ name: "enc" }, true);
    const key = inv.crypto?.key ?? "";
    expect(key).toMatch(/^[A-Za-z0-9]{32}$/);
    expect((await store.invites.read())[inv.invite]?.crypto).toEqual({ key });
    const page = await (await fetch(`${base}/bark-admin/add/${inv.invite}`)).text();
    expect(page).toContain("暗号化キー");
    expect(page).toContain(key);

    await fetch(`${base}/r/${inv.invite}/register?devicetoken=tok&key=`);
    expect((await store.devices.read())["NEWKEY"]?.crypto).toEqual({ key, confirmed_at: null, pending_nonce: null });
    // 使用済みの招待ページには鍵を出さない
    expect(await (await fetch(`${base}/bark-admin/add/${inv.invite}`)).text()).not.toContain(key);
  });

  test("without encrypt the invite has no key and the add page has no key section", async () => {
    const inv = await invite({ name: "plain" });
    expect(inv.crypto).toBeNull();
    expect(await (await fetch(`${base}/bark-admin/add/${inv.invite}`)).text()).not.toContain("暗号化キー");
    await fetch(`${base}/r/${inv.invite}/register?devicetoken=tok&key=`);
    expect((await store.devices.read())["NEWKEY"]?.crypto).toBeNull();
  });

  test("invite URLs embed the invite in the server address", async () => {
    const inv = await invite({ owner: "kawaz" });
    expect(inv.add_url).toBe(`https://bark.example/bark-admin/add/${inv.invite}`);
    expect(inv.addserver_url).toBe(`bark://addserver?address=https://bark.example/r/${inv.invite}`);
    const page = await (await fetch(`${base}/bark-admin/add/${inv.invite}`)).text();
    expect(page).toContain(`bark://addserver?address=https://bark.example/r/${inv.invite}`);
    expect(page).toContain("https://apps.apple.com/app/bark-custom-notifications/id1403753865");
    const qr = await fetch(`${base}/bark-admin/api/invites/${inv.invite}/qr.svg`);
    expect(qr.headers.get("content-type")).toBe("image/svg+xml");
  });

  test("register is forwarded to bark-server and upserts the device with the invite tags, once", async () => {
    const inv = await invite({ owner: "kawaz", name: "new" });
    expect((await fetch(`${base}/r/${inv.invite}/ping`)).status).toBe(200);
    const res = await fetch(`${base}/r/${inv.invite}/register?devicetoken=tok&key=`);
    expect(res.status).toBe(200);
    expect(received.at(-1)).toMatchObject({ method: "GET", path: "/register", search: "?devicetoken=tok&key=" });
    expect((await store.devices.read())["NEWKEY"]).toEqual({ device_token: "tok", registered_at: "NOW", archived_at: null, tags: { owner: "kawaz", name: "new" }, crypto: null });
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
    expect((await fetch(`${base}/bark-admin/add/nope`)).status).toBe(404);
    expect(received).toHaveLength(0);
  });

  test("plain /register adds an untagged device; existing key keeps its tags", async () => {
    await fetch(`${base}/register?devicetoken=t1&key=`);
    expect((await store.devices.read())["NEWKEY"]?.tags).toEqual({});
    await fetch(`${base}/register?devicetoken=t9&key=A`);
    expect((await store.devices.read())["A"]).toEqual({ device_token: "t9", registered_at: "t0", archived_at: null, tags: { owner: "kawaz", name: "iphone" }, crypto: null });
  });

  test("bark-server errors are passed through without touching the registry", async () => {
    const res = await fetch(`${base}/register?devicetoken=&key=`);
    expect(res.status).toBe(400);
    expect(Object.keys(await store.devices.read())).toEqual(["A", "B", "C", "D"]);
  });
});

describe("bark-server compatible surface (root)", () => {
  test("/push is passed through as-is, device is not interpreted", async () => {
    const res = await post("/push", { device: { owner: "kawaz" }, device_key: "ZZZ", body: "b" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ code: 200, message: "success", timestamp: 1 });
    const sent = received.find((r) => r.path === "/push");
    expect(sent && JSON.parse(sent.body)).toEqual({ device: { owner: "kawaz" }, device_key: "ZZZ", body: "b" });
  });

  test("any other bark-server endpoint (URL form, /info, query) is passed through", async () => {
    expect((await fetch(`${base}/A/hello?sound=x`)).status).toBe(200);
    expect((await fetch(`${base}/info`)).status).toBe(200);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect(received.map((r) => `${r.method} ${r.path}${r.search}`)).toEqual(["GET /A/hello?sound=x", "GET /info", "GET /healthz"]);
  });

  test("/r/<invite>/* strips the prefix", async () => {
    const inv = await (await post("/bark-admin/api/invites", { tags: {} })).text();
    const id = v.parse(v.object({ invite: v.string() }), JSON.parse(inv)).invite;
    await post(`/r/${id}/push`, { device_key: "X", body: "b" });
    await fetch(`${base}/r/${id}`);
    expect(received.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /push", "GET /"]);
  });
});

describe("routing", () => {
  test("/ and /bark-admin redirect to /bark-admin/", async () => {
    for (const p of ["/", "/bark-admin"]) {
      const res = await fetch(`${base}${p}`, { redirect: "manual" });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/bark-admin/");
    }
  });

  test("unknown path under /bark-admin/ is 404, not forwarded", async () => {
    expect((await fetch(`${base}/bark-admin/nope`)).status).toBe(404);
    expect(received).toHaveLength(0);
  });

  test("schema endpoint and pages are served under /bark-admin/", async () => {
    expect(await (await fetch(`${base}/bark-admin/api/schema`)).text()).toContain('"name":"title"');
    expect((await fetch(`${base}/bark-admin/`)).headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${base}/bark-admin/devices/A`)).headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${base}/bark-admin/assets/index.js`)).status).toBe(200);
  });
});
