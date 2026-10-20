import { describe, expect, test } from "bun:test";
import { autoTags, deviceKind, firstLanguage, forwardedIp, observeRegistration, parseBarkUserAgent, whoisToInfo } from "../src/device-info.ts";

const BARK_UA = "Bark/1.6.4 (me.fin.bark; build:8; iOS 26.7.1) Alamofire/5.10.2";

describe("parseBarkUserAgent", () => {
  test("Bark version, build and OS version", () => {
    expect(parseBarkUserAgent(BARK_UA)).toEqual({ bark_version: "1.6.4", bark_build: "8", os_version: "iOS 26.7.1" });
  });
  test("other shapes give nothing", () => {
    for (const ua of [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      "Bark/1.6.4",
      "Bark/1.6.4 (com.example.other; build:8; iOS 26.7.1) Alamofire/5.10.2",
      "Bark/1.6.4 (me.fin.bark; iOS 26.7.1) Alamofire/5.10.2",
      "curl/8.7.1",
      "",
    ]) {
      expect(parseBarkUserAgent(ua)).toEqual({});
    }
  });
});

describe("firstLanguage", () => {
  test("primary subtag of the first entry", () => {
    expect(firstLanguage("ja;q=1.0, en;q=0.9")).toBe("ja");
    expect(firstLanguage("en-US,en;q=0.9")).toBe("en");
    expect(firstLanguage("ZH-Hant-TW;q=1.0")).toBe("zh");
  });
  test("empty or wildcard gives nothing", () => {
    expect(firstLanguage("")).toBeUndefined();
    expect(firstLanguage("*")).toBeUndefined();
  });
});

describe("whoisToInfo", () => {
  test("Node name (without the trailing dot), ComputedName, Hostinfo and LoginName", () => {
    const json = JSON.stringify({
      Node: { Name: "zunphone.tail0000.ts.net.", ComputedName: "zunphone", Hostinfo: { OS: "iOS", Hostname: "zunPhone", OSVersion: null, DeviceModel: null }, Addresses: ["100.104.30.107/32"] },
      UserProfile: { LoginName: "user@example.com", DisplayName: "u" },
    });
    expect(whoisToInfo(json, "100.104.30.107")).toEqual({ ts_name: "zunphone.tail0000.ts.net", ts_machine: "zunphone", ts_hostname: "zunPhone", ts_os: "iOS", ts_user: "user@example.com", ts_ip: "100.104.30.107" });
  });
  test("iPadOS reports localhost as Hostname; the machine name comes from ComputedName", () => {
    const json = JSON.stringify({ Node: { Name: "ipad-pro-12-9-gen-5.tail0000.ts.net.", ComputedName: "ipad-pro-12-9-gen-5", Hostinfo: { OS: "iOS", Hostname: "localhost" } } });
    const info = whoisToInfo(json, "100.84.237.16");
    expect(info).toMatchObject({ ts_machine: "ipad-pro-12-9-gen-5", ts_hostname: "localhost" });
    expect(autoTags(info).name).toBe("ipad-pro-12-9-gen-5");
  });
  test("null and missing fields are left out", () => {
    const json = JSON.stringify({ Node: { Name: null, Hostinfo: { OS: null, Hostname: "" } }, UserProfile: null });
    expect(whoisToInfo(json, "100.1.2.3")).toEqual({ ts_ip: "100.1.2.3" });
    expect(whoisToInfo(JSON.stringify({ Node: { Hostinfo: null } }), "100.1.2.3")).toEqual({ ts_ip: "100.1.2.3" });
  });
  test("unreadable output keeps only the ip", () => {
    expect(whoisToInfo("no such peer", "100.1.2.3")).toEqual({ ts_ip: "100.1.2.3" });
    expect(whoisToInfo("{}", "100.1.2.3")).toEqual({ ts_ip: "100.1.2.3" });
  });
});

