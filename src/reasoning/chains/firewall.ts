import type { BaseTool } from "../../tools/BaseTool";
import type { ToolSession } from "../../agent/tool-policy";
import { executeToolCall } from "../../agent/tool-executor";

interface FirewallAliasDef {
  name: string;
  type?: string;
  entries: string[];
  cidrs: string[];
}

function formatRuleList(
  title: string,
  rules: Array<{
    id: string;
    action: string;
    direction?: string;
    interface?: string;
    protocol?: string;
    source?: string;
    destination?: string;
    chain?: string;
  }>,
  aliases?: FirewallAliasDef[]
): string {
  const lines: string[] = [];
  if (!rules.length) {
    lines.push(`${title}\n- None`);
  } else {
    lines.push(title);
    for (const rule of rules) {
      const parts = [
        rule.action.toUpperCase(),
        rule.direction ? `dir=${rule.direction}` : null,
        rule.interface ? `if=${rule.interface}` : null,
        rule.protocol ? `proto=${rule.protocol}` : null,
        rule.source ? `src=${rule.source}` : null,
        rule.destination ? `dst=${rule.destination}` : null,
      ].filter(Boolean);
      lines.push(`- ${parts.join(" | ")}`);
    }
  }
  if (aliases && aliases.length > 0) {
    lines.push("");
    lines.push("Alias definitions:");
    for (const a of aliases) {
      const content = a.cidrs.length > 0 ? a.cidrs.join(", ") : (a.entries.length > 0 ? a.entries.join(", ") : "(empty)");
      lines.push(`${a.name} = ${content}`);
    }
  } else if (rules.some((r) => (r.source && String(r.source).includes("<")) || (r.destination && String(r.destination).includes("<")))) {
    lines.push("");
    lines.push("Alias definitions: (none in twin — run pce:ingest-firewall to populate from OPNsense)");
  }
  return lines.join("\n");
}

export async function listFirewallRulesChain(
  tools: BaseTool[],
  session: ToolSession
): Promise<string> {
  const result = await executeToolCall(
    { toolName: "twin_query", parameters: { operation: "firewall_list_rules" } },
    tools,
    session
  );
  if (result.error) {
    throw new Error(result.error);
  }
  const payload = result.data as { data?: unknown[]; aliases?: FirewallAliasDef[] };
  const rules = payload?.data ?? [];
  const aliases = payload?.aliases ?? [];
  return formatRuleList("Firewall Rules:", rules, aliases);
}

export async function firewallRulesByChainChain(
  chain: string,
  tools: BaseTool[],
  session: ToolSession
): Promise<string> {
  const result = await executeToolCall(
    {
      toolName: "twin_query",
      parameters: { operation: "firewall_rules_by_chain", params: { chain } },
    },
    tools,
    session
  );
  if (result.error) {
    throw new Error(result.error);
  }
  const payload = result.data as { data?: unknown[]; aliases?: FirewallAliasDef[] };
  const rules = payload?.data ?? [];
  const aliases = payload?.aliases ?? [];
  return formatRuleList(`Firewall Rules for ${chain}:`, rules, aliases);
}

export async function rulesAllowingSubnetChain(
  subnet: string,
  tools: BaseTool[],
  session: ToolSession
): Promise<string> {
  const result = await executeToolCall(
    {
      toolName: "twin_query",
      parameters: {
        operation: "firewall_rules_allowing_subnet",
        params: { subnet },
      },
    },
    tools,
    session
  );
  if (result.error) {
    throw new Error(result.error);
  }
  const payload = result.data as { data?: unknown[]; aliases?: FirewallAliasDef[] };
  const rules = payload?.data ?? [];
  const aliases = payload?.aliases ?? [];
  return formatRuleList(`Rules Allowing Access to ${subnet}:`, rules, aliases);
}

export async function rulesBlockingSubnetChain(
  subnet: string,
  tools: BaseTool[],
  session: ToolSession
): Promise<string> {
  const result = await executeToolCall(
    {
      toolName: "twin_query",
      parameters: {
        operation: "firewall_rules_blocking_subnet",
        params: { subnet },
      },
    },
    tools,
    session
  );
  if (result.error) {
    throw new Error(result.error);
  }
  const payload = result.data as { data?: unknown[]; aliases?: FirewallAliasDef[] };
  const rules = payload?.data ?? [];
  const aliases = payload?.aliases ?? [];
  return formatRuleList(`Rules Blocking Access to ${subnet}:`, rules, aliases);
}

