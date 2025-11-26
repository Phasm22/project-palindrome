import type { Parser, ParserContext, ParserResult } from "../types";
import {
  TwinEntityType,
  type TwinEntity,
} from "../../twin/models/entities";
import type { TwinRelationship } from "../../twin/models/relationships";
import { collectIpAddresses, normalizeNodeId } from "./helpers";

interface ProxmoxNodeRecord {
  node?: string;
  status?: string;
  status_normalized?: string;
  uptime?: number;
  ip?: string;
  level?: string;
  maxcpu?: number;
  maxmem?: number;
  mem?: number;
  cpu?: number;
  type?: string;
  ssl_fingerprint?: string;
}

interface ListNodesResponse {
  nodes?: ProxmoxNodeRecord[];
}

export class ProxmoxNodeParser implements Parser<ListNodesResponse> {
  name = "proxmox_node_parser";
  domain = "compute";

  async parse(input: ListNodesResponse, context: ParserContext): Promise<ParserResult> {
    const nodes = input?.nodes ?? [];
    const entities: TwinEntity[] = nodes
      .filter((node): node is ProxmoxNodeRecord & { node: string } => Boolean(node?.node))
      .map((node) => this.toEntity(node, context));

    return {
      entities,
      relationships: [] as TwinRelationship[],
      metadata: {
        source: context.source,
        processed: nodes.length,
      },
    };
  }

  private toEntity(node: ProxmoxNodeRecord & { node: string }, context: ParserContext): TwinEntity {
    const status = node.status_normalized || node.status || "unknown";
    const id = normalizeNodeId(node.node);

    return {
      id,
      type: TwinEntityType.COMPUTE_NODE,
      displayName: node.node,
      source: context.source,
      collectedAt: context.collectedAt,
      data: {
        roles: node.type ? [node.type] : [],
        ipAddresses: collectIpAddresses(node.ip),
        status: status as "online" | "degraded" | "offline" | "unknown",
        cpuTotalCores: node.maxcpu,
        memoryTotalBytes: node.maxmem,
      },
    };
  }
}

