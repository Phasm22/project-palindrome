import type { Parser, ParserContext, ParserResult } from "../types";
import {
  TwinEntityType,
  type TwinEntity,
} from "../../twin/models/entities";
import {
  TwinRelationshipType,
  type TwinRelationship,
} from "../../twin/models/relationships";
import {
  collectIpAddresses,
  normalizeNodeId,
  normalizeVmId,
} from "./helpers";

interface ProxmoxVmRecord {
  vmid: number;
  name?: string;
  node?: string;
  status?: string;
  status_normalized?: string;
  type?: string;
  maxmem?: number;
  mem?: number;
  maxcpu?: number;
  cpus?: number;
  cpu?: number;
  agent?: string | number | boolean;
  ip?: string;
  ip_addresses?: string[];
}

interface ListVmsResponse {
  vms?: ProxmoxVmRecord[];
}

export class ProxmoxVmParser implements Parser<ListVmsResponse> {
  name = "proxmox_vm_parser";
  domain = "compute";

  async parse(input: ListVmsResponse, context: ParserContext): Promise<ParserResult> {
    const vms = input?.vms ?? [];
    const entities: TwinEntity[] = [];
    const relationships: TwinRelationship[] = [];

    for (const vm of vms) {
      if (!vm.node || vm.vmid === undefined || vm.vmid === null) {
        continue;
      }
      const entity = this.toEntity(vm, context);
      entities.push(entity);
      relationships.push({
        type: TwinRelationshipType.RUNS_ON,
        fromId: entity.id,
        toId: normalizeNodeId(vm.node),
        metadata: {
          vmType: vm.type || "qemu",
        },
        collectedAt: context.collectedAt,
      });
    }

    return {
      entities,
      relationships,
      metadata: {
        source: context.source,
        processed: vms.length,
      },
    };
  }

  private toEntity(vm: ProxmoxVmRecord, context: ParserContext): TwinEntity {
    const nodeId = normalizeNodeId(vm.node!);
    const vmId = normalizeVmId(vm.node!, vm.vmid);

    return {
      id: vmId,
      type: TwinEntityType.COMPUTE_VM,
      displayName: vm.name || `vm-${vm.vmid}`,
      source: context.source,
      collectedAt: context.collectedAt,
      data: {
        nodeId,
        state: (vm.status_normalized || vm.status || "unknown") as
          | "running"
          | "stopped"
          | "paused"
          | "unknown",
        ipAddresses: collectIpAddresses(vm.ip, ...(vm.ip_addresses ?? [])),
        agentAvailable: this.normalizeAgent(vm.agent),
        cpuCores: vm.maxcpu ?? vm.cpus,
        memoryBytes: vm.maxmem,
      },
    };
  }

  private normalizeAgent(agent: ProxmoxVmRecord["agent"]): boolean | undefined {
    if (agent === undefined || agent === null) {
      return undefined;
    }
    if (typeof agent === "boolean") {
      return agent;
    }
    if (typeof agent === "number") {
      return agent > 0;
    }
    const normalized = agent.toString().toLowerCase();
    return normalized === "1" || normalized === "enabled" || normalized === "true";
  }
}

