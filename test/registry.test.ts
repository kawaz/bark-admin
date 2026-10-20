import { describe, expect, test } from "bun:test";
import { archiveDevice, finishConfirm, listItem, matchTag, matchTags, mergeTags, patchDevice, resolveTargets, selectDevices, startConfirm, upsertRegistration, view } from "../src/registry.ts";
import type { Devices } from "../src/schema/registry.ts";

const devices: Devices = {
  A: { device_token: "ta", registered_at: "t0", archived_at: null, tags: { owner: "kawaz", name: "iphone", family: "kawazu" }, crypto: null },
  B: { device_token: "tb", registered_at: "t0", archived_at: null, tags: { owner: "kawaz", name: "ipad", family: "kawazu" }, crypto: null },
  C: { device_token: "tc", registered_at: "t0", archived_at: null, tags: { owner: "other", family: "kawazu" }, crypto: null },
  D: { device_token: "td", registered_at: "t0", archived_at: "t1", tags: { owner: "kawaz", name: "old" }, crypto: null },
};

describe("matchTag", () => {
  test("plain value is an exact match", () => {
    expect(matchTag("iphone", "iphone")).toBe(true);
    expect(matchTag("iphone", "phone")).toBe(false);
  });
  test("*v* is a substring match", () => {
    expect(matchTag("iphone", "*phone*")).toBe(true);
    expect(matchTag("iphone", "*iphone*")).toBe(true);
    expect(matchTag("iphone", "*pad*")).toBe(false);
  });
  test("* and ** check that the key exists (also for an empty value)", () => {
    for (const p of ["*", "**"]) {
      expect(matchTag("x", p)).toBe(true);
      expect(matchTag("", p)).toBe(true);
      expect(matchTag(undefined, p)).toBe(false);
    }
  });
  test("v* and *v keep * literal", () => {
    expect(matchTag("iphone", "iph*")).toBe(false);
    expect(matchTag("iphone", "*one")).toBe(false);
    expect(matchTag("iph*", "iph*")).toBe(true);
    expect(matchTag("*one", "*one")).toBe(true);
  });
  test("values containing *", () => {
    expect(matchTag("a*b", "a*b")).toBe(true);
    expect(matchTag("a*b", "***")).toBe(true);
    expect(matchTag("ab", "***")).toBe(false);
    expect(matchTag("*x*", "*x*")).toBe(true);
    expect(matchTag("x", "*x*")).toBe(true);
  });
  test("a missing key never matches", () => {
    expect(matchTag(undefined, "*x*")).toBe(false);
    expect(matchTag(undefined, "x")).toBe(false);
  });
});

describe("matchTags", () => {
  test("empty filter matches anything", () => expect(matchTags({ a: "1" }, {})).toBe(true));
  test("all keys must match exactly (AND)", () => {
    expect(matchTags({ owner: "kawaz", name: "iphone" }, { owner: "kawaz", name: "iphone" })).toBe(true);
    expect(matchTags({ owner: "kawaz", name: "iphone" }, { owner: "kawaz", name: "ipad" })).toBe(false);
  });
  test("missing key does not match", () => expect(matchTags({ owner: "kawaz" }, { name: "iphone" })).toBe(false));
  test("no partial match", () => expect(matchTags({ name: "iphone" }, { name: "iph" })).toBe(false));
  test("patterns combine with AND", () => {
    expect(matchTags({ owner: "kawaz", name: "iphone" }, { owner: "*", name: "*phone*" })).toBe(true);
    expect(matchTags({ name: "iphone" }, { owner: "*", name: "*phone*" })).toBe(false);
  });
});

describe("selectDevices", () => {
  test("active only by default, filtered by AND", () => {
    expect(selectDevices(devices, { owner: "kawaz" }, false).map((d) => d.device_id)).toEqual(["A", "B"]);
    expect(selectDevices(devices, { owner: "kawaz", name: "ipad" }, false).map((d) => d.device_id)).toEqual(["B"]);
  });
  test("includeArchived adds archived devices", () => {
    expect(selectDevices(devices, { owner: "kawaz" }, true).map((d) => d.device_id)).toEqual(["A", "B", "D"]);
  });
  test("view carries device_id", () => {
    expect(selectDevices(devices, { name: "iphone" }, false)).toEqual([
      { device_id: "A", registered_at: "t0", archived_at: null, tags: { owner: "kawaz", name: "iphone", family: "kawazu" }, crypto: null, info: {}, delivery: { confirmed_at: null } },
    ]);
  });
});

describe("resolveTargets", () => {
  test("archived matches are counted as skipped", () => {
    expect(resolveTargets(devices, { owner: "kawaz" })).toEqual({ deviceIds: ["A", "B"], skipped: 1 });
  });
  test("empty filter = all active", () => {
    expect(resolveTargets(devices, {})).toEqual({ deviceIds: ["A", "B", "C"], skipped: 1 });
  });
});

