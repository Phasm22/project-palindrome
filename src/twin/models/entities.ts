import { z } from "zod";

export enum TwinEntityType {
  COMPUTE_NODE = "compute_node",
  COMPUTE_VM = "compute_vm",
  NETWORK_INTERFACE = "network_interface",
  NETWORK_SUBNET = "network_subnet",
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

export const TwinEntitySchema = z.union([
  ComputeNodeEntitySchema,
  ComputeVmEntitySchema,
  NetworkInterfaceEntitySchema,
  NetworkSubnetEntitySchema,
]);

export type TwinEntity = z.infer<typeof TwinEntitySchema>;
export type ComputeNodeEntity = z.infer<typeof ComputeNodeEntitySchema>;
export type ComputeVmEntity = z.infer<typeof ComputeVmEntitySchema>;
export type NetworkInterfaceEntity = z.infer<typeof NetworkInterfaceEntitySchema>;
export type NetworkSubnetEntity = z.infer<typeof NetworkSubnetEntitySchema>;

