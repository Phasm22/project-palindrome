import { describe, expect, test } from "bun:test";
import {
  formatBytes,
  formatErrorRateDetail,
  formatNodeMemory,
  formatUptime,
} from "../../dashboard/js/overview-format.js";

describe("overview memory / metrics formatting", () => {
  test("formatNodeMemory renders used/total from raw byte fields", () => {
    expect(formatNodeMemory({
      memory: 8589934592,
      maxMemory: 17179869184,
    })).toBe("8.00 GB / 16.00 GB");
  });

  test("formatNodeMemory accepts mem_normalized-shaped objects via raw", () => {
    expect(formatNodeMemory({
      memory: { value: 8, unit: "GB", raw: 8589934592 },
      maxMemory: { value: 16, unit: "GB", raw: 17179869184 },
    })).toBe("8.00 GB / 16.00 GB");
  });

  test("formatNodeMemory returns N/A when memory is missing (the prior inventory bug)", () => {
    expect(formatNodeMemory({ name: "yin", cpu: 0.1, uptime: 100 })).toBe("N/A");
    expect(formatNodeMemory({})).toBe("N/A");
  });

  test("formatBytes does not treat 0 as missing", () => {
    expect(formatBytes(0)).toBe("0.00 B");
    expect(formatBytes(null)).toBe("N/A");
    expect(formatBytes({ value: 8, unit: "GB" })).toBe("N/A");
  });

  test("formatUptime handles zero and null distinctly", () => {
    expect(formatUptime(0)).toBe("0m");
    expect(formatUptime(null)).toBe("N/A");
    expect(formatUptime(90061)).toBe("1d 1h");
  });

  test("formatErrorRateDetail prefers uncapped errorCount over recentErrors preview length", () => {
    expect(formatErrorRateDetail({
      errorCount: 162,
      recentErrors: new Array(10).fill({}),
    })).toBe("162 failures in window");

    expect(formatErrorRateDetail({
      recentErrors: new Array(10).fill({}),
    })).toBe("10 failures in window");

    expect(formatErrorRateDetail({ errorCount: 0, recentErrors: [] })).toBe("no failures in window");
  });
});
