import { z } from "zod";

export enum TwinEntityType {
  COMPUTE_NODE = "compute_node",
  COMPUTE_VM = "compute_vm",
  NETWORK_INTERFACE = "network_interface",
  NETWORK_SUBNET = "network_subnet",
  FIREWALL_RULE = "firewall_rule",
}

const BaseTwinEntitySchema = z.object({
  id: z.string().min(1),
  type: z.nativeEnum(TwinEntityType),
  displayName: z.string().min(1),
  source: z.string().optional(),
  collectedAt: z.date().default(() => new Date()),
});

export const ComputeNodeEntitySchema = BaseTwinEntitySchema.extend({
  type: z.literal(TwinEntityType.COMPUTE_NODE),
  data: z.object({
    roles: z.array(z.string()).default([]),
    ipAddresses: z.array(z.string()).default([]),
    status: z.enum(["online", "degraded", "offline"]).optional(),
    cpuTotalCores: z.number().optional(),
    memoryTotalBytes: z.number().optional(),
  }),
});

export const ComputeVmEntitySchema = BaseTwinEntitySchema.extend({
  type: z.literal(TwinEntityType.COMPUTE_VM),
  data: z.object({
    nodeId: z.string(),
    state: z.enum(["running", "stopped", "paused"]).optional(),
    ipAddresses: z.array(z.string()).default([]),
    agentAvailable: z.boolean().optional(),
    cpuCores: z.number().optional(),
    memoryBytes: z.number().optional(),
  }),
});

export const NetworkInterfaceEntitySchema = BaseTwinEntitySchema.extend({
  type: z.literal(TwinEntityType.NETWORK_INTERFACE),
  data: z.object({
    nodeName: z.string(),
    vmId: z.string().nullable().optional(),
    name: z.string(),
    mac: z.string().nullable().optional(),
    ips: z.array(z.string()).default([]),
    primaryIp: z.string().nullable().optional(),
    cidrs: z.array(z.string()).default([]),
    status: z.enum(["up", "down", "unknown"]).optional(),
    vlan: z.string().nullable().optional(),
    parent: z.string().nullable().optional(),
  }),
});

export const NetworkSubnetEntitySchema = BaseTwinEntitySchema.extend({
  type: z.literal(TwinEntityType.NETWORK_SUBNET),
  data: z.object({
    cidr: z.string(),
    mask: z.number(),
    gateway: z.string().nullable().optional(),
    interfaceCount: z.number().default(0),
  }),
});

export const FirewallRuleEntitySchema = BaseTwinEntitySchema.extend({
  type: z.literal(TwinEntityType.FIREWALL_RULE),
  data: z.object({
    action: z.enum(["pass", "block", "reject", "nat", "rdr"]),
    direction: z.enum(["in", "out", "any"]).optional(),
    interface: z.string().nullable().optional(),
    protocol: z.string().nullable().optional(), // tcp, udp, icmp, etc.
    source: z.string().nullable().optional(), // IP/CIDR or "any"
    destination: z.string().nullable().optional(), // IP/CIDR or "any"
    sourcePort: z.string().nullable().optional(), // port or port range
    destinationPort: z.string().nullable().optional(), // port or port range
    flags: z.string().nullable().optional(), // quick, keep state, etc.
    ruleType: z.enum(["filter", "nat", "rdr"]).default("filter"),
    chain: z.string().nullable().optional(), // interface-based grouping
    enabled: z.boolean().default(true),
  }),
});

export const TwinEntitySchema = z.union([
  ComputeNodeEntitySchema,
  ComputeVmEntitySchema,
  NetworkInterfaceEntitySchema,
  NetworkSubnetEntitySchema,
  FirewallRuleEntitySchema,
]);

export type TwinEntity = z.infer<typeof TwinEntitySchema>;
export type ComputeNodeEntity = z.infer<typeof ComputeNodeEntitySchema>;
export type ComputeVmEntity = z.infer<typeof ComputeVmEntitySchema>;
export type NetworkInterfaceEntity = z.infer<typeof NetworkInterfaceEntitySchema>;
export type NetworkSubnetEntity = z.infer<typeof NetworkSubnetEntitySchema>;
export type FirewallRuleEntity = z.infer<typeof FirewallRuleEntitySchema>;

