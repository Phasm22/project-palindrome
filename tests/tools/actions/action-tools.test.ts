import { describe, it, expect } from "vitest";
import { CreateVmTool } from "../../../src/tools/actions/CreateVmTool";
import { DestroyVmTool } from "../../../src/tools/actions/DestroyVmTool";
import { CreateDnsRecordTool } from "../../../src/tools/actions/CreateDnsRecordTool";
import { SyncDhcpToDnsTool } from "../../../src/tools/actions/SyncDhcpToDnsTool";
import { SetInterfaceVlanTool } from "../../../src/tools/actions/SetInterfaceVlanTool";
import { BootstrapTool } from "../../../src/tools/actions/BootstrapTool";
import { InstallDockerTool } from "../../../src/tools/actions/InstallDockerTool";
import { InstallNginxTool } from "../../../src/tools/actions/InstallNginxTool";
import { ConfigureFirewallTool } from "../../../src/tools/actions/ConfigureFirewallTool";
import { SetStaticIpTool } from "../../../src/tools/actions/SetStaticIpTool";

const ATOMIC_TOOLS = [
  new CreateVmTool(),
  new DestroyVmTool(),
  new CreateDnsRecordTool(),
  new SyncDhcpToDnsTool(),
  new SetInterfaceVlanTool(),
  new BootstrapTool(),
  new InstallDockerTool(),
  new InstallNginxTool(),
  new ConfigureFirewallTool(),
  new SetStaticIpTool(),
];

describe("Atomic action tools — schema contracts", () => {
  it.each(ATOMIC_TOOLS.map((t) => [t.metadata.name, t]))(
    "%s: getSchema() returns valid JSON Schema with no additionalProperties: true on root parameters",
    (_name, tool) => {
      const schema = tool.getSchema();
      expect(schema).toBeDefined();
      expect(schema.parameters).toBeDefined();
      // Root parameters object must not be maximally permissive
      expect(schema.parameters.additionalProperties).not.toBe(true);
    }
  );

  it.each(ATOMIC_TOOLS.map((t) => [t.metadata.name, t]))(
    "%s: getSchema() parameters has typed properties (not empty)",
    (_name, tool) => {
      const schema = tool.getSchema();
      const props = schema.parameters?.properties ?? {};
      expect(Object.keys(props).length).toBeGreaterThan(0);
    }
  );

  it.each(ATOMIC_TOOLS.map((t) => [t.metadata.name, t]))(
    "%s: metadata has risk and allowedAcls set",
    (_name, tool) => {
      expect(tool.metadata.risk).toBeDefined();
      expect(["low", "medium", "high"]).toContain(tool.metadata.risk);
      expect(tool.metadata.allowedAcls).toBeDefined();
      expect((tool.metadata.allowedAcls ?? []).length).toBeGreaterThan(0);
    }
  );

  it("CreateVmTool: schema requires 'node' field", () => {
    const schema = new CreateVmTool().getSchema();
    const required: string[] = schema.parameters?.required ?? [];
    expect(required).toContain("node");
  });

  it("DestroyVmTool: schema has name and vmId as optional fields", () => {
    const schema = new DestroyVmTool().getSchema();
    const props = schema.parameters?.properties ?? {};
    expect(props).toHaveProperty("name");
    expect(props).toHaveProperty("vmId");
  });

  it("CreateDnsRecordTool: schema requires hostname and ip", () => {
    const schema = new CreateDnsRecordTool().getSchema();
    const required: string[] = schema.parameters?.required ?? [];
    expect(required).toContain("hostname");
    expect(required).toContain("ip");
  });

  it("ConfigureFirewallTool: schema has rules array with typed items", () => {
    const schema = new ConfigureFirewallTool().getSchema();
    const props = schema.parameters?.properties ?? {};
    expect(props.rules).toBeDefined();
    expect(props.rules.type).toBe("array");
  });

  it("BootstrapTool: has risk=medium and allowedAcls includes ops", () => {
    const tool = new BootstrapTool();
    expect(tool.metadata.risk).toBe("medium");
    expect(tool.metadata.allowedAcls).toContain("ops");
  });

  it("CreateVmTool: has risk=high and allowedAcls only includes admin", () => {
    const tool = new CreateVmTool();
    expect(tool.metadata.risk).toBe("high");
    expect(tool.metadata.allowedAcls).toEqual(["admin"]);
  });

  it("DestroyVmTool: has risk=high and allowedAcls only includes admin", () => {
    const tool = new DestroyVmTool();
    expect(tool.metadata.risk).toBe("high");
    expect(tool.metadata.allowedAcls).toEqual(["admin"]);
  });

  it("all tools expose getParameterSchema()", () => {
    for (const tool of ATOMIC_TOOLS) {
      expect(tool.getParameterSchema).toBeDefined();
      const schema = tool.getParameterSchema!();
      expect(schema).toBeDefined();
    }
  });
});
