import type { BaseTool } from "../../tools/BaseTool";
import type { ToolSession } from "../../agent/tool-policy";
import { executeToolCall } from "../../agent/tool-executor";

interface FirewallAliasDef {
  name: string;
  type?: string;
  entries: string[];
  cidrs: string[];
}

interface FirewallRuleSummary {
  id: string;
  action: string;
  direction?: string;
  interface?: string;
  protocol?: string;
  source?: string;
  destination?: string;
  chain?: string;
}

interface ParsedPfRule {
  line: string;
  direction?: "in" | "out";
  iface?: string;
  source?: string;
  destination?: string;
  protocol?: string;
  port?: string;
}

const SERVICE_PORT_MAP: Record<string, number> = {
  ssh: 22,
  domain: 53,
  http: 80,
  https: 443,
  "ms-wbt-server": 3389,
  ntp: 123,
  mdns: 5353,
  bootps: 67,
  bootpc: 68,
};

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseInterfaceBindings(lines: string[]): Array<{ label: string; iface: string; cidr?: string }> {
  const bindings: Array<{ label: string; iface: string; cidr?: string }> = [];
  const bindingRegex = /^([a-z0-9_-]+)\s+\(([a-z0-9._-]+)\)\s+->.*?:\s+(\d+\.\d+\.\d+\.\d+\/\d+)/i;
  for (const line of lines) {
    const match = line.match(bindingRegex);
    if (!match?.[1] || !match?.[2]) continue;
    bindings.push({
      label: match[1],
      iface: match[2],
      cidr: match[3],
    });
  }
  return bindings;
}

function resolveBinding(term: string, bindings: Array<{ label: string; iface: string; cidr?: string }>): { iface?: string; cidr?: string } {
  const normalizedTerm = normalizeText(term);
  if (!normalizedTerm) return {};

  let best: { iface?: string; cidr?: string; score: number } = { score: 0 };
  for (const binding of bindings) {
    const labelNorm = normalizeText(binding.label);
    if (!labelNorm) continue;
    let score = 0;
    if (labelNorm.includes(normalizedTerm) || normalizedTerm.includes(labelNorm)) {
      score = 3;
    } else {
      const termTokens = term.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const labelTokens = binding.label.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const overlap = termTokens.filter((token) => labelTokens.includes(token)).length;
      score = overlap;
    }
    if (score > best.score) {
      best = { iface: binding.iface, cidr: binding.cidr, score };
    }
  }
  return best.score > 0 ? { iface: best.iface, cidr: best.cidr } : {};
}

function parsePassRule(line: string): ParsedPfRule | null {
  const trimmed = line.trim();
  if (!/^pass\b/i.test(trimmed)) {
    return null;
  }
  const direction = (trimmed.match(/\b(in|out)\b/i)?.[1] ?? "").toLowerCase() as "in" | "out" | "";
  const iface = trimmed.match(/\bon\s+([a-z0-9._-]+)/i)?.[1]?.toLowerCase();
  const protocol = trimmed.match(/\bproto\s+([a-z0-9._-]+)/i)?.[1]?.toLowerCase();
  const source = trimmed.match(/\bfrom\s+(.+?)\s+to\s+/i)?.[1]?.trim();
  const destination = trimmed.match(/\bto\s+(.+?)(?:\s+port\s*=|\s+flags\b|\s+keep\b|\s+label\b|$)/i)?.[1]?.trim();
  const port = trimmed.match(/\bport\s*=\s*([a-z0-9._-]+)/i)?.[1]?.toLowerCase();
  return {
    line: trimmed,
    direction: direction || undefined,
    iface,
    source,
    destination,
    protocol,
    port,
  };
}

