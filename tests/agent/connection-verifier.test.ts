import { describe, expect, test } from "bun:test";
import {
  buildConnectionEndpoints,
  resolveConnectionTarget,
  verifyConnectionEndpoints,
} from "../../src/connections/verifier";

describe("connection endpoint verification", () => {
  test("builds explicit DNS and IP SSH/HTTP endpoints", () => {
    const endpoints = buildConnectionEndpoints({
      hostname: "livecheck.prox",
      ipAddresses: ["127.0.0.1", "172.16.0.99"],
      hints: [
        { service: "SSH", protocol: "ssh", port: 22, username: "ops" },
        { service: "Nginx", protocol: "http", port: 80, path: "/" },
      ],
    });
    expect(endpoints.map((endpoint) => endpoint.value)).toEqual([
      "ssh -p 22 ops@livecheck.prox",
      "ssh -p 22 ops@172.16.0.99",
      "http://livecheck.prox:80/",
      "http://172.16.0.99:80/",
    ]);
  });

  test("resolves an IP when an action only knows the hostname", async () => {
    const target = await resolveConnectionTarget(
      { hostname: "vm.prox", ipAddresses: [], hints: [{ service: "Nginx", protocol: "http", port: 80 }] },
      (async () => [{ address: "172.16.0.44", family: 4 }]) as any
    );
    expect(target.ipAddresses).toEqual(["172.16.0.44"]);
  });

  test("verifies DNS mapping, authenticated SSH, and HTTP status", async () => {
    const candidates = buildConnectionEndpoints({
      hostname: "vm.prox",
      ipAddresses: ["172.16.0.44"],
      hints: [
        { service: "SSH", protocol: "ssh", port: 22, username: "ops" },
        { service: "Nginx", protocol: "http", port: 80, path: "/" },
      ],
    });
    const updates: string[][] = [];
    const checkedDnsTransports: string[] = [];
    const verified = await verifyConnectionEndpoints(candidates, ["172.16.0.44"], {
      retryIntervalMs: 1,
      sshDeadlineMs: 50,
      httpDeadlineMs: 50,
      dnsLookup: (async () => [{ address: "172.16.0.44", family: 4 }]) as any,
      sshCheck: async (endpoint) => {
        if (endpoint.addressType === "dns") checkedDnsTransports.push(endpoint.host);
      },
      httpCheck: async (endpoint) => {
        if (endpoint.addressType === "dns") checkedDnsTransports.push(endpoint.host);
        return 200;
      },
      onUpdate: (items) => updates.push(items.map((item) => item.status)),
    });
    expect(verified.every((endpoint) => endpoint.status === "verified")).toBe(true);
    expect(verified.filter((endpoint) => endpoint.protocol === "http").every((endpoint) => endpoint.httpStatus === 200)).toBe(true);
    expect(updates.length).toBeGreaterThan(1);
    expect(checkedDnsTransports).toEqual(["172.16.0.44", "172.16.0.44"]);
  });

  test("fails DNS that never maps to the expected IP", async () => {
    const candidates = buildConnectionEndpoints({
      hostname: "vm.prox",
      ipAddresses: ["172.16.0.44"],
      hints: [{ service: "Nginx", protocol: "http", port: 80 }],
    }).filter((endpoint) => endpoint.addressType === "dns");
    const verified = await verifyConnectionEndpoints(candidates, ["172.16.0.44"], {
      retryIntervalMs: 1,
      httpDeadlineMs: 5,
      attemptTimeoutMs: 5,
      dnsLookup: (async () => [{ address: "172.16.0.45", family: 4 }]) as any,
      httpCheck: async () => 200,
    });
    expect(verified[0]?.status).toBe("failed");
    expect(verified[0]?.detail).toContain("expected 172.16.0.44");
  });

  test("aborts retry waits", async () => {
    const controller = new AbortController();
    const candidates = buildConnectionEndpoints({
      hostname: "vm.prox",
      ipAddresses: [],
      hints: [{ service: "SSH", protocol: "ssh", port: 22, username: "ops" }],
    });
    setTimeout(() => controller.abort(), 5);
    await expect(verifyConnectionEndpoints(candidates, [], {
      signal: controller.signal,
      retryIntervalMs: 100,
      sshDeadlineMs: 1000,
      dnsLookup: (async () => [{ address: "172.16.0.44", family: 4 }]) as any,
      sshCheck: async () => { throw new Error("not ready"); },
    })).rejects.toHaveProperty("name", "AbortError");
  });
});