export async function exposureMapChain(
  vmId: string | undefined,
  tools: BaseTool[],
  session: ToolSession
): Promise<string> {
  const result = await executeToolCall(
    {
      toolName: "twin_query",
      parameters: {
        operation: "firewall_exposure_map",
        params: vmId ? { vmId } : {},
      },
    },
    tools,
    session
  );
  if (result.error) {
    throw new Error(result.error);
  }
  const payload = result.data as any;
  const exposures = payload?.data ?? [];

  if (!exposures.length) {
    return "No exposure data found.";
  }

  const lines = ["VM Exposure Map:"];
  for (const exp of exposures) {
    const parts = [
      `VM: ${exp.vmName} (${exp.vmId})`,
      `Subnet: ${exp.subnet}`,
      exp.allowedBy?.length ? `Allowed by: ${exp.allowedBy.length} rule(s)` : null,
      exp.blockedBy?.length ? `Blocked by: ${exp.blockedBy.length} rule(s)` : null,
    ].filter(Boolean);
    lines.push(`- ${parts.join(" | ")}`);
  }
  return lines.join("\n");
}

export async function reachabilityFromSubnetChain(
  subnet: string,
  vmId: string | undefined,
  tools: BaseTool[],
  session: ToolSession
): Promise<string> {
  const result = await executeToolCall(
    {
      toolName: "twin_query",
      parameters: {
        operation: "firewall_reachability_from_subnet",
        params: vmId ? { subnet, vmId } : { subnet },
      },
    },
    tools,
    session
  );
  if (result.error) {
    throw new Error(result.error);
  }
  const payload = result.data as any;
  const items = payload?.data ?? [];
  if (!items.length) {
    return `No reachability data found for ${subnet}.`;
  }

  const lines = [`Reachability from subnet ${subnet}:`];
  for (const item of items) {
    const parts = [
      `VM: ${item.vmName} (${item.vmId})`,
      item.allowedBy?.length ? `Allowed by: ${item.allowedBy.length} rule(s)` : null,
      item.blockedBy?.length ? `Blocked by: ${item.blockedBy.length} rule(s)` : null,
    ].filter(Boolean);
    lines.push(`- ${parts.join(" | ")}`);
  }
  return lines.join("\n");
}

export async function reachabilityFromChainChain(
  chain: string,
  tools: BaseTool[],
  session: ToolSession
): Promise<string> {
  const result = await executeToolCall(
    {
      toolName: "twin_query",
      parameters: { operation: "firewall_reachability_from_chain", params: { chain } },
    },
    tools,
    session
  );
  if (result.error) {
    throw new Error(result.error);
  }
  const payload = result.data as any;
  const items = payload?.data ?? [];
  if (!items.length) {
    return `No reachability data found for ${chain}.`;
  }

  const lines = [`VMs reachable from ${chain}:`];
  for (const item of items) {
    const parts = [
      `VM: ${item.vmName} (${item.vmId})`,
      `Subnet: ${item.subnet}`,
      item.allowedBy?.length ? `Allowed by: ${item.allowedBy.length} rule(s)` : null,
      item.blockedBy?.length ? `Blocked by: ${item.blockedBy.length} rule(s)` : null,
    ].filter(Boolean);
    lines.push(`- ${parts.join(" | ")}`);
  }
  return lines.join("\n");
}

export async function ruleImpactChain(
  ruleId: string,
  tools: BaseTool[],
  session: ToolSession
): Promise<string> {
  const result = await executeToolCall(
    {
      toolName: "twin_query",
      parameters: { operation: "firewall_rule_impact", params: { ruleId } },
    },
    tools,
    session
  );
  if (result.error) {
    throw new Error(result.error);
  }
  const payload = result.data as any;
  const impact = payload?.data ?? null;
  if (!impact || !impact.subnets?.length) {
    return `No impacted subnets found for rule ${ruleId}.`;
  }

  const lines = [`Impact for rule ${ruleId}:`];
  for (const subnet of impact.subnets) {
    const vmList = (subnet.vms || [])
      .map((vm: any) => `${vm.vmName} (${vm.vmId})`)
      .join(", ");
    lines.push(`- ${subnet.subnet} | VMs: ${vmList || "none"}`);
  }
  return lines.join("\n");
}

