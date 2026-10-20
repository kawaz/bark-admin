import { describe, expect, test } from "bun:test";
import { clientIp, inCidr, LOOPBACK, parseCidr, trustedProxies } from "../src/client-ip.ts";

describe("clientIp", () => {
  test("from loopback, the last X-Forwarded-For entry (what the proxy saw)", () => {
    expect(clientIp("127.0.0.1", "100.104.30.107", LOOPBACK)).toBe("100.104.30.107");
    expect(clientIp("127.0.0.1", "1.2.3.4, 100.104.30.107", LOOPBACK)).toBe("100.104.30.107");
    expect(clientIp("::1", "fd7a:115c:a1e0::1", LOOPBACK)).toBe("fd7a:115c:a1e0::1");
    expect(clientIp("::ffff:127.0.0.1", "100.104.30.107", LOOPBACK)).toBe("100.104.30.107");
  });
  test("from a non-trusted address, X-Forwarded-For is ignored and the peer address is used", () => {
    expect(clientIp("100.64.0.9", "100.104.30.107", LOOPBACK)).toBe("100.64.0.9");
    expect(clientIp("::ffff:100.64.0.9", "127.0.0.1", LOOPBACK)).toBe("100.64.0.9");
  });
  test("without X-Forwarded-For (or with garbage), the peer address", () => {
    expect(clientIp("127.0.0.1", null, LOOPBACK)).toBe("127.0.0.1");
    expect(clientIp("127.0.0.1", "--help", LOOPBACK)).toBe("127.0.0.1");
    expect(clientIp(undefined, "100.104.30.107", LOOPBACK)).toBeUndefined();
  });
  test("BARK_ADMIN_TRUSTED_PROXIES adds CIDRs to loopback", () => {
    const trusted = trustedProxies("10.0.0.0/8, fd7a::/16");
    expect(clientIp("10.1.2.3", "100.104.30.107", trusted)).toBe("100.104.30.107");
    expect(clientIp("fd7a::5", "100.104.30.107", trusted)).toBe("100.104.30.107");
    expect(clientIp("11.0.0.1", "100.104.30.107", trusted)).toBe("11.0.0.1");
    expect(clientIp("127.0.0.1", "100.104.30.107", trustedProxies(undefined))).toBe("100.104.30.107");
    expect(() => trustedProxies("10.0.0.0/33")).toThrow("BARK_ADMIN_TRUSTED_PROXIES");
    expect(() => trustedProxies("nope")).toThrow("BARK_ADMIN_TRUSTED_PROXIES");
  });
});

describe("parseCidr / inCidr", () => {
  test("IPv4 and IPv6 prefixes, single addresses", () => {
    const c = parseCidr("192.168.0.0/16");
    expect(c !== null && inCidr("192.168.5.6", c)).toBe(true);
    expect(c !== null && inCidr("192.169.0.1", c)).toBe(false);
    expect(c !== null && inCidr("::1", c)).toBe(false);
    const one = parseCidr("::1");
    expect(one !== null && inCidr("0:0:0:0:0:0:0:1", one)).toBe(true);
    expect(parseCidr("1.2.3.4/x")).toBeNull();
    expect(parseCidr("300.0.0.0/8")).toBeNull();
  });
});
