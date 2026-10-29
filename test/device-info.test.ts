import { describe, expect, test } from "bun:test";
import { autoTags, deviceKind, firstLanguage, observeRegistration, parseBarkUserAgent, serverHost, whoisToInfo } from "../src/device-info.ts";

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
    // マシン名もホスト名も name タグには使わない
    expect(autoTags(info).name).toBeUndefined();
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

describe("serverHost", () => {
  test("the Host header without the port, lower-cased", () => {
    expect(serverHost("bark.kawaz-mbp.kawaz.jp")).toBe("bark.kawaz-mbp.kawaz.jp");
    expect(serverHost("Bark.Example:8443")).toBe("bark.example");
    expect(serverHost("127.0.0.1:8086")).toBe("127.0.0.1");
    expect(serverHost("[::1]:8086")).toBe("[::1]");
  });
  test("missing or unparsable Host gives nothing", () => {
    expect(serverHost(null)).toBeUndefined();
    expect(serverHost("")).toBeUndefined();
    expect(serverHost("bad host")).toBeUndefined();
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
    expect(autoTags(info)).toEqual({ name: "iphone", os: "ios", lang: "ja", ts_user: "user@example.com" });
  });
  test("without whois and without the invite page's client (the standard path): name / os from the Bark UA (iOS → iphone), no ts_user; never owner", () => {
    const info = observeRegistration({ headers, tailnet: undefined, client: null, now: "T" });
    expect(info).not.toHaveProperty("ts_ip");
    expect(autoTags(info)).toEqual({ name: "iphone", os: "ios", lang: "ja" });
    expect(autoTags(observeRegistration({ headers: new Headers(), tailnet: undefined, client: null, now: "T" }))).toEqual({});
  });
  test("name / os: the device kind from the invite page wins over the Bark UA (which says iOS on an iPad); Tailscale is not used", () => {
    const ua = { os_version: "iOS 26.7.1", ts_machine: "ipad-pro-12-9-gen-5", ts_hostname: "localhost", ts_os: "iOS" };
    expect(autoTags({ ...ua, device_kind: "ipad" })).toEqual({ name: "ipad", os: "ipados" });
    expect(autoTags({ ...ua, device_kind: "iphone" })).toEqual({ name: "iphone", os: "ios" });
    expect(autoTags({ ...ua, device_kind: "mac" })).toEqual({ name: "mac", os: "macos" });
    expect(autoTags({ ...ua, device_kind: "android" })).toEqual({ name: "android", os: "android" });
    expect(autoTags(ua)).toEqual({ name: "iphone", os: "ios" });
    // Bark の UA の OS が iOS でなければ name は付けず、os は UA の OS 名
    expect(autoTags({ os_version: "macOS 15.1" })).toEqual({ os: "macos" });
    // Tailscale だけでは何も付けない
    expect(autoTags({ ts_machine: "zunphone", ts_os: "iOS" })).toEqual({});
  });
});
