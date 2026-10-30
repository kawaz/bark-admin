import { describe, expect, test } from "bun:test";
import { step } from "../src/ui/components.ts";
import { deviceStatuses, glyphKind, hostState, type StatusSource } from "../src/ui/device-status.ts";
import { html } from "../src/ui/html.ts";
import { addPageHtml, devicePageHtml, migratePageHtml } from "../src/ui/pages.ts";
import { deviceAlerts, deviceHero, deviceRow, deviceStateRows, type DeviceDetailData, type TagMatch } from "../src/ui/views.ts";

const HOST = "bark.new.example";
const KEY = "K".repeat(32);

const source = (o: Partial<StatusSource> = {}): StatusSource => ({
  archived_at: null,
  crypto: null,
  delivery: { confirmed_at: "t1" },
  migrated_to: null,
  info: { server_host: HOST },
  ...o,
});

const detail = (o: Partial<DeviceDetailData> = {}): DeviceDetailData => ({
  ...source(),
  device_id: "DEV1",
  registered_at: "2026-10-20T10:02:28+09:00",
  tags: { owner: "kawaz", name: "iphone", os: "ios" },
  crypto: { key: KEY, confirmed_at: "t2" },
  migrated_from: null,
  info: { server_host: HOST, os_version: "iOS 26.7.1" },
  ...o,
});

const noMatch: TagMatch = { hits: () => false, pressed: () => false };

describe("html", () => {
  test("interpolated strings are escaped, Html parts are embedded as is, arrays are joined", () => {
    expect(html`<p title="${'"x"'}">${"<b>"}${html`<i>ok</i>`}${["a", html`<br>`]}${null}${false}</p>`.value).toBe('<p title="&#34;x&#34;">&#60;b&#62;<i>ok</i>a<br></p>');
  });
});

describe("device status labels", () => {
  // 状態 → 一覧と詳細の見出しに並ぶラベルの対応表
  test.each([
    ["nothing to say: delivery confirmed, no key, current host", source(), []],
    ["delivery not confirmed comes first", source({ delivery: { confirmed_at: null }, crypto: { confirmed_at: "t" } }), ["受信未確認", "暗号化 確認済み"]],
    ["key not confirmed", source({ crypto: { confirmed_at: null } }), ["暗号化 未確認"]],
    ["old host", source({ info: { server_host: "bark.old.example" } }), ["サーバー名が古い"]],
    ["unknown host is not a label", source({ info: {} }), []],
    ["migrated replaces the old host label and names where it went (device_id when the name is unknown)", source({ migrated_to: "NEW", info: { server_host: "bark.old.example" } }), ["移行済み → NEW"]],
    ["archived: no delivery or old host label, only archived", source({ archived_at: "t9", delivery: { confirmed_at: null }, info: { server_host: "bark.old.example" } }), ["アーカイブ済み"]],
    ["migrated and archived", source({ archived_at: "t9", migrated_to: "NEW" }), ["移行済み → NEW", "アーカイブ済み"]],
  ] as const)("%s", (_, d, expected) => {
    expect(deviceStatuses(d, HOST).map((s) => s.text)).toEqual([...expected]);
  });

  test("the migrated label carries the new device's name when known", () => {
    expect(deviceStatuses(source({ migrated_to: "NEW" }), HOST, (id) => (id === "NEW" ? "iphone" : undefined)).map((s) => s.text)).toEqual(["移行済み → iphone"]);
  });

  // 塗りの点 (その状態にある) と中抜きの点 (まだ) の区別は tone で決まる (style.css)
  test("tones: confirmed is ok, unconfirmed is info, old host is warn, migrated is moved, archived is archived", () => {
    const tones = (d: StatusSource) => deviceStatuses(d, HOST).map((s) => s.tone);
    expect(tones(source({ delivery: { confirmed_at: null }, crypto: { confirmed_at: null } }))).toEqual(["info", "info"]);
    expect(tones(source({ crypto: { confirmed_at: "t" }, info: { server_host: "old" } }))).toEqual(["ok", "warn"]);
    expect(tones(source({ archived_at: "t", migrated_to: "N" }))).toEqual(["moved", "archived"]);
  });

  test("hostState", () => {
    expect(hostState(source(), HOST)).toEqual({ kind: "current", host: HOST });
    expect(hostState(source({ info: { server_host: "old" } }), HOST)).toEqual({ kind: "stale", host: "old" });
    expect(hostState(source({ info: {} }), HOST)).toEqual({ kind: "unknown" });
    expect(hostState(source({ migrated_to: "N", info: { server_host: "old" } }), HOST)).toEqual({ kind: "migrated", to: "N" });
  });

  test("glyphKind: device_kind, then the os tag, then the UA OS name", () => {
    expect(glyphKind({ os: "ios" }, { device_kind: "ipad" })).toBe("tablet");
    expect(glyphKind({ os: "macos" }, {})).toBe("laptop");
    expect(glyphKind({}, { os_version: "iOS 26.7.1" })).toBe("phone");
    expect(glyphKind({}, {})).toBe("bell");
  });
});

