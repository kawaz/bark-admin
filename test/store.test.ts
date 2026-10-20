import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bark-admin-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("JsonMapFile", () => {
  test("missing file reads as empty map, invites.json sits next to db_path", async () => {
    const store = openStore(join(dir, "sub", "devices.json"));
    expect(await store.devices.read()).toEqual({});
    expect(store.invites.path).toBe(join(dir, "sub", "invites.json"));
  });

  test("update writes through tmp + rename and leaves no tmp file", async () => {
    const store = openStore(join(dir, "devices.json"));
    await store.devices.update(() => ({
      next: { X: { device_token: "t", registered_at: "r", archived_at: null, tags: {}, crypto: null } },
      result: null,
    }));
    expect(await readdir(dir)).toEqual(["devices.json"]);
    expect(await store.devices.read()).toEqual({ X: { device_token: "t", registered_at: "r", archived_at: null, tags: {}, crypto: null } });
  });

  test("concurrent updates are serialized (no lost write)", async () => {
    const store = openStore(join(dir, "devices.json"));
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.devices.update((cur) => ({
          next: { ...cur, [`D${i}`]: { device_token: "t", registered_at: "r", archived_at: null, tags: {}, crypto: null } },
          result: null,
        })),
      ),
    );
    expect(Object.keys(await store.devices.read())).toHaveLength(10);
  });

  test("a device without the crypto key reads as crypto: null", async () => {
    const path = join(dir, "devices.json");
    await Bun.write(path, JSON.stringify({ X: { device_token: "t", registered_at: "r", archived_at: null, tags: {} } }));
    expect((await openStore(path).devices.read())["X"]?.crypto).toBeNull();
  });

  test("a broken file is reported, not overwritten", async () => {
    const path = join(dir, "devices.json");
    await Bun.write(path, "{ broken");
    const store = openStore(path);
    await expect(store.devices.read()).rejects.toThrow("invalid-syntax");
    await expect(store.devices.update(() => ({ next: {}, result: null }))).rejects.toThrow();
    expect(await Bun.file(path).text()).toBe("{ broken");
  });
});
