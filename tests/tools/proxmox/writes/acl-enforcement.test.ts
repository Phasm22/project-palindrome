import { describe, it, expect, beforeEach, vi } from "vitest";
import { ProxmoxWriteTool } from "../../../../src/tools/proxmox/writes/proxmox-write-tool";
import { isToolAuthorized } from "../../../../src/agent/tool-policy";
import type { ToolSession } from "../../../../src/agent/tool-policy";

describe("TL-2B.6: Write ACL Enforcement", () => {
  let tool: ProxmoxWriteTool;

  beforeEach(() => {
    tool = new ProxmoxWriteTool();
  });

  it("should restrict write actions to admin and ops groups only", () => {
    // Verify tool metadata has correct ACL restrictions
    expect(tool.metadata.allowedAcls).toContain("admin");
    expect(tool.metadata.allowedAcls).toContain("ops");
    expect(tool.metadata.allowedAcls).not.toContain("viewer");
  });

  it("should allow admin user to execute write actions", () => {
    const adminSession: ToolSession = {
      userId: "admin-user",
      aclGroup: "admin",
    };

    const isAuthorized = isToolAuthorized(tool, adminSession);
    expect(isAuthorized).toBe(true);
  });

  it("should allow ops user to execute write actions", () => {
    const opsSession: ToolSession = {
      userId: "ops-user",
      aclGroup: "ops",
    };

    const isAuthorized = isToolAuthorized(tool, opsSession);
    expect(isAuthorized).toBe(true);
  });

  it("should block viewer user from executing write actions", () => {
    const viewerSession: ToolSession = {
      userId: "viewer-user",
      aclGroup: "viewer",
    };

    const isAuthorized = isToolAuthorized(tool, viewerSession);
    expect(isAuthorized).toBe(false);
  });

  it("should block unauthorized ACL groups", () => {
    const unauthorizedSession: ToolSession = {
      userId: "unauthorized-user",
      aclGroup: "guest",
    };

    const isAuthorized = isToolAuthorized(tool, unauthorizedSession);
    expect(isAuthorized).toBe(false);
  });

  it("should verify tool-policy layer enforces ACL restrictions", () => {
    // This test verifies that the tool-policy layer (isToolAuthorized) correctly
    // enforces the ACL restrictions defined in tool metadata
    const viewerSession: ToolSession = {
      userId: "viewer-user",
      aclGroup: "viewer",
    };

    // Tool should have restricted ACLs
    expect(tool.metadata.allowedAcls).toBeDefined();
    expect(Array.isArray(tool.metadata.allowedAcls)).toBe(true);
    expect(tool.metadata.allowedAcls!.length).toBeGreaterThan(0);

    // Policy layer should block viewer
    const isAuthorized = isToolAuthorized(tool, viewerSession);
    expect(isAuthorized).toBe(false);

    // Policy layer should allow admin
    const adminSession: ToolSession = {
      userId: "admin-user",
      aclGroup: "admin",
    };
    const adminAuthorized = isToolAuthorized(tool, adminSession);
    expect(adminAuthorized).toBe(true);
  });
});

