import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { createApp } from "../src/app.ts";
import { BarkServer } from "../src/bark-server.ts";
import type { TailnetInfo } from "../src/device-info.ts";
import { parseJsonWith } from "../src/parse.ts";
import { REGISTRATION_TTL_MS } from "../src/invites.ts";
import { DeviceInfoSchema } from "../src/schema/registry.ts";
import { openStore, setAsideLegacyInvites, type Store } from "../src/store.ts";
import { localIso } from "../src/time.ts";
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
// 時計 (登録トークンの期限を進めて試す)。NOW はその時刻の登録簿での表記
const START = new Date("2026-10-20T12:00:00+09:00");
let clock = START;
const NOW = localIso(START);
// 偽 tailscale whois: 引かれた IP を記録し、whoisResult を返す
const whoisCalls: string[] = [];
let whoisResult: TailnetInfo = {};

afterAll(() => {
  fakeBark.stop(true);
});

beforeEach(async () => {
  received.length = 0;
  whoisCalls.length = 0;
  clock = START;
  whoisResult = {};
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
  const app = createApp({ serverUrl: "https://bark.example", store, bark: new BarkServer(fakeBark.url.origin),
    now: () => clock,
    whois: async (ip) => {
      whoisCalls.push(ip);
      return whoisResult;
    },
  });
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

  test("*v* is a substring match and * checks existence; archived matches are skipped", async () => {
    const res = await post("/bark-admin/push", { device: { name: "*i*" }, body: "b" });
    expect(await res.json()).toMatchObject({ sent: [{ device_id: "A" }, { device_id: "B" }], skipped: 0 });
    await post("/bark-admin/push", { device: { name: "*", owner: "kawaz" }, body: "b" });
    expect(pushedKeys().at(-1)).toEqual(["A", "B"]);
    // ip* は * を文字として完全一致するので当たらない
    expect((await post("/bark-admin/push", { device: { name: "ip*" }, body: "b" })).status).toBe(404);
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
    expect(await ids("?name=*phone*")).toEqual(["A"]);
    expect(await ids("?name=*")).toEqual(["A", "B"]);
    expect(await ids("?name=*&archived=1")).toEqual(["A", "B", "D"]);
    expect(await ids("?name=*pad")).toEqual([]);
  });

  test("PATCH replaces tags, DELETE archives, PATCH archived_at null restores", async () => {
    expect(await (await post("/bark-admin/api/devices/A", { tags: { owner: "x" } }, "PATCH")).json()).toMatchObject({ device_id: "A", tags: { owner: "x" } });
    expect(await (await fetch(`${base}/bark-admin/api/devices/A`, { method: "DELETE" })).json()).toMatchObject({ archived_at: NOW });
    expect((await store.devices.read())["A"]?.archived_at).toBe(NOW);
    expect(await (await post("/bark-admin/api/devices/A", { archived_at: null }, "PATCH")).json()).toMatchObject({ archived_at: null });
  });

  test("the list shows only crypto.confirmed_at, the detail shows the key, neither shows the nonce", async () => {
    await setCrypto("A", KEY_A);
    await fetch(`${base}/bark-admin/api/devices/A/confirm/crypto`, { method: "POST" });
    const nonce = (await store.devices.read())["A"]?.crypto?.pending_nonce ?? "";
    expect(nonce).not.toBe("");
    const lines = (await (await fetch(`${base}/bark-admin/api/devices?name=iphone`)).text()).split("\n").filter((l) => l !== "");
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { device_id: "A", registered_at: "t0", archived_at: null, tags: { owner: "kawaz", name: "iphone" }, crypto: { confirmed_at: null }, info: {}, delivery: { confirmed_at: null } },
    ]);
    expect(lines.join("")).not.toContain(KEY_A);
    const detail = await (await fetch(`${base}/bark-admin/api/devices/A`)).text();
    expect(JSON.parse(detail)).toMatchObject({ crypto: { key: KEY_A, confirmed_at: null } });
    // device_token は登録簿に残すが、詳細にも一覧にも出さない
    expect(detail).not.toContain("device_token");
    expect(lines.join("")).not.toContain("device_token");
    expect((await store.devices.read())["A"]?.device_token).toBe("ta");
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
    const res = await fetch(`${base}/bark-admin/api/devices/A/confirm/crypto`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: { device_id: "A", status: 200, encrypted: true } });
    const nonce = (await store.devices.read())["A"]?.crypto?.pending_nonce ?? "";
    expect(nonce).toMatch(/^[A-Za-z0-9]{22}$/);

    // 確認通知は暗号化されていて、平文の url は bark-server に渡らない
    const [sealed] = sealedPushes();
    expect(sealed?.device_key).toBe("A");
    expect(received.at(-1)?.body).not.toContain(nonce);
    const url = `https://bark.example/bark-admin/api/devices/A/confirm/crypto/${nonce}`;
    expect(sealed && JSON.parse(nodeDecrypt(KEY_A, sealed.iv, sealed.ciphertext))).toEqual({
      title: "bark-admin 暗号化の確認",
      body: "この通知をタップすると暗号化の確認が完了する\ndevice: A",
      url,
    });

    // 違う nonce は 404 で状態を変えない
    const wrong = await fetch(`${base}/bark-admin/api/devices/A/confirm/crypto/WRONG${nonce.slice(5)}`);
    expect(wrong.status).toBe(404);
    expect((await store.devices.read())["A"]?.crypto).toEqual({ key: KEY_A, confirmed_at: null, pending_nonce: nonce });

    const ok = await fetch(`${base}/bark-admin/api/devices/A/confirm/crypto/${nonce}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/html");
    const page = await ok.text();
    expect(page).toContain("暗号化を確認できた");
    expect(page).toContain("<code>A</code>");
    // 今回確認した暗号化の行を強調し、日時はその行に出す
    expect(page).toContain(`<dt class="changed">暗号化</dt><dd class="changed">有効・確認済み <time datetime="${NOW}">`);
    expect(page).toContain("<dt>受信確認</dt><dd>未確認</dd>");
    expect((await store.devices.read())["A"]?.crypto).toEqual({ key: KEY_A, confirmed_at: NOW, pending_nonce: null });
    expect(await (await fetch(`${base}/bark-admin/api/devices/A`)).json()).toMatchObject({ crypto: { key: KEY_A, confirmed_at: NOW } });

    // 同じ URL は 2 回目は効かない
    expect((await fetch(`${base}/bark-admin/api/devices/A/confirm/crypto/${nonce}`)).status).toBe(404);

    // 鍵を作り直すと未確認に戻る
    await fetch(`${base}/bark-admin/api/devices/A/crypto`, { method: "POST" });
    expect((await store.devices.read())["A"]?.crypto?.confirmed_at).toBeNull();
  });

  test("delivery confirm sends a plain notification whose url carries the nonce, even to a device with a key", async () => {
    await setCrypto("A", KEY_A);
    const res = await fetch(`${base}/bark-admin/api/devices/A/confirm/delivery`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: { device_id: "A", status: 200, encrypted: false } });
    const nonce = (await store.devices.read())["A"]?.delivery?.pending_nonce ?? "";
    expect(nonce).toMatch(/^[A-Za-z0-9]{22}$/);
    const push = received.at(-1);
    expect(push?.path).toBe("/push");
    expect(JSON.parse(push?.body ?? "")).toEqual({
      title: "bark-admin 受信の確認",
      body: "この通知をタップすると受信確認が完了する\ndevice: A",
      url: `https://bark.example/bark-admin/api/devices/A/confirm/delivery/${nonce}`,
      device_key: "A",
    });
    expect(await (await fetch(`${base}/bark-admin/api/devices/A`)).json()).toMatchObject({ delivery: { confirmed_at: null } });
    const ok = await fetch(`${base}/bark-admin/api/devices/A/confirm/delivery/${nonce}`);
    expect(ok.status).toBe(200);
    // 確認できたページは device_id (全文)・name / owner・kind と日時を出す (Bark のサーバー一覧の key と見比べる)
    const page = await ok.text();
    expect(page).toContain("受信を確認できた");
    expect(page).toContain("<code>A</code>");
    // 節は 端末 (固有フィールド) / タグ (チップ) / 端末情報 (あれば)。今回確認した受信確認の行を強調する
    expect(page).toContain('<h2 id="fields-heading">端末</h2>');
    expect(page).toContain('<h2 id="tags-heading">タグ</h2>');
    // 節ごとに「何が保存されているか」と「誰が書くか」の説明
    expect(page).toContain("登録簿が端末ごとに持つ固有の項目");
    expect(page).toContain("登録簿に保存、自由に直せる");
    expect(page).not.toContain("端末情報");
    expect(page).toContain('<li class="tag">owner=kawaz</li><li class="tag">name=iphone</li>');
    expect(page).toContain(`<dt>registered_at</dt><dd><time datetime="t0">`);
    expect(page).toContain(`<dt class="changed">受信確認</dt><dd class="changed">確認済み <time datetime="${NOW}">`);
    expect(page).toContain("<dt>暗号化</dt><dd>有効・未確認</dd>");
    expect(page).toContain('<a class="button open" href="/bark-admin/devices/A">この端末の設定を開く</a>');
    // 使用済みの確認リンクは 404 の HTML で、TOP へのリンクを置く
    const used = await fetch(`${base}/bark-admin/api/devices/A/confirm/delivery/${nonce}`);
    expect(used.status).toBe(404);
    expect(await used.text()).toContain('href="/bark-admin/"');
    expect((await store.devices.read())["A"]?.delivery).toEqual({ confirmed_at: NOW, pending_nonce: null });
    expect(await (await fetch(`${base}/bark-admin/api/devices/A`)).json()).toMatchObject({ delivery: { confirmed_at: NOW }, crypto: { confirmed_at: null } });
    const [line] = (await (await fetch(`${base}/bark-admin/api/devices?name=iphone`)).text()).split("\n");
    expect(JSON.parse(line ?? "")).toMatchObject({ delivery: { confirmed_at: NOW } });
    expect(line).not.toContain("pending_nonce");
  });

  test("the confirmed page shows the crypto row in 3 states and the device info section when there is info", async () => {
    const confirmPage = async (id: string) => {
      await fetch(`${base}/bark-admin/api/devices/${id}/confirm/delivery`, { method: "POST" });
      const nonce = (await store.devices.read())[id]?.delivery?.pending_nonce ?? "";
      return (await fetch(`${base}/bark-admin/api/devices/${id}/confirm/delivery/${nonce}`)).text();
    };
    // 無効
    expect(await confirmPage("B")).toContain("<dt>暗号化</dt><dd>無効</dd>");
    // 有効・未確認
    await setCrypto("B", KEY_B);
    expect(await confirmPage("B")).toContain("<dt>暗号化</dt><dd>有効・未確認</dd>");
    // 有効・確認済み (日時つき)
    await fetch(`${base}/bark-admin/api/devices/B/confirm/crypto`, { method: "POST" });
    const cn = (await store.devices.read())["B"]?.crypto?.pending_nonce ?? "";
    await fetch(`${base}/bark-admin/api/devices/B/confirm/crypto/${cn}`);
    expect(await confirmPage("B")).toContain(`<dt>暗号化</dt><dd>有効・確認済み <time datetime="${NOW}">`);
    // 端末情報 (os_version / ts_hostname) があれば節を出す
    await fetch(`${base}/register?devicetoken=tb2&key=B`, { headers: { "user-agent": "Bark/1.6.4 (me.fin.bark; build:8; iOS 26.7.1) Alamofire/5.10.2" } });
    const withInfo = await confirmPage("B");
    expect(withInfo).toContain('<h2 id="info-heading">端末情報</h2>');
    expect(withInfo).toContain("Bark アプリが登録するたびに上書きされる");
    expect(withInfo).toContain("<dt>os_version</dt><dd>iOS 26.7.1</dd>");
  });

  test("delivery and crypto confirms are independent: one kind's nonce does not confirm the other", async () => {
    await setCrypto("A", KEY_A);
    await fetch(`${base}/bark-admin/api/devices/A/confirm/delivery`, { method: "POST" });
    await fetch(`${base}/bark-admin/api/devices/A/confirm/crypto`, { method: "POST" });
    const rec = (await store.devices.read())["A"];
    const dn = rec?.delivery?.pending_nonce ?? "";
    const cn = rec?.crypto?.pending_nonce ?? "";
    expect(dn).not.toBe(cn);
    expect((await fetch(`${base}/bark-admin/api/devices/A/confirm/crypto/${dn}`)).status).toBe(404);
    expect((await fetch(`${base}/bark-admin/api/devices/A/confirm/delivery/${cn}`)).status).toBe(404);
    expect((await fetch(`${base}/bark-admin/api/devices/A/confirm/crypto/${cn}`)).status).toBe(200);
    const after = (await store.devices.read())["A"];
    expect(after?.crypto?.confirmed_at).toBe(NOW);
    expect(after?.delivery).toEqual({ confirmed_at: null, pending_nonce: dn });
    // delivery は鍵が無くても送れる。知らない kind は 404
    expect((await fetch(`${base}/bark-admin/api/devices/B/confirm/delivery`, { method: "POST" })).status).toBe(200);
    expect((await fetch(`${base}/bark-admin/api/devices/A/confirm/other`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${base}/bark-admin/api/devices/A/confirm/other/${dn}`)).status).toBe(404);
  });

  test("confirm needs a key (409) and an existing device (404); a newer confirm replaces the nonce", async () => {
    expect((await fetch(`${base}/bark-admin/api/devices/B/confirm/crypto`, { method: "POST" })).status).toBe(409);
    expect((await fetch(`${base}/bark-admin/api/devices/NOPE/confirm/crypto`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${base}/bark-admin/api/devices/B/confirm/crypto/anything`)).status).toBe(404);
    expect(received).toHaveLength(0);

    await setCrypto("A", KEY_A);
    await fetch(`${base}/bark-admin/api/devices/A/confirm/crypto`, { method: "POST" });
    const first = (await store.devices.read())["A"]?.crypto?.pending_nonce ?? "";
    await fetch(`${base}/bark-admin/api/devices/A/confirm/crypto`, { method: "POST" });
    expect((await fetch(`${base}/bark-admin/api/devices/A/confirm/crypto/${first}`)).status).toBe(404);
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

const InviteSchema = v.object({ invite: v.string(), add_url: v.string(), tags: v.record(v.string(), v.string()), encrypt: v.boolean(), note: v.optional(v.string()), created_at: v.string(), registered: v.number() });

async function createInvite(tags: Record<string, string>, opts: { encrypt?: boolean; note?: string } = {}) {
  const res = await post("/bark-admin/api/invites", { tags, ...opts });
  expect(res.status).toBe(201);
  return v.parse(InviteSchema, await res.json());
}

// 招待ページを開く (= 登録トークンを 1 つ発行する)。ページに出た /r/<token> と、そのトークンの鍵を返す
async function openAdd(invite: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/bark-admin/add/${invite}`, { headers });
  expect(res.status).toBe(200);
  const page = await res.text();
  const token = /bark:\/\/addserver\?address=https:\/\/bark\.example\/r\/([A-Za-z0-9_-]+)/.exec(page)?.[1] ?? "";
  expect(token).not.toBe("");
  // 鍵はページに出さないので登録簿から読む
  const key = (await store.registrations.read())[token]?.crypto?.key ?? null;
  return { token, key, page };
}

describe("invites and registration tokens", () => {
  test("an invite is reusable: each add page opening issues a new token (and a new key), two tokens register two devices", async () => {
    const inv = await createInvite({ owner: "kawaz", family: "kawazu" }, { encrypt: true, note: "for the family" });
    expect(inv).toMatchObject({ add_url: `https://bark.example/bark-admin/add/${inv.invite}`, encrypt: true, note: "for the family", registered: 0 });
    const first = await openAdd(inv.invite);
    const second = await openAdd(inv.invite);
    expect(first.token).not.toBe(second.token);
    expect(first.key).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(second.key).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(first.key).not.toBe(second.key);
    expect(first.page).toContain("暗号化キー");
    // 鍵の平文はページに出さない
    expect(first.page).not.toContain(first.key ?? "-");
    expect(first.page).toContain("••••••••");
    // 「すべて済んだ」で出す詳細ページへのリンクの置き場 (href は登録を見つけてから add.js が入れる)
    expect(first.page).toContain('<a id="device-link" class="button open" hidden>この端末の設定を開く</a>');
    expect((await store.registrations.read())[first.token]).toMatchObject({ invite: inv.invite, crypto: { key: first.key }, used_by: null, used_at: null });

    expect((await fetch(`${base}/r/${first.token}/register?devicetoken=t1&key=E1`)).status).toBe(200);
    expect((await fetch(`${base}/r/${second.token}/register?devicetoken=t2&key=E2`)).status).toBe(200);
    const devices = await store.devices.read();
    expect(devices["E1"]).toMatchObject({ tags: { owner: "kawaz", family: "kawazu" }, crypto: { key: first.key, confirmed_at: null } });
    expect(devices["E2"]).toMatchObject({ tags: { owner: "kawaz", family: "kawazu" }, crypto: { key: second.key, confirmed_at: null } });
    expect((await store.registrations.read())[first.token]).toMatchObject({ used_by: "E1", used_at: NOW });
    // 招待は使っても残り、一覧に登録数が出る
    const list = (await (await fetch(`${base}/bark-admin/api/invites`)).text()).split("\n").filter((l) => l !== "").map((l) => v.parse(InviteSchema, JSON.parse(l)));
    expect(list).toEqual([{ ...inv, registered: 2 }]);
  });

  test("without encrypt the token has no key and the add page has no key section", async () => {
    const inv = await createInvite({ name: "plain" });
    const { token, key, page } = await openAdd(inv.invite);
    expect(key).toBeNull();
    expect(page).not.toContain("暗号化キー");
    await fetch(`${base}/r/${token}/register?devicetoken=tok&key=`);
    expect((await store.devices.read())["NEWKEY"]?.crypto).toBeNull();
  });

  test("register via a token upserts the device with the invite tags; the same key re-registers, another key is 410", async () => {
    const inv = await createInvite({ owner: "kawaz", name: "new" });
    const { token } = await openAdd(inv.invite);
    expect((await fetch(`${base}/r/${token}/ping`)).status).toBe(200);
    const res = await fetch(`${base}/r/${token}/register?devicetoken=tok&key=`);
    expect(res.status).toBe(200);
    expect(received.at(-1)).toMatchObject({ method: "GET", path: "/register", search: "?devicetoken=tok&key=" });
    expect((await store.devices.read())["NEWKEY"]).toEqual({ device_token: "tok", registered_at: NOW, archived_at: null, tags: { owner: "kawaz", name: "new" }, crypto: null, info: { last_register_at: NOW, user_agent: expect.any(String) } });

    // 使った本人の再登録 (アプリ起動時) は期限を過ぎても通り、token だけ更新される
    clock = new Date(START.getTime() + REGISTRATION_TTL_MS + 1000);
    expect((await fetch(`${base}/r/${token}/register?devicetoken=tok2&key=NEWKEY`)).status).toBe(200);
    expect((await store.devices.read())["NEWKEY"]?.device_token).toBe("tok2");
    expect((await fetch(`${base}/r/${token}/ping`)).status).toBe(200);

    // 別の端末は使用済みトークンで登録できない
    const before = received.length;
    const gone = await fetch(`${base}/r/${token}/register?devicetoken=other&key=`);
    expect(gone.status).toBe(410);
    expect(await gone.json()).toMatchObject({ code: 410, message: expect.stringContaining("already used") });
    expect(received).toHaveLength(before);
  });

  test("an expired unused token is 410 for register and ping; opening the page again gives a fresh one", async () => {
    const inv = await createInvite({ name: "late" });
    const { token } = await openAdd(inv.invite);
    clock = new Date(START.getTime() + REGISTRATION_TTL_MS);
    for (const path of ["register?devicetoken=t&key=", "ping"]) {
      const res = await fetch(`${base}/r/${token}/${path}`);
      expect(res.status).toBe(410);
      expect(await res.json()).toMatchObject({ message: expect.stringContaining("expired") });
    }
    expect(received).toHaveLength(0);
    // 新しいトークンを発行するときに期限切れの未使用トークンは捨てる
    const fresh = await openAdd(inv.invite);
    expect(Object.keys(await store.registrations.read())).toEqual([fresh.token]);
    expect((await fetch(`${base}/r/${fresh.token}/register?devicetoken=t&key=`)).status).toBe(200);
  });

  test("a token copies its key to an existing device too (only when the token is used)", async () => {
    const inv = await createInvite({ room: "living" }, { encrypt: true });
    const { token, key } = await openAdd(inv.invite);
    await fetch(`${base}/r/${token}/register?devicetoken=ta2&key=A`);
    const a = (await store.devices.read())["A"];
    expect(key).not.toBeNull();
    expect(a?.crypto).toEqual({ key: key ?? "", confirmed_at: null, pending_nonce: null });
    // 招待のタグが既存のタグより優先され、無いキーは足される
    expect(a?.tags).toEqual({ owner: "kawaz", name: "iphone", room: "living" });
    // 鍵を作り直したあとの再登録で、トークンの鍵に戻らない
    await post("/bark-admin/api/devices/A", { crypto: { key: KEY_B } }, "PATCH");
    await fetch(`${base}/r/${token}/register?devicetoken=ta3&key=A`);
    expect((await store.devices.read())["A"]?.crypto?.key).toBe(KEY_B);
  });

  test("DELETE removes the invite: the add page and QR are 404, its unused tokens are gone, used ones keep working", async () => {
    const inv = await createInvite({ name: "bye" });
    const used = await openAdd(inv.invite);
    const unused = await openAdd(inv.invite);
    await fetch(`${base}/r/${used.token}/register?devicetoken=t&key=U1`);
    expect((await fetch(`${base}/bark-admin/api/invites/${inv.invite}`, { method: "DELETE" })).status).toBe(204);
    expect((await fetch(`${base}/bark-admin/add/${inv.invite}`)).status).toBe(404);
    expect((await fetch(`${base}/bark-admin/api/invites/${inv.invite}/qr.svg`)).status).toBe(404);
    expect((await fetch(`${base}/r/${unused.token}/register?devicetoken=t&key=`)).status).toBe(404);
    expect((await fetch(`${base}/r/${used.token}/register?devicetoken=t2&key=U1`)).status).toBe(200);
    expect(await (await fetch(`${base}/bark-admin/api/invites`)).text()).toBe("");
    expect((await fetch(`${base}/bark-admin/api/invites/${inv.invite}`, { method: "DELETE" })).status).toBe(404);
  });

  test("invite URL and QR", async () => {
    const inv = await createInvite({ owner: "kawaz" });
    const { token, page } = await openAdd(inv.invite);
    expect(page).toContain(`bark://addserver?address=https://bark.example/r/${token}`);
    expect(page).toContain("https://apps.apple.com/app/bark-custom-notifications/id1403753865");
    const qr = await fetch(`${base}/bark-admin/api/invites/${inv.invite}/qr.svg`);
    expect(qr.headers.get("content-type")).toBe("image/svg+xml");
  });

  test("registrations API: unused / used (with the device) / expired / invite deleted / unknown 404; it never returns the key", async () => {
    const RegSchema = v.object({
      token: v.string(),
      state: v.picklist(["unused", "used", "expired", "invite-deleted"]),
      used_by: v.nullable(v.string()),
      used_at: v.nullable(v.string()),
      expires_at: v.string(),
      encrypted: v.boolean(),
      device: v.nullable(
        v.object({
          device_id: v.string(),
          tags: v.record(v.string(), v.string()),
          info: v.optional(DeviceInfoSchema),
          delivery: v.object({ confirmed_at: v.nullable(v.string()) }),
          crypto: v.nullable(v.object({ confirmed_at: v.nullable(v.string()) })),
        }),
      ),
    });
    const status = async (token: string) => {
      const res = await fetch(`${base}/bark-admin/api/registrations/${token}`);
      expect(res.status).toBe(200);
      const text = await res.text();
      return { body: v.parse(RegSchema, JSON.parse(text)), text };
    };
    const inv = await createInvite({ owner: "kawaz", name: "reg" }, { encrypt: true });
    const used = await openAdd(inv.invite);
    const later = await openAdd(inv.invite);
    const before = await status(used.token);
    expect(before.body).toEqual({ token: used.token, state: "unused", used_by: null, used_at: null, expires_at: localIso(new Date(START.getTime() + REGISTRATION_TTL_MS)), encrypted: true, device: null });

    await fetch(`${base}/r/${used.token}/register?devicetoken=t&key=R1`);
    const after = await status(used.token);
    expect(after.body).toMatchObject({ state: "used", used_by: "R1", used_at: NOW, device: { device_id: "R1", tags: { owner: "kawaz", name: "reg" }, delivery: { confirmed_at: null }, crypto: { confirmed_at: null } } });
    // 招待ページの受信確認・暗号化の段は device の confirmed_at を見る
    await fetch(`${base}/bark-admin/api/devices/R1/confirm/delivery`, { method: "POST" });
    const dn = (await store.devices.read())["R1"]?.delivery?.pending_nonce ?? "";
    await fetch(`${base}/bark-admin/api/devices/R1/confirm/delivery/${dn}`);
    expect((await status(used.token)).body.device).toMatchObject({ delivery: { confirmed_at: NOW }, crypto: { confirmed_at: null } });
    expect(after.text).not.toContain(used.key ?? "-");

    clock = new Date(START.getTime() + REGISTRATION_TTL_MS);
    expect((await status(later.token)).body.state).toBe("expired");
    // 使った後は期限を過ぎても used
    expect((await status(used.token)).body.state).toBe("used");
    clock = START;
    const orphan = await openAdd(inv.invite);
    // 招待を手で消した (DELETE を通さない) 未使用のトークン
    await store.invites.update(() => ({ next: {}, result: null }));
    expect((await status(orphan.token)).body.state).toBe("invite-deleted");
    expect((await fetch(`${base}/bark-admin/api/registrations/nope`)).status).toBe(404);
  });

  test("crypto-key API: the token's key after registration; 409 before, 404 without a key or for an unknown token", async () => {
    const enc = await createInvite({ name: "enc" }, { encrypt: true });
    const { token, key } = await openAdd(enc.invite);
    expect((await fetch(`${base}/bark-admin/api/registrations/${token}/crypto-key`)).status).toBe(409);
    await fetch(`${base}/r/${token}/register?devicetoken=t&key=K1`);
    const res = await fetch(`${base}/bark-admin/api/registrations/${token}/crypto-key`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key });
    // 1 回限りではない
    expect((await fetch(`${base}/bark-admin/api/registrations/${token}/crypto-key`)).status).toBe(200);

    const plain = await openAdd((await createInvite({ name: "plain" })).invite);
    await fetch(`${base}/r/${plain.token}/register?devicetoken=t&key=K2`);
    expect((await fetch(`${base}/bark-admin/api/registrations/${plain.token}/crypto-key`)).status).toBe(404);
    expect((await fetch(`${base}/bark-admin/api/registrations/nope/crypto-key`)).status).toBe(404);
  });

  test("unknown token is 404 for ping and register, unknown invite is 404 for the add page", async () => {
    expect((await fetch(`${base}/r/nope/ping`)).status).toBe(404);
    expect((await fetch(`${base}/r/nope/register?devicetoken=t&key=`)).status).toBe(404);
    const notFound = await fetch(`${base}/bark-admin/add/nope`);
    expect(notFound.status).toBe(404);
    expect(await notFound.text()).toContain('href="/bark-admin/"');
    expect(received).toHaveLength(0);
  });

  test("an invites.json in the one-time invite format is set aside and the store starts empty", async () => {
    await Bun.write(store.invites.path, JSON.stringify({ OLD: { tags: { owner: "kawaz" }, created_at: "t0", used_by: "A" } }));
    const moved = await setAsideLegacyInvites(store, "STAMP");
    expect(moved).toBe(join(dir, "invites.legacy-STAMP.json"));
    expect(await store.invites.read()).toEqual({});
    expect(await setAsideLegacyInvites(store, "STAMP2")).toBeNull();
  });
});

