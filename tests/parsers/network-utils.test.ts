import { ipInCidr } from "../../src/parsers/network/network-utils";

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