describe("forwardedIp", () => {
  test("last entry, only when it is an IP", () => {
    expect(forwardedIp("100.104.30.107")).toBe("100.104.30.107");
    expect(forwardedIp("1.2.3.4, 100.104.30.107")).toBe("100.104.30.107");
    expect(forwardedIp("fd7a:115c:a1e0::1")).toBe("fd7a:115c:a1e0::1");
    expect(forwardedIp("--help")).toBeUndefined();
    expect(forwardedIp(null)).toBeUndefined();
  });
});

describe("deviceKind", () => {
  const client = (user_agent: string, platform: string, max_touch_points: number) => ({ user_agent, platform, max_touch_points, language: "ja", screen: { w: 1, h: 1, dpr: 1 } });
  const MAC_SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
  test.each([
    ["iPad (desktop Safari: Macintosh / MacIntel with touch)", client(MAC_SAFARI, "MacIntel", 5), "ipad"],
    ["iPad (mobile UA)", client("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1", "iPad", 5), "ipad"],
    ["iPhone", client("Mozilla/5.0 (iPhone; CPU iPhone OS 26_7_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1", "iPhone", 5), "iphone"],
    ["Mac (no touch)", client(MAC_SAFARI, "MacIntel", 0), "mac"],
    ["Android", client("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36", "Linux armv8l", 5), "android"],
    ["unknown", client("curl/8.7.1", "", 0), undefined],
  ] as const)("%s", (_, c, kind) => {
    expect(deviceKind(c)).toBe(kind);
  });
});

describe("observeRegistration / autoTags", () => {
  const headers = new Headers({ "user-agent": BARK_UA, "accept-language": "ja;q=1.0, en;q=0.9" });
  test("info from the Bark request, whois and the client the invite page sent", () => {
    const info = observeRegistration({
      headers,
      tailnet: { ts_machine: "zunphone", ts_hostname: "zunPhone", ts_os: "iOS", ts_user: "user@example.com", ts_ip: "100.104.30.107" },
      client: { user_agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_7_1 like Mac OS X)", platform: "iPhone", max_touch_points: 5, language: "ja-JP", screen: { w: 390, h: 844, dpr: 3 } },
      now: "T",
    });
    expect(info).toEqual({
      bark_version: "1.6.4",
      bark_build: "8",
      os_version: "iOS 26.7.1",
      user_agent: BARK_UA,
      lang: "ja;q=1.0, en;q=0.9",
      ts_machine: "zunphone",
      ts_hostname: "zunPhone",
      ts_os: "iOS",
      ts_user: "user@example.com",
      ts_ip: "100.104.30.107",
      device_kind: "iphone",
      browser_user_agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_7_1 like Mac OS X)",
      browser_platform: "iPhone",
      browser_max_touch_points: "5",
      browser_language: "ja-JP",
      browser_screen: "390x844@3",
      last_register_at: "T",
    });
    expect(autoTags(info)).toEqual({ name: "zunphone", os: "ios", lang: "ja", ts_user: "user@example.com" });
  });
  test("without whois: os from the UA, no name / ts_user; never owner", () => {
    const info = observeRegistration({ headers, tailnet: {}, client: null, now: "T" });
    expect(autoTags(info)).toEqual({ os: "ios", lang: "ja" });
    expect(autoTags(observeRegistration({ headers: new Headers(), tailnet: {}, client: null, now: "T" }))).toEqual({});
  });
  test("os: the device kind from the invite page wins over the Bark UA / Tailscale (both say iOS on an iPad); name never comes from Hostname", () => {
    const tailnet = { ts_hostname: "localhost", ts_os: "iOS" };
    expect(autoTags({ ...tailnet, device_kind: "ipad" })).toEqual({ os: "ipados" });
    expect(autoTags({ ...tailnet, device_kind: "iphone" })).toEqual({ os: "ios" });
    expect(autoTags({ ...tailnet, device_kind: "mac" })).toEqual({ os: "macos" });
    expect(autoTags({ ...tailnet, device_kind: "android" })).toEqual({ os: "android" });
    expect(autoTags(tailnet)).toEqual({ os: "ios" });
  });
});
