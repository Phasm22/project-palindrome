import { describe, expect, test } from "bun:test";
import {
  detectVmProvenanceIntent,
  formatVmProvenanceAnswer,
} from "../../src/agent/vm-provenance";

describe("VM provenance workflow", () => {
  test("detects the generated provenance and recent-changes prompt", () => {
    expect(
      detectVmProvenanceIntent("Show provenance and recent changes for homebridge.")
    ).toEqual({ vmName: "homebridge" });
  });

  test("does not capture unrelated provenance queries", () => {
    expect(detectVmProvenanceIntent("Show provenance for homebridge.")).toBeNull();
    expect(detectVmProvenanceIntent("Show recent changes for homebridge.")).toBeNull();
  });

  test("formats only observed config and task evidence", () => {
    const answer = formatVmProvenanceAnswer({
      resolution: { name: "homebridge", node: "YANG", vmid: 100, type: "lxc" },
      configData: {
        hostname: "homebridge",
        onboot: 1,
        _provenance: {
          provenanceId: "tool://proxmox/config/123",
          timestamp: 1784522596959,
        },
      },
      tasksData: {
        tasks: [
          {
            type: "vzdump",
            status: "OK",
            user: "root@pam",
            starttime_iso8601: "2026-07-19T04:00:00.000Z",
          },
        ],
        count: 1,
        _provenance: { provenanceId: "tool://proxmox/tasks/456" },
      },
    });

    expect(answer).toContain("homebridge provenance");
    expect(answer).toContain("Provenance ID: `tool://proxmox/config/123`");
    expect(answer).toContain("Action=vzdump | Status=OK | User=root@pam");
    expect(answer).toContain("Task-query provenance: `tool://proxmox/tasks/456`");
    expect(answer).not.toContain("No recent changes");
  });

  test("reports an empty successful task query precisely", () => {
    const answer = formatVmProvenanceAnswer({
      resolution: { name: "homebridge", node: "YANG", vmid: 100, type: "lxc" },
      configData: {},
      tasksData: { tasks: [], count: 0 },
    });

    expect(answer).toContain("No matching Proxmox tasks were returned for VMID 100.");
    expect(answer).not.toContain("No recent changes reported");
  });
});