describe("device row (list)", () => {
  test("the name links to the detail; owner and the other tags are filter buttons; more than 4 tags fold into +n", () => {
    const row = deviceRow({ ...detail(), tags: { owner: "kawaz", name: "iphone", a: "1", b: "2", c: "3", d: "4", e: "5" } }, HOST, noMatch).value;
    expect(row).toContain('<a class="name" href="/bark-admin/devices/DEV1">iphone</a>');
    expect(row).toContain('data-tag-k="owner" data-tag-v="kawaz"');
    expect(row).toContain('data-tag-k="d"');
    expect(row).not.toContain('data-tag-k="e"');
    expect(row).toContain('title="e=5">+1</li>');
  });

  test("a tag hitting the filter pattern is marked; the exact k=v is pressed", () => {
    const m: TagMatch = { hits: (k) => k === "os", pressed: (k, v) => k === "owner" && v === "kawaz" };
    const row = deviceRow(detail(), HOST, m).value;
    expect(row).toContain('class="chip hit" aria-pressed="false" title="宛先に os=ios を足す"');
    expect(row).toContain('aria-pressed="true" title="宛先から owner=kawaz を外す"');
  });

  test("only active (not archived) devices carry the send-target mark; unnamed devices say so", () => {
    expect(deviceRow(detail(), HOST, noMatch).value).toContain('class="target"');
    const archived = deviceRow({ ...detail(), archived_at: "t9", tags: {} }, HOST, noMatch).value;
    expect(archived).not.toContain('class="target"');
    expect(archived).toContain('<li class="device archived">');
    expect(archived).toContain('<a class="name unnamed"');
    expect(archived).toContain('<span class="st st-archived">アーカイブ済み</span>');
  });
});

describe("device detail", () => {
  test("the key never appears in the rendered detail (hero, alerts, state rows) or the page frame", () => {
    const d = detail();
    for (const part of [deviceHero(d, HOST), deviceAlerts(d, HOST), deviceStateRows(d, HOST)]) expect(part.value).not.toContain(KEY);
    const frame = devicePageHtml();
    expect(frame).toContain('<code id="crypto-key" class="key masked" aria-label="暗号化キー (隠している)">••••••••</code>');
  });

  test("each state row opens its own dialog; archived devices get no operations", () => {
    const rows = deviceStateRows(detail({ info: { server_host: "bark.old.example" } }), HOST).value;
    expect(rows).toContain('commandfor="delivery-dialog"');
    expect(rows).toContain('commandfor="crypto-dialog" command="show-modal">鍵と確認</button>');
    expect(rows).toContain('commandfor="migrate-dialog"');
    expect(rows).toContain("今のサーバー名は bark.new.example");
    expect(deviceStateRows(detail({ crypto: null }), HOST).value).toContain(">設定する</button>");
    expect(deviceStateRows(detail(), HOST).value).not.toContain("migrate-dialog");
    expect(deviceStateRows(detail({ archived_at: "t9" }), HOST).value).not.toContain("commandfor");
  });

  test("alerts: old host offers re-registration, migrated links to the new device by name, archived offers unarchiving", () => {
    expect(deviceAlerts(detail({ info: { server_host: "bark.old.example" } }), HOST).value).toContain("新しいサーバー名で登録し直す</button>");
    const moved = deviceAlerts(detail({ migrated_to: "NEW", archived_at: "t9" }), HOST, () => "iphone").value;
    expect(moved).toContain('href="/bark-admin/devices/NEW">移行先の iphone を開く</a>');
    expect(moved).toContain("移行先の受信確認でアーカイブした");
    expect(moved).not.toContain("アーカイブから戻す");
    expect(deviceAlerts(detail({ archived_at: "2026-10-21T00:00:00+09:00" }), HOST).value).toContain('commandfor="archive-dialog" command="show-modal">アーカイブから戻す</button>');
    expect(deviceAlerts(detail(), HOST).value).toBe("");
  });
});

describe("steps (invite page)", () => {
  test("the current step shows its content, the others hide it; the state line follows the mode", () => {
    const s = (mode: "done" | "current" | "later") => step({ id: "x", n: 2, title: "T", mode, body: html`<b>body</b>` }).value;
    expect(s("current")).toContain('<li id="step-x" class="step current">');
    expect(s("current")).toContain('<div class="content"><p class="message"');
    expect(s("current")).toContain(">今ここ</p>");
    expect(s("later")).toContain('<div class="content" hidden>');
    expect(s("done")).toContain(">済み</p>");
  });

  test("the invite page has 3 steps with a key invite and 2 without; the migration page has 2", () => {
    const page = (encrypted: boolean) => addPageHtml({ addserverUrl: "bark://addserver?address=x", token: "T", tags: {}, encrypted });
    expect(page(true)).toContain('id="step-crypto"');
    expect(page(true)).toContain("3 つの手順");
    expect(page(false)).not.toContain('id="step-crypto"');
    expect(page(false)).toContain("2 つの手順");
    expect(page(true)).toContain('<li id="step-add" class="step current">');
    expect(page(true)).toContain('<li id="step-delivery" class="step later">');
    const migrate = migratePageHtml({ addserverUrl: "bark://addserver?address=x", token: "T", tags: {}, oldHost: undefined, newHost: HOST });
    expect(migrate).not.toContain('id="step-crypto"');
    expect(migrate).toContain("古いサーバー名 を削除してよい");
  });
});