describe("register", () => {
  test("plain /register adds an untagged device; existing key keeps its tags", async () => {
    await fetch(`${base}/register?devicetoken=t1&key=`);
    expect((await store.devices.read())["NEWKEY"]?.tags).toEqual({});
    await fetch(`${base}/register?devicetoken=t9&key=A`);
    expect((await store.devices.read())["A"]).toEqual({ device_token: "t9", registered_at: "t0", archived_at: null, tags: { owner: "kawaz", name: "iphone" }, crypto: null, info: { last_register_at: NOW, user_agent: expect.any(String) } });
  });

  test("bark-server errors are passed through without touching the registry", async () => {
    const res = await fetch(`${base}/register?devicetoken=&key=`);
    expect(res.status).toBe(400);
    expect(Object.keys(await store.devices.read())).toEqual(["A", "B", "C", "D"]);
  });
});

describe("device info and auto tags on register", () => {
  const BARK_UA = "Bark/1.6.4 (me.fin.bark; build:8; iOS 26.7.1) Alamofire/5.10.2";
  const barkHeaders = { "user-agent": BARK_UA, "accept-language": "ja;q=1.0, en;q=0.9", "x-forwarded-for": "100.104.30.107" };
  const tailnet = { ts_name: "zunphone.tail0000.ts.net", ts_machine: "zunphone", ts_hostname: "zunPhone", ts_os: "iOS", ts_user: "user@example.com", ts_ip: "100.104.30.107" };
  const observed = { bark_version: "1.6.4", bark_build: "8", os_version: "iOS 26.7.1", user_agent: BARK_UA, lang: "ja;q=1.0, en;q=0.9", ...tailnet, last_register_at: NOW };

  test("plain /register records info and fills only missing tags with auto tags", async () => {
    whoisResult = tailnet;
    expect((await fetch(`${base}/register?devicetoken=t9&key=A`, { headers: barkHeaders })).status).toBe(200);
    expect(whoisCalls).toEqual(["100.104.30.107"]);
    const a = (await store.devices.read())["A"];
    expect(a?.info).toEqual(observed);
    // 既存の name=iphone は残り、無いキーだけ足される
    expect(a?.tags).toEqual({ owner: "kawaz", name: "iphone", os: "ios", lang: "ja", ts_user: "user@example.com" });
    const detail = await (await fetch(`${base}/bark-admin/api/devices/A`)).json();
    expect(detail).toMatchObject({ info: observed });
    const [line] = (await (await fetch(`${base}/bark-admin/api/devices?name=iphone`)).text()).split("\n");
    expect(JSON.parse(line ?? "")).toMatchObject({ device_id: "A", info: { ts_hostname: "zunPhone", os_version: "iOS 26.7.1" } });
    expect(line).not.toContain(BARK_UA);
  });

  test("no X-Forwarded-For: no whois, os from the UA; a failed whois still registers", async () => {
    await fetch(`${base}/register?devicetoken=t1&key=`, { headers: { "user-agent": BARK_UA } });
    expect(whoisCalls).toEqual([]);
    expect((await store.devices.read())["NEWKEY"]?.tags).toEqual({ os: "ios" });
    // whois が何も返さなくても登録は通る
    expect((await fetch(`${base}/register?devicetoken=t2&key=`, { headers: barkHeaders })).status).toBe(200);
    expect((await store.devices.read())["NEWKEY"]?.info).toMatchObject({ os_version: "iOS 26.7.1", last_register_at: NOW });
  });

  test("/r/:token/register: invite tags win over auto tags; the client the invite page sent goes to info and decides os", async () => {
    whoisResult = tailnet;
    const inv = await createInvite({ owner: "kawaz", name: "phone" });
    const safari = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_7_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
    const { token } = await openAdd(inv.invite);
    const client = { user_agent: safari, platform: "iPhone", max_touch_points: 5, language: "ja-JP", screen: { w: 390, h: 844, dpr: 3 } };
    expect((await post(`/bark-admin/api/registrations/${token}/client`, client)).status).toBe(204);
    expect((await store.registrations.read())[token]?.client).toEqual(client);

    await fetch(`${base}/r/${token}/register?devicetoken=tok&key=`, { headers: barkHeaders });
    const d = (await store.devices.read())["NEWKEY"];
    expect(d?.tags).toEqual({ owner: "kawaz", name: "phone", os: "ios", lang: "ja", ts_user: "user@example.com" });
    expect(d?.info).toEqual({
      ...observed,
      device_kind: "iphone",
      browser_user_agent: safari,
      browser_platform: "iPhone",
      browser_max_touch_points: "5",
      browser_language: "ja-JP",
      browser_screen: "390x844@3",
    });

    // 再登録で人が直したタグは招待のタグに戻らない。client の情報は写り続ける
    await post("/bark-admin/api/devices/NEWKEY", { tags: { owner: "kawaz", name: "renamed" } }, "PATCH");
    await fetch(`${base}/r/${token}/register?devicetoken=tok2&key=NEWKEY`, { headers: barkHeaders });
    const again = (await store.devices.read())["NEWKEY"];
    expect(again?.tags).toEqual({ owner: "kawaz", name: "renamed", os: "ios", lang: "ja", ts_user: "user@example.com" });
    expect(again?.info?.device_kind).toBe("iphone");
  });

  test("an iPad (desktop Safari, localhost Hostname): name from ComputedName, os ipados; re-registering does not overwrite name / os", async () => {
    whoisResult = { ts_name: "ipad-pro-12-9-gen-5.tail0000.ts.net", ts_machine: "ipad-pro-12-9-gen-5", ts_hostname: "localhost", ts_os: "iOS", ts_ip: "100.84.237.16" };
    const { token } = await openAdd((await createInvite({ owner: "kawaz" })).invite);
    const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
    await post(`/bark-admin/api/registrations/${token}/client`, { user_agent: mac, platform: "MacIntel", max_touch_points: 5, language: "ja-JP", screen: { w: 1024, h: 1366, dpr: 2 } });
    await fetch(`${base}/r/${token}/register?devicetoken=tok&key=IPAD`, { headers: { ...barkHeaders, "x-forwarded-for": "100.84.237.16" } });
    const d = (await store.devices.read())["IPAD"];
    expect(d?.tags).toEqual({ owner: "kawaz", name: "ipad-pro-12-9-gen-5", os: "ipados", lang: "ja" });
    expect(d?.info).toMatchObject({ device_kind: "ipad", ts_machine: "ipad-pro-12-9-gen-5", ts_hostname: "localhost", browser_screen: "1024x1366@2" });

    // 人が name / os を直した後の再登録 (マシン名が変わっても) で、自動タグは上書きしない
    await post("/bark-admin/api/devices/IPAD", { tags: { owner: "kawaz", name: "ipad", os: "ios" } }, "PATCH");
    whoisResult = { ...whoisResult, ts_machine: "renamed-machine" };
    await fetch(`${base}/r/${token}/register?devicetoken=tok2&key=IPAD`, { headers: { ...barkHeaders, "x-forwarded-for": "100.84.237.16" } });
    expect((await store.devices.read())["IPAD"]?.tags).toEqual({ owner: "kawaz", name: "ipad", os: "ios", lang: "ja" });
  });

  test("POST …/client validates the body and needs a known token", async () => {
    const { token } = await openAdd((await createInvite({})).invite);
    expect((await post(`/bark-admin/api/registrations/${token}/client`, { user_agent: "x" })).status).toBe(400);
    expect((await post(`/bark-admin/api/registrations/${token}/client`, { user_agent: "x", platform: "p", max_touch_points: -1, language: "ja", screen: { w: 1, h: 1, dpr: 1 } })).status).toBe(400);
    expect((await post("/bark-admin/api/registrations/nope/client", { user_agent: "x", platform: "p", max_touch_points: 0, language: "ja", screen: { w: 1, h: 1, dpr: 1 } })).status).toBe(404);
  });

  test("PATCH cannot edit info", async () => {
    const res = await post("/bark-admin/api/devices/A", { info: { ts_hostname: "x" } }, "PATCH");
    expect(res.status).toBe(400);
    expect((await post("/bark-admin/api/devices/A", { tags: { name: "n" }, info: {} }, "PATCH")).status).toBe(400);
    expect((await store.devices.read())["A"]?.info).toBeUndefined();
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

  test("/r/<token>/* strips the prefix", async () => {
    const { token: id } = await openAdd((await createInvite({})).invite);
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

  test("HTML refers to assets with ?v=<hash>, JS imports are versioned too; HTML and assets are no-cache with an ETag (304 when unchanged)", async () => {
    const versioned = /\/bark-admin\/assets\/device\.js\?v=[0-9a-f]{8}"/;
    const detail = await fetch(`${base}/bark-admin/devices/A`);
    const html = await detail.text();
    expect(html).toMatch(versioned);
    expect(html).toMatch(/\/bark-admin\/assets\/style\.css\?v=[0-9a-f]{8}"/);
    expect(html).not.toMatch(/assets\/[a-z.]+"/);
    expect(detail.headers.get("cache-control")).toBe("no-cache");
    expect(detail.headers.get("etag")).toMatch(/^"[0-9a-f]{16}"$/);
    // 案内ページ (サーバで組む HTML) も版つき
    const inv = await createInvite({});
    expect((await openAdd(inv.invite)).page).toMatch(/\/bark-admin\/assets\/add\.js\?v=[0-9a-f]{8}"/);

    const js = await fetch(`${base}/bark-admin/assets/device.js`);
    expect(js.headers.get("cache-control")).toBe("no-cache");
    expect(js.headers.get("content-type")).toContain("text/javascript");
    const etag = js.headers.get("etag") ?? "";
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
    expect(await js.text()).toMatch(/from "\.\/common\.js\?v=[0-9a-f]{8}"/);
    const again = await fetch(`${base}/bark-admin/assets/device.js`, { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
    // URL の版は ETag の先頭と同じ
    expect(html).toContain(`device.js?v=${etag.slice(1, 9)}"`);
  });
});
