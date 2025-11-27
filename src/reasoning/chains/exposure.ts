import { TwinQueryTool } from "../../tools/TwinQueryTool";
import { BaseTool } from "../../tools/base-tool";
import { AgentSession } from "../../agent/session";

/**
 * Analyze full exposure for a specific VM.
 */
export async function analyzeVmExposureChain(
  vmId: string,
  tools: Map<string, BaseTool>,
  session: AgentSession
): Promise<string> {
  const twinQuery = tools.get("twin_query") as TwinQueryTool;
  if (!twinQuery) {
    return "Error: twin_query tool not available";
  }

  const result = await twinQuery.execute({
    operation: "exposure_vm_analysis",
    params: { vmId },
  });

  if ("error" in result) {
    return `Error analyzing VM exposure: ${result.error}`;
  }

  const data = result.data as { kind: string; vmId: string; data: any };
  const exposure = data.data;

  const lines = [
    `VM Exposure Analysis: ${exposure.vmName} (${exposure.vmId})`,
    exposure.nodeName ? `Node: ${exposure.nodeName}` : null,
    `Exposure Level: ${exposure.exposureLevel.toUpperCase()}`,
    "",
  ].filter(Boolean);

  if (exposure.interfaces.length === 0) {
    lines.push("No network interfaces found for this VM.");
  } else {
    for (const iface of exposure.interfaces) {
      lines.push(`Interface: ${iface.interfaceName}`);
      if (iface.subnet) {
        lines.push(`  Subnet: ${iface.subnet}`);
      }
      if (iface.allowedBy.length > 0) {
        lines.push(`  Allowed by ${iface.allowedBy.length} rule(s):`);
        for (const rule of iface.allowedBy) {
          const parts = [
            rule.action.toUpperCase(),
            rule.direction ? `dir=${rule.direction}` : null,
            rule.protocol ? `proto=${rule.protocol}` : null,
          ].filter(Boolean);
          lines.push(`    - ${parts.join(" | ")} (${rule.ruleId})`);
        }
      }
      if (iface.blockedBy.length > 0) {
        lines.push(`  Blocked by ${iface.blockedBy.length} rule(s):`);
        for (const rule of iface.blockedBy) {
          const parts = [
            rule.action.toUpperCase(),
            rule.direction ? `dir=${rule.direction}` : null,
            rule.protocol ? `proto=${rule.protocol}` : null,
          ].filter(Boolean);
          lines.push(`    - ${parts.join(" | ")} (${rule.ruleId})`);
        }
      }
      if (iface.allowedBy.length === 0 && iface.blockedBy.length === 0) {
        lines.push("  No firewall rules affecting this interface.");
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

/**
 * List VMs exposed to a specific subnet.
 */
export async function listVmsExposedToSubnetChain(
  subnetCidr: string,
  tools: Map<string, BaseTool>,
  session: AgentSession
): Promise<string> {
  const twinQuery = tools.get("twin_query") as TwinQueryTool;
  if (!twinQuery) {
    return "Error: twin_query tool not available";
  }

  const result = await twinQuery.execute({
    operation: "exposure_vms_by_subnet",
    params: { subnet: subnetCidr },
  });

  if ("error" in result) {
    return `Error finding exposed VMs: ${result.error}`;
  }

  const data = result.data as { kind: string; subnet: string; data: any[] };
  const vms = data.data;

  if (vms.length === 0) {
    return `No VMs found exposed to subnet ${subnetCidr}.`;
  }

  const lines = [
    `VMs Exposed to Subnet: ${subnetCidr}`,
    `Found ${vms.length} VM(s):`,
    "",
  ];

  for (const vm of vms) {
    lines.push(`- ${vm.vmName} (${vm.vmId})`);
    if (vm.nodeName) {
      lines.push(`  Node: ${vm.nodeName}`);
    }
    lines.push(`  Subnet: ${vm.subnet}`);
    lines.push(`  Allow Rules: ${vm.allowRules}, Block Rules: ${vm.blockRules}`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Show attack path from source subnet to target VM.
 */
export async function attackPathChain(
  fromSubnet: string,
  toVmId: string,
  tools: Map<string, BaseTool>,
  session: AgentSession
): Promise<string> {
  const twinQuery = tools.get("twin_query") as TwinQueryTool;
  if (!twinQuery) {
    return "Error: twin_query tool not available";
  }

  const result = await twinQuery.execute({
    operation: "exposure_path",
    params: { fromSubnet, toVmId },
  });

  if ("error" in result) {
    return `Error finding attack path: ${result.error}`;
  }

  const data = result.data as { kind: string; fromSubnet: string; toVmId: string; data: any };
  const path = data.data;

  const lines = [
    `Attack Path Analysis`,
    `From: ${path.fromSubnet}`,
    `To: ${path.toVmName} (${path.toVm})`,
    `Reachable: ${path.reachable ? "YES" : "NO"}`,
    "",
  ];

  if (path.reachable && path.path.length > 0) {
    lines.push("Path:");
    for (const step of path.path) {
      lines.push(
        `  ${step.step}. ${step.entityType} (${step.entityName}) --[${step.relationship}]-->`
      );
    }
  } else if (path.reachable) {
    lines.push("Path exists but details not available.");
  } else {
    lines.push("No path found from source to target.");
  }

  return lines.join("\n");
}

/**
 * List all VMs with internet/WAN exposure.
 */
export async function listInternetExposedVmsChain(
  tools: Map<string, BaseTool>,
  session: AgentSession
): Promise<string> {
  const twinQuery = tools.get("twin_query") as TwinQueryTool;
  if (!twinQuery) {
    return "Error: twin_query tool not available";
  }

  const result = await twinQuery.execute({
    operation: "exposure_internet_exposed",
    params: {},
  });

  if ("error" in result) {
    return `Error finding internet-exposed VMs: ${result.error}`;
  }

  const data = result.data as { kind: string; data: any[] };
  const vms = data.data;

  if (vms.length === 0) {
    return "No VMs found with internet exposure.";
  }

  const lines = [
    `Internet-Exposed VMs`,
    `Found ${vms.length} VM(s) with inbound firewall rules:`,
    "",
  ];

  for (const vm of vms) {
    lines.push(`- ${vm.vmName} (${vm.vmId})`);
    if (vm.nodeName) {
      lines.push(`  Node: ${vm.nodeName}`);
    }
    lines.push(`  Subnet: ${vm.subnet}`);
    lines.push(`  Exposure Rules: ${vm.exposureRules}`);
    lines.push("");
  }

  return lines.join("\n");
}

