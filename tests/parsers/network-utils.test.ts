import { ipInCidr, cidrOverlaps } from "../../src/parsers/network/network-utils";

test("ipInCidr returns true when IP is in /22 subnet", () => {
  expect(ipInCidr("172.16.1.5", "172.16.0.0/22")).toBe(true);
  expect(ipInCidr("172.16.0.1", "172.16.0.0/22")).toBe(true);
  expect(ipInCidr("172.16.3.254", "172.16.0.0/22")).toBe(true);
});

test("ipInCidr returns false when IP is outside subnet", () => {
  expect(ipInCidr("172.16.4.1", "172.16.0.0/22")).toBe(false);
  expect(ipInCidr("10.0.0.1", "172.16.0.0/22")).toBe(false);
});

test("ipInCidr handles /24 and /32", () => {
  expect(ipInCidr("192.168.1.10", "192.168.1.0/24")).toBe(true);
  expect(ipInCidr("192.168.2.10", "192.168.1.0/24")).toBe(false);
  expect(ipInCidr("10.0.0.1", "10.0.0.1/32")).toBe(true);
  expect(ipInCidr("10.0.0.2", "10.0.0.1/32")).toBe(false);
});

test("ipInCidr returns false for invalid input", () => {
  expect(ipInCidr("not-an-ip", "172.16.0.0/22")).toBe(false);
  expect(ipInCidr("172.16.1.5", "invalid")).toBe(false);
});

describe("cidrOverlaps", () => {
  test("matches a canonical network CIDR against a twin host-address subnet with the same mask", () => {
    // Regression for A-TQ-10: the twin stores subnets per-interface host IP
    // (e.g. "172.16.0.198/22"), not the canonical network address a user asks
    // about (e.g. "172.16.0.0/22"). These must be recognized as the same subnet.
    expect(cidrOverlaps("172.16.0.0/22", "172.16.0.198/22")).toBe(true);
    expect(cidrOverlaps("172.16.0.198/22", "172.16.0.0/22")).toBe(true);
  });

  test("does not match host-address subnets on a different physical network", () => {
    expect(cidrOverlaps("172.16.0.0/22", "192.168.71.40/22")).toBe(false);
  });

  test("does not match same-mask subnets that are actually different networks", () => {
    // Regression for A-TQ-22: matching purely by mask suffix ("/22") without
    // checking the actual network address is over-broad and matches everything.
    expect(cidrOverlaps("192.168.68.0/22", "172.16.0.198/22")).toBe(false);
  });

  test("matches a specific host CIDR against a wider requested network", () => {
    expect(cidrOverlaps("172.16.0.100/32", "172.16.0.0/22")).toBe(true);
  });

  test("returns false for malformed input", () => {
    expect(cidrOverlaps("", "172.16.0.0/22")).toBe(false);
    expect(cidrOverlaps("172.16.0.0/22", "")).toBe(false);
  });
});