function parsePortNumber(portToken: string | undefined): number | null {
  if (!portToken) return null;
  if (/^\d+$/.test(portToken)) {
    const numeric = Number.parseInt(portToken, 10);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return SERVICE_PORT_MAP[portToken] ?? null;
}

function labelForPort(port: number): string {
  const entry = Object.entries(SERVICE_PORT_MAP).find(([, mapped]) => mapped === port)?.[0];
  if (!entry) return String(port);
  if (entry === "ms-wbt-server") return "RDP";
  if (entry === "domain") return "DNS";
  return entry.toUpperCase();
}

function matchesRuleSide(side: string | undefined, iface: string | undefined, cidr: string | undefined, rawTerm: string): boolean {
  if (!side) return false;
  const lowered = side.toLowerCase();
  if (iface && lowered.includes(`(${iface}:network)`)) return true;
  if (cidr && lowered.includes(cidr.toLowerCase())) return true;

  const termNorm = normalizeText(rawTerm);
  const sideNorm = normalizeText(side);
  return Boolean(termNorm && sideNorm && (sideNorm.includes(termNorm) || termNorm.includes(sideNorm)));
}

function extractAliasTokens(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  const matches = value.match(/<([^>]+)>/g) ?? [];
  return matches
    .map((match) => match.replace(/[<>]/g, "").trim())
    .filter(Boolean);
}

function getReferencedAliasNames(rules: FirewallRuleSummary[]): string[] {
  const names = new Set<string>();
  for (const rule of rules) {
    const tokens = [
      ...extractAliasTokens(rule.source),
      ...extractAliasTokens(rule.destination),
    ];
    for (const token of tokens) {
      names.add(token.toLowerCase());
    }
  }
  return Array.from(names);
}

function filterAliasesForRules(
  aliases: FirewallAliasDef[],
  rules: FirewallRuleSummary[]
): FirewallAliasDef[] {
  const referencedNames = getReferencedAliasNames(rules);
  if (referencedNames.length === 0) {
    return [];
  }
  const referenced = new Set(referencedNames);
  return aliases.filter((alias) => referenced.has(alias.name.toLowerCase()));
}

function toFirewallRules(data: unknown[]): FirewallRuleSummary[] {
  return data.filter((rule): rule is FirewallRuleSummary => {
    if (!rule || typeof rule !== "object") {
      return false;
    }
    const candidate = rule as Partial<FirewallRuleSummary>;
    return typeof candidate.id === "string" && typeof candidate.action === "string";
  });
}

function formatRuleList(
  title: string,
  rules: FirewallRuleSummary[],
  aliases?: FirewallAliasDef[]
): string {
  const lines: string[] = [];
  const scopedAliases = aliases ? filterAliasesForRules(aliases, rules) : [];
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

  if (scopedAliases.length > 0) {
    lines.push("");
    lines.push("Alias definitions:");
    for (const a of scopedAliases) {
      const content = a.cidrs.length > 0 ? a.cidrs.join(", ") : (a.entries.length > 0 ? a.entries.join(", ") : "(empty)");
      lines.push(`${a.name} = ${content}`);
    }
  } else if (rules.some((r) => (r.source && String(r.source).includes("<")) || (r.destination && String(r.destination).includes("<")))) {
    lines.push("");
    lines.push("Alias definitions: (none in twin — run pce:ingest-firewall to populate from OPNsense)");
  }
  return lines.join("\n");
}

export async function countFirewallRulesChain(
  direction: "in" | "out" | undefined,
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
  const payload = result.data as { data?: unknown[] };
  const all = toFirewallRules(payload?.data ?? []);
  const rules = direction ? all.filter(r => r.direction === direction) : all;
  const passes = rules.filter(r => r.action.toLowerCase() === "pass").length;
  const blocks = rules.filter(r => r.action.toLowerCase() === "block").length;
  const nats   = rules.filter(r => r.action.toLowerCase() === "nat").length;
  const dirLabel = direction === "out" ? "outgoing" : direction === "in" ? "incoming" : "total";
  const attrs = [
    `Count=${rules.length}`,
    passes ? `PASS=${passes}` : null,
    blocks ? `BLOCK=${blocks}` : null,
    nats   ? `NAT=${nats}`   : null,
  ].filter(Boolean).join(" | ");
  return `Firewall Rule Count\n- ${dirLabel} | ${attrs}`;
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
  const rules = toFirewallRules(payload?.data ?? []);
  const aliases = payload?.aliases ?? [];
  return formatRuleList("Firewall Rules:", rules, aliases);
}

export async function allowedPortsBetweenChain(
  from: string,
  to: string,
  tools: BaseTool[],
  session: ToolSession
): Promise<string> {
  const result = await executeToolCall(
    {
      toolName: "opnsense_readonly",
      parameters: { action: "firewall_rules_list" },
    },
    tools,
    session
  );
  if (result.error) {
    throw new Error(result.error);
  }

  const payload = result.data as { rules?: unknown[] };
  const lines = (payload?.rules ?? []).filter((line): line is string => typeof line === "string");
  const bindings = parseInterfaceBindings(lines);
  const fromBinding = resolveBinding(from, bindings);
  const toBinding = resolveBinding(to, bindings);
  const parsedRules = lines
    .map(parsePassRule)
    .filter((rule): rule is ParsedPfRule => Boolean(rule));

  const matchingRules = parsedRules.filter((rule) => {
    const destinationMatch = matchesRuleSide(rule.destination, toBinding.iface, toBinding.cidr, to);
    if (!destinationMatch) return false;

    // Source match is softer: interface or explicit source side.
    if (!fromBinding.iface && !fromBinding.cidr) {
      return matchesRuleSide(rule.source, undefined, undefined, from) || rule.iface === toBinding.iface;
    }
    return (
      matchesRuleSide(rule.source, fromBinding.iface, fromBinding.cidr, from) ||
      rule.iface === fromBinding.iface
    );
  });

  const portMap = new Map<number, Set<string>>();
  for (const rule of matchingRules) {
    const port = parsePortNumber(rule.port);
    if (!port) continue;
    if (!portMap.has(port)) {
      portMap.set(port, new Set<string>());
    }
    const proto = rule.protocol?.toUpperCase() ?? "ANY";
    portMap.get(port)?.add(proto);
  }

  if (portMap.size === 0) {
    const linesOut = [
      "Access Summary",
      "No explicit allowed port entries were found for this path in current firewall rules.",
      `Path context: from=${from} to=${to}.`,
      'Ask "show full firewall rules for this path" for full rule detail.',
    ];
    return linesOut.join("\n");
  }

  const sortedPorts = Array.from(portMap.keys()).sort((a, b) => a - b);
  const allowedList = sortedPorts
    .map((port) => {
      const protoSet = Array.from(portMap.get(port) ?? []).sort().join("/");
      return `${port} (${labelForPort(port)}${protoSet && protoSet !== "ANY" ? `, ${protoSet}` : ""})`;
    })
    .join(", ");

  const linesOut = [
    "Access Summary",
    `${sortedPorts.length} explicit allowed service port(s) found for traffic from ${from} to ${to}.`,
    `Allowed ports: ${allowedList}.`,
    'Ask "show full firewall rules for this path" for full rule detail.',
  ];
  return linesOut.join("\n");
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
  const rules = toFirewallRules(payload?.data ?? []);
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
  const rules = toFirewallRules(payload?.data ?? []);
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
  const rules = toFirewallRules(payload?.data ?? []);
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
