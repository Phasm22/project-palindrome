import type { BaseTool } from "../../tools/BaseTool";
import type { ToolSession } from "../../agent/tool-policy";
import { executeToolCall } from "../../agent/tool-executor";

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
  }>
): string {
  if (!rules.length) {
    return `${title}\n- None`;
  }

  const lines = [title];
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
  const payload = result.data as any;
  const rules = payload?.data ?? [];
  return formatRuleList("Firewall Rules:", rules);
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
  const payload = result.data as any;
  const rules = payload?.data ?? [];
  return formatRuleList(`Firewall Rules for ${chain}:`, rules);
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
  const payload = result.data as any;
  const rules = payload?.data ?? [];
  return formatRuleList(`Rules Allowing Access to ${subnet}:`, rules);
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
  const payload = result.data as any;
  const rules = payload?.data ?? [];
  return formatRuleList(`Rules Blocking Access to ${subnet}:`, rules);
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

