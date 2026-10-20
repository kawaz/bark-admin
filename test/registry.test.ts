import { describe, expect, test } from "bun:test";
import { archiveDevice, matchTags, patchDevice, resolveTargets, selectDevices, upsertRegistration } from "../src/registry.ts";
import type { Devices } from "../src/schema/registry.ts";

const devices: Devices = {
  A: { device_token: "ta", registered_at: "t0", archived_at: null, tags: { owner: "kawaz", name: "iphone", family: "kawazu" }, crypto: null },
  B: { device_token: "tb", registered_at: "t0", archived_at: null, tags: { owner: "kawaz", name: "ipad", family: "kawazu" }, crypto: null },
  C: { device_token: "tc", registered_at: "t0", archived_at: null, tags: { owner: "other", family: "kawazu" }, crypto: null },
  D: { device_token: "td", registered_at: "t0", archived_at: "t1", tags: { owner: "kawaz", name: "old" }, crypto: null },
};

describe("matchTags", () => {
  test("empty filter matches anything", () => expect(matchTags({ a: "1" }, {})).toBe(true));
  test("all keys must match exactly (AND)", () => {
    expect(matchTags({ owner: "kawaz", name: "iphone" }, { owner: "kawaz", name: "iphone" })).toBe(true);
    expect(matchTags({ owner: "kawaz", name: "iphone" }, { owner: "kawaz", name: "ipad" })).toBe(false);
  });
  test("missing key does not match", () => expect(matchTags({ owner: "kawaz" }, { name: "iphone" })).toBe(false));
  test("no partial match", () => expect(matchTags({ name: "iphone" }, { name: "iph" })).toBe(false));
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
      { device_id: "A", device_token: "ta", registered_at: "t0", archived_at: null, tags: { owner: "kawaz", name: "iphone", family: "kawazu" }, crypto: null },
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
  test("new device gets tags and registered_at", () => {
    const r = upsertRegistration(devices, { deviceId: "E", deviceToken: "te", tags: { owner: "x" }, crypto: null, now: "t2" });
    expect(r.created).toBe(true);
    expect(r.devices["E"]).toEqual({ device_token: "te", registered_at: "t2", archived_at: null, tags: { owner: "x" }, crypto: null });
  });
  test("existing device only updates the token", () => {
    const r = upsertRegistration(devices, { deviceId: "D", deviceToken: "new", tags: { owner: "x" }, crypto: null, now: "t2" });
    expect(r.created).toBe(false);
    expect(r.devices["D"]).toEqual({ device_token: "new", registered_at: "t0", archived_at: "t1", tags: { owner: "kawaz", name: "old" }, crypto: null });
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
