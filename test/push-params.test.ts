import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { pushParamFields, pushParamsSchema } from "../src/schema/push-params.ts";

describe("pushParamsSchema", () => {
  test("accepts the documented params with their types", () => {
    const r = v.safeParse(pushParamsSchema, {
      title: "t",
      body: "b",
      badge: 0,
      ttl: 60,
      level: "critical",
      volume: "7",
      call: "1",
      isArchive: "0",
      url: "myapp://open",
      id: "x",
      delete: "1",
    });
    expect(r.success).toBe(true);
  });

  test("drops undefined keys from the output", () => {
    const r = v.safeParse(pushParamsSchema, { body: "b" });
    expect(r.success && r.output).toEqual({ body: "b" });
  });

  test.each([
    ["unknown key", { boby: "typo" }],
    ["level out of enum", { level: "loud" }],
    ["badge must be integer", { badge: 1.5 }],
    ["badge must be number", { badge: "1" }],
    ["volume is a 0-10 string", { volume: "11" }],
    ["flag must be 1", { call: "0" }],
    ["icon must be url", { icon: "not a url" }],
    ["delete requires id", { delete: "1" }],
  ])("rejects: %s", (_, input) => {
    expect(v.safeParse(pushParamsSchema, input).success).toBe(false);
  });

  test("covers every param listed in DESIGN.md and the bark docs", () => {
    expect(pushParamFields.map((f) => f.name).toSorted()).toEqual(
      [
        "title", "subtitle", "body", "markdown", "sound", "icon", "image", "group", "level", "volume", "badge", "call",
        "url", "copy", "autoCopy", "isArchive", "ttl", "action", "id", "delete", "ciphertext", "iv",
      ].toSorted(),
    );
  });
});
