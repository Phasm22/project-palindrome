import { describe, it, expect } from "vitest";
import {
  normalizeMemory,
  normalizeTimestamp,
  normalizeStatus,
  normalizeBoolean,
  flattenProxmoxObject,
  normalizeProxmoxResponse,
} from "../../../../src/tools/proxmox/readonly/normalization";

describe("TL-2A.5: Structured Normalization Test", () => {
  describe("normalizeMemory", () => {
    it("should convert bytes to MB for values < 1GB", () => {
      const result = normalizeMemory(1024 * 1024 * 512); // 512 MB
      expect(result.unit).toBe("MB");
      expect(result.value).toBe(512);
      expect(result.raw).toBe(536870912);
    });

    it("should convert bytes to GB for values >= 1GB", () => {
      const result = normalizeMemory(1024 * 1024 * 1024 * 2); // 2 GB
      expect(result.unit).toBe("GB");
      expect(result.value).toBe(2);
      expect(result.raw).toBe(2147483648);
    });

    it("should handle string values", () => {
      const result = normalizeMemory("1073741824"); // 1 GB as string
      expect(result.unit).toBe("GB");
      expect(result.value).toBe(1);
    });

    it("should handle undefined/null values", () => {
      const result = normalizeMemory(undefined);
      expect(result.value).toBe(0);
      expect(result.unit).toBe("MB");
    });

    it("should round to 2 decimal places", () => {
      const result = normalizeMemory(1024 * 1024 * 1024 * 1.567); // 1.567 GB
      expect(result.value).toBe(1.57);
      expect(result.unit).toBe("GB");
    });
  });

  describe("normalizeTimestamp", () => {
    it("should convert Unix timestamp (seconds) to ISO8601", () => {
      const timestamp = 1609459200; // 2021-01-01T00:00:00Z
      const result = normalizeTimestamp(timestamp);
      expect(result).toBe("2021-01-01T00:00:00.000Z");
    });

    it("should convert Unix timestamp (milliseconds) to ISO8601", () => {
      const timestamp = 1609459200000; // 2021-01-01T00:00:00Z in milliseconds
      const result = normalizeTimestamp(timestamp);
      expect(result).toBe("2021-01-01T00:00:00.000Z");
    });

    it("should handle string timestamps", () => {
      const result = normalizeTimestamp("1609459200");
      expect(result).toBe("2021-01-01T00:00:00.000Z");
    });

    it("should return null for invalid timestamps", () => {
      expect(normalizeTimestamp(undefined)).toBeNull();
      expect(normalizeTimestamp(null as any)).toBeNull();
      expect(normalizeTimestamp(0)).toBeNull();
      expect(normalizeTimestamp(-1)).toBeNull();
      expect(normalizeTimestamp("invalid")).toBeNull();
    });
  });

  describe("normalizeStatus", () => {
    it("should normalize status strings to lowercase", () => {
      expect(normalizeStatus("RUNNING")).toBe("running");
      expect(normalizeStatus("Stopped")).toBe("stopped");
      expect(normalizeStatus("  ONLINE  ")).toBe("online");
    });

    it("should map numeric status codes", () => {
      expect(normalizeStatus(0)).toBe("stopped");
      expect(normalizeStatus(1)).toBe("running");
    });

    it("should handle unknown statuses", () => {
      expect(normalizeStatus("custom_status")).toBe("custom_status");
      expect(normalizeStatus(999)).toBe("999");
    });

    it("should handle undefined/null", () => {
      expect(normalizeStatus(undefined)).toBe("unknown");
      expect(normalizeStatus(null as any)).toBe("unknown");
    });
  });

  describe("normalizeBoolean", () => {
    it("should handle boolean values", () => {
      expect(normalizeBoolean(true)).toBe(true);
      expect(normalizeBoolean(false)).toBe(false);
    });

    it("should handle numeric values", () => {
      expect(normalizeBoolean(1)).toBe(true);
      expect(normalizeBoolean(0)).toBe(false);
      expect(normalizeBoolean(-1)).toBe(true);
    });

    it("should handle string values", () => {
      expect(normalizeBoolean("true")).toBe(true);
      expect(normalizeBoolean("false")).toBe(false);
      expect(normalizeBoolean("1")).toBe(true);
      expect(normalizeBoolean("0")).toBe(false);
      expect(normalizeBoolean("yes")).toBe(true);
      expect(normalizeBoolean("no")).toBe(false);
    });

    it("should handle other types", () => {
      expect(normalizeBoolean(null)).toBe(false);
      expect(normalizeBoolean(undefined)).toBe(false);
      expect(normalizeBoolean({})).toBe(false);
    });
  });

  describe("flattenProxmoxObject", () => {
    it("should flatten nested objects", () => {
      const input = {
        node: "pve1",
        config: {
          cpu: 8,
          memory: 16384,
        },
        status: "online",
      };

      const result = flattenProxmoxObject(input);
      expect(result.node).toBe("pve1");
      expect(result.config_cpu).toBe(8);
      expect(result.config_memory).toBe(16384);
      expect(result.status).toBe("online");
    });

    it("should remove internal fields", () => {
      const input = {
        node: "pve1",
        _tmp: "temp",
        digest: "abc123",
        csum: "def456",
        _internal: "internal",
        status: "online",
      };

      const result = flattenProxmoxObject(input);
      expect(result._tmp).toBeUndefined();
      expect(result.digest).toBeUndefined();
      expect(result.csum).toBeUndefined();
      expect(result._internal).toBeUndefined();
      expect(result.node).toBe("pve1");
      expect(result.status).toBe("online");
    });

    it("should handle arrays", () => {
      const input = [
        { node: "pve1", status: "online" },
        { node: "pve2", status: "offline" },
      ];

      const result = flattenProxmoxObject(input);
      expect(Array.isArray(result)).toBe(true);
      expect(result[0].node).toBe("pve1");
      expect(result[1].node).toBe("pve2");
    });

    it("should handle null and undefined", () => {
      expect(flattenProxmoxObject(null)).toEqual({});
      expect(flattenProxmoxObject(undefined)).toEqual({});
    });

    it("should preserve primitive values", () => {
      expect(flattenProxmoxObject("string")).toBe("string");
      expect(flattenProxmoxObject(123)).toBe(123);
      expect(flattenProxmoxObject(true)).toBe(true);
    });
  });

  describe("normalizeProxmoxResponse", () => {
    it("should normalize memory fields", () => {
      const input = {
        memory: 1073741824, // 1 GB
        maxmem: 2147483648, // 2 GB
        mem: 536870912, // 512 MB
      };

      const result = normalizeProxmoxResponse(input);
      expect(result.memory_normalized).toBeDefined();
      expect(result.memory_normalized.unit).toBe("GB");
      expect(result.memory_normalized.value).toBe(1);
      expect(result.maxmem_normalized.unit).toBe("GB");
      expect(result.mem_normalized.unit).toBe("MB");
    });

    it("should normalize timestamp fields", () => {
      const input = {
        uptime: 1609459200,
        time: 1609459200000,
        created: 1609459200,
      };

      const result = normalizeProxmoxResponse(input);
      expect(result.uptime_iso8601).toBe("2021-01-01T00:00:00.000Z");
      expect(result.time_iso8601).toBe("2021-01-01T00:00:00.000Z");
      expect(result.created_iso8601).toBe("2021-01-01T00:00:00.000Z");
    });

    it("should normalize status fields", () => {
      const input = {
        status: "RUNNING",
      };

      const result = normalizeProxmoxResponse(input);
      expect(result.status_normalized).toBe("running");
    });

    it("should flatten nested structures", () => {
      const input = {
        node: "pve1",
        config: {
          cpu: 8,
          memory: 16384,
        },
      };

      const result = normalizeProxmoxResponse(input, { flatten: true });
      expect(result.config_cpu).toBe(8);
      expect(result.config_memory).toBe(16384);
    });

    it("should handle arrays", () => {
      const input = [
        { node: "pve1", memory: 1073741824 },
        { node: "pve2", memory: 2147483648 },
      ];

      const result = normalizeProxmoxResponse(input);
      expect(Array.isArray(result)).toBe(true);
      expect(result[0].memory_normalized).toBeDefined();
      expect(result[1].memory_normalized).toBeDefined();
    });

    it("should respect normalization options", () => {
      const input = {
        memory: 1073741824,
        uptime: 1609459200,
        config: { cpu: 8 },
      };

      const result = normalizeProxmoxResponse(input, {
        normalizeMemory: false,
        normalizeTimestamps: false,
        flatten: false,
      });

      expect(result.memory_normalized).toBeUndefined();
      expect(result.uptime_iso8601).toBeUndefined();
      expect(result.config).toBeDefined();
      expect(result.config.cpu).toBe(8);
    });

    it("should handle null and undefined", () => {
      expect(normalizeProxmoxResponse(null)).toBeNull();
      expect(normalizeProxmoxResponse(undefined)).toBeNull();
    });
  });

  describe("Integration: Full Normalization Example", () => {
    it("should normalize a complete Proxmox node response", () => {
      const input = {
        node: "pve1",
        status: "online",
        cpu: 0.5,
        maxcpu: 8,
        maxmem: 17179869184, // 16 GB
        mem: 8589934592, // 8 GB
        uptime: 86400,
        _tmp: "should be removed",
        config: {
          kversion: "5.15",
          pveversion: "8.0",
        },
      };

      const result = normalizeProxmoxResponse(input);

      // Check memory normalization
      expect(result.maxmem_normalized.unit).toBe("GB");
      expect(result.maxmem_normalized.value).toBe(16);
      expect(result.mem_normalized.unit).toBe("GB");
      expect(result.mem_normalized.value).toBe(8);

      // Check timestamp normalization
      expect(result.uptime_iso8601).toBeDefined();
      expect(result.uptime_iso8601).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

      // Check status normalization
      expect(result.status_normalized).toBe("online");

      // Check flattening
      expect(result.config_kversion).toBe("5.15");
      expect(result.config_pveversion).toBe("8.0");

      // Check internal fields removed
      expect(result._tmp).toBeUndefined();

      // Check original fields preserved
      expect(result.node).toBe("pve1");
      expect(result.cpu).toBe(0.5);
    });
  });
});

