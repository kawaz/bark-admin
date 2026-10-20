import { describe, expect, test } from "bun:test";
import { autoTags, browserFromHeaders, firstLanguage, forwardedIp, observeRegistration, parseBarkUserAgent, whoisToInfo } from "../src/device-info.ts";

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
  test("Node name (without the trailing dot), Hostinfo and LoginName", () => {
    const json = JSON.stringify({
      Node: { Name: "zunphone.tail0000.ts.net.", Hostinfo: { OS: "iOS", Hostname: "zunPhone", OSVersion: null, DeviceModel: null }, Addresses: ["100.104.30.107/32"] },
      UserProfile: { LoginName: "user@example.com", DisplayName: "u" },
    });
    expect(whoisToInfo(json, "100.104.30.107")).toEqual({ ts_name: "zunphone.tail0000.ts.net", ts_hostname: "zunPhone", ts_os: "iOS", ts_user: "user@example.com", ts_ip: "100.104.30.107" });
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

describe("browserFromHeaders", () => {
  test("User-Agent and Sec-CH-UA* only", () => {
    const h = new Headers({ "user-agent": "Mozilla/5.0 X", "sec-ch-ua": '"Chromium";v="140"', "sec-ch-ua-platform": '"macOS"', "sec-ch-ua-mobile": "?0", accept: "text/html" });
    expect(browserFromHeaders(h)).toEqual({ user_agent: "Mozilla/5.0 X", hints: { "sec-ch-ua": '"Chromium";v="140"', "sec-ch-ua-platform": '"macOS"', "sec-ch-ua-mobile": "?0" } });
    expect(browserFromHeaders(new Headers({ "user-agent": "Safari" }))).toEqual({ user_agent: "Safari" });
  });
});

describe("observeRegistration / autoTags", () => {
  const headers = new Headers({ "user-agent": BARK_UA, "accept-language": "ja;q=1.0, en;q=0.9" });
  test("info from the Bark request, whois and the invite's browser", () => {
    const info = observeRegistration({
      headers,
      tailnet: { ts_hostname: "zunPhone", ts_os: "iOS", ts_user: "user@example.com", ts_ip: "100.104.30.107" },
      browser: { user_agent: "Safari UA" },
      now: "T",
    });
    expect(info).toEqual({
      bark_version: "1.6.4",
      bark_build: "8",
      os_version: "iOS 26.7.1",
      user_agent: BARK_UA,
      lang: "ja;q=1.0, en;q=0.9",
      ts_hostname: "zunPhone",
      ts_os: "iOS",
      ts_user: "user@example.com",
      ts_ip: "100.104.30.107",
      browser_user_agent: "Safari UA",
      last_register_at: "T",
    });
    expect(autoTags(info)).toEqual({ name: "zunphone", os: "ios", lang: "ja", ts_user: "user@example.com" });
  });
  test("without whois: os from the UA, no name / ts_user; never owner", () => {
    const info = observeRegistration({ headers, tailnet: {}, browser: null, now: "T" });
    expect(autoTags(info)).toEqual({ os: "ios", lang: "ja" });
    expect(autoTags(observeRegistration({ headers: new Headers(), tailnet: {}, browser: null, now: "T" }))).toEqual({});
  });
});
