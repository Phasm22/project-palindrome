import { z } from "zod";

export enum TwinEntityType {
  COMPUTE_NODE = "compute_node",
  COMPUTE_VM = "compute_vm",
  NETWORK_INTERFACE = "network_interface",
  NETWORK_SUBNET = "network_subnet",
  FIREWALL_RULE = "firewall_rule",
  FIREWALL_ALIAS = "firewall_alias",
  STORAGE = "storage",
  SWITCH = "switch",
  SWITCH_PORT = "switch_port",
}

// Whether a fact was hand-maintained (topology.yaml) or parsed from a real
// device config/live read. Kept distinct from `source` (which system produced
// it, e.g. "proxmox"/"opnsense") because the two axes are independent and a
// fact's provenance determines how much to trust it when declared and
// observed facts disagree — see docs/network/ and the truth hierarchy in
// the lvl3 vision notes.
export const FactProvenanceSchema = z.enum(["declared", "observed"]);
export type FactProvenance = z.infer<typeof FactProvenanceSchema>;

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
    provenance: FactProvenanceSchema.optional(),
    roles: z.array(z.string()).default([]),
    ipAddresses: z.array(z.string()).default([]),
    status: z.enum(["online", "degraded", "offline"]).optional(),
    cpuTotalCores: z.number().optional(),
    memoryTotalBytes: z.number().optional(),
    temperature: z.object({
      max: z.number().optional(),
      average: z.number().optional(),
      sensors: z.number().optional(),
      readings: z.array(z.object({
        sensor: z.string(),
        label: z.string().optional(),
        value: z.number(),
        unit: z.literal("celsius"),
        max: z.number().optional(),
        crit: z.number().optional(),
      })).optional(),
    }).optional(),
  }),
});

export const ComputeVmEntitySchema = BaseTwinEntitySchema.extend({
  type: z.literal(TwinEntityType.COMPUTE_VM),
  data: z.object({
    provenance: FactProvenanceSchema.optional(),
    nodeId: z.string(),
    state: z.enum(["running", "stopped", "paused"]).optional(),
    ipAddresses: z.array(z.string()).default([]),
    agentAvailable: z.boolean().optional(),
    cpuCores: z.number().optional(),
    memoryBytes: z.number().optional(),
    vmKind: z.enum(["qemu", "lxc"]).optional(),
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
    translationTarget: z.string().nullable().optional(), // NAT/rdr address after translation
    translationPort: z.string().nullable().optional(), // rdr port after translation
    flags: z.string().nullable().optional(), // quick, keep state, etc.
    ruleType: z.enum(["filter", "nat", "rdr"]).default("filter"),
    chain: z.string().nullable().optional(), // interface-based grouping
    enabled: z.boolean().default(true),
  }),
});

export const FirewallAliasEntitySchema = BaseTwinEntitySchema.extend({
  type: z.literal(TwinEntityType.FIREWALL_ALIAS),
  data: z.object({
    name: z.string(),
    aliasType: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    entries: z.array(z.string()).default([]),
    cidrs: z.array(z.string()).default([]),
  }),
});

export const StorageEntitySchema = BaseTwinEntitySchema.extend({
  type: z.literal(TwinEntityType.STORAGE),
  data: z.object({
    nodeName: z.string(), // Node where storage is located
    storageName: z.string(), // Storage identifier (e.g., "local", "local-lvm", "nfs-share")
    storageType: z.string(), // "dir", "lvm", "lvmthin", "nfs", "cephfs", etc.
    content: z.array(z.string()).default([]), // ["images", "iso", "backup", etc.]
    shared: z.boolean().default(false), // Whether storage is shared across nodes
    active: z.boolean().default(true),
    enabled: z.boolean().default(true),
    usedBytes: z.number().optional(), // Storage used in bytes
    availBytes: z.number().optional(), // Storage available in bytes
    totalBytes: z.number().optional(), // Total storage in bytes
    usedFraction: z.number().optional(), // Used fraction (0.0-1.0)
  }),
});

export const SwitchEntitySchema = BaseTwinEntitySchema.extend({
  type: z.literal(TwinEntityType.SWITCH),
  data: z.object({
    hostname: z.string(),
    model: z.string().nullable().optional(),
    managementIps: z.array(z.string()).default([]),
    role: z.string().nullable().optional(), // e.g. "lab-core", "home-uplink"
    provenance: FactProvenanceSchema,
    // Present on the observed record when topology.yaml's hand-maintained
    // switch: block disagrees with the real parsed config — preserved
    // instead of silently overwritten. See docs/network/.
    declaredTrunkPorts: z.array(z.string()).optional(),
    declaredVlans: z.array(z.number()).optional(),
  }),
});

export const SwitchPortEntitySchema = BaseTwinEntitySchema.extend({
  type: z.literal(TwinEntityType.SWITCH_PORT),
  data: z.object({
    switchId: z.string(),
    portName: z.string(), // e.g. "Gi0/41"
    mode: z.enum(["access", "trunk"]).nullable().optional(),
    accessVlan: z.number().nullable().optional(),
    trunkVlans: z.array(z.number()).default([]),
    description: z.string().nullable().optional(),
    provenance: FactProvenanceSchema,
  }),
});

export const TwinEntitySchema = z.union([
  ComputeNodeEntitySchema,
  ComputeVmEntitySchema,
  NetworkInterfaceEntitySchema,
  NetworkSubnetEntitySchema,
  FirewallRuleEntitySchema,
  FirewallAliasEntitySchema,
  StorageEntitySchema,
  SwitchEntitySchema,
  SwitchPortEntitySchema,
]);

export type TwinEntity = z.infer<typeof TwinEntitySchema>;
export type ComputeNodeEntity = z.infer<typeof ComputeNodeEntitySchema>;
export type ComputeVmEntity = z.infer<typeof ComputeVmEntitySchema>;
export type NetworkInterfaceEntity = z.infer<typeof NetworkInterfaceEntitySchema>;
export type NetworkSubnetEntity = z.infer<typeof NetworkSubnetEntitySchema>;
export type FirewallRuleEntity = z.infer<typeof FirewallRuleEntitySchema>;
export type FirewallAliasEntity = z.infer<typeof FirewallAliasEntitySchema>;
export type StorageEntity = z.infer<typeof StorageEntitySchema>;
export type SwitchEntity = z.infer<typeof SwitchEntitySchema>;
export type SwitchPortEntity = z.infer<typeof SwitchPortEntitySchema>;