describe("upsertRegistration", () => {
  const info = { ts_hostname: "zunPhone", last_register_at: "t2" };
  test("new device gets tags, registered_at and info", () => {
    const r = upsertRegistration(devices, { deviceId: "E", deviceToken: "te", tags: { owner: "x" }, crypto: null, info, autoTags: { name: "zunphone" }, now: "t2" });
    expect(r.created).toBe(true);
    expect(r.devices["E"]).toEqual({ device_token: "te", registered_at: "t2", archived_at: null, tags: { name: "zunphone", owner: "x" }, crypto: null, info });
  });
  test("existing device updates the token, replaces info and fills only missing tags", () => {
    const r = upsertRegistration(devices, { deviceId: "D", deviceToken: "new", tags: {}, crypto: null, info, autoTags: { name: "zunphone", os: "ios" }, now: "t2" });
    expect(r.created).toBe(false);
    expect(r.devices["D"]).toEqual({ device_token: "new", registered_at: "t0", archived_at: "t1", tags: { owner: "kawaz", name: "old", os: "ios" }, crypto: null, info });
    const again = upsertRegistration(r.devices, { deviceId: "D", deviceToken: "new", tags: {}, crypto: null, info: { last_register_at: "t3" }, autoTags: {}, now: "t3" });
    expect(again.devices["D"]?.info).toEqual({ last_register_at: "t3" });
  });
});

describe("mergeTags", () => {
  test("invite > existing > auto", () => {
    expect(mergeTags({ name: "inv" }, { name: "cur", owner: "kawaz" }, { name: "auto", os: "ios", owner: "auto" })).toEqual({ name: "inv", owner: "kawaz", os: "ios" });
    expect(mergeTags({}, { name: "cur" }, { name: "auto", lang: "ja" })).toEqual({ name: "cur", lang: "ja" });
    expect(mergeTags({}, {}, { name: "auto" })).toEqual({ name: "auto" });
    // 既存のキーの並びを保ち、自動タグは後ろに足す
    expect(Object.keys(mergeTags({}, { owner: "kawaz", name: "cur" }, { name: "auto", os: "ios" }))).toEqual(["owner", "name", "os"]);
  });
});

describe("view / listItem", () => {
  const d = devices["A"];
  test("a device without info reads as info {}; the list keeps only ts_hostname and os_version", () => {
    if (d === undefined) throw new Error("fixture A");
    expect(view("A", d).info).toEqual({});
    const full = { ...d, info: { ts_hostname: "zunPhone", os_version: "iOS 26.7.1", user_agent: "Bark/1.6.4", ts_user: "u@example" } };
    expect(view("A", full).info).toEqual(full.info);
    expect(listItem(view("A", full)).info).toEqual({ ts_hostname: "zunPhone", os_version: "iOS 26.7.1" });
  });
});

describe("patch / archive", () => {
  const a = { device_token: "ta", registered_at: "t0", archived_at: null, tags: { owner: "kawaz" }, crypto: null };
  test("tags are replaced, not merged", () => expect(patchDevice(a, { tags: { name: "n" } }).tags).toEqual({ name: "n" }));
  test("archived_at null restores", () => expect(patchDevice({ ...a, archived_at: "t1" }, { archived_at: null }).archived_at).toBeNull());
  test("archive sets archived_at once", () => {
    const once = archiveDevice(a, "t1");
    expect(once.archived_at).toBe("t1");
    expect(archiveDevice(once, "t2").archived_at).toBe("t1");
  });
});

describe("confirm (delivery / crypto)", () => {
  const withKey = { device_token: "ta", registered_at: "t0", archived_at: null, tags: {}, crypto: { key: "K".repeat(32), confirmed_at: null, pending_nonce: null } };
  test("crypto: start records the nonce, finish with the same nonce confirms and clears it", () => {
    const started = startConfirm(withKey, "crypto", "N1");
    expect(started?.crypto?.pending_nonce).toBe("N1");
    expect(started && finishConfirm(started, "crypto", "N2", "t1")).toBeNull();
    expect(started && finishConfirm(started, "crypto", "N1", "t1")?.crypto).toEqual({ key: "K".repeat(32), confirmed_at: "t1", pending_nonce: null });
  });
  test("crypto: no key cannot start; no pending nonce cannot finish", () => {
    expect(startConfirm({ ...withKey, crypto: null }, "crypto", "N1")).toBeNull();
    expect(finishConfirm(withKey, "crypto", "N1", "t1")).toBeNull();
  });
  test("delivery works without a key and is independent of crypto", () => {
    const plain = { ...withKey, crypto: null };
    const d = startConfirm(plain, "delivery", "D1");
    expect(d?.delivery).toEqual({ confirmed_at: null, pending_nonce: "D1" });
    expect(d && finishConfirm(d, "crypto", "D1", "t1")).toBeNull();
    expect(d && finishConfirm(d, "delivery", "D1", "t1")?.delivery).toEqual({ confirmed_at: "t1", pending_nonce: null });
    // 両方送った状態で、片方の nonce はもう片方を確認済みにしない
    const both = startConfirm(startConfirm(withKey, "delivery", "D2") ?? withKey, "crypto", "C2");
    expect(both && finishConfirm(both, "delivery", "C2", "t1")).toBeNull();
    const crypto = both && finishConfirm(both, "crypto", "C2", "t1");
    expect(crypto?.crypto?.confirmed_at).toBe("t1");
    expect(crypto?.delivery).toEqual({ confirmed_at: null, pending_nonce: "D2" });
  });
});
