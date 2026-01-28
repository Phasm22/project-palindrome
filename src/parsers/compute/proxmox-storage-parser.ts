import type { Parser, ParserContext, ParserResult } from "../types";
import {
  TwinEntityType,
  type TwinEntity,
} from "../../twin/models/entities";
import type { TwinRelationship } from "../../twin/models/relationships";

interface ProxmoxStorageRecord {
  storage?: string;
  type?: string;
  content?: string[];
  shared?: boolean;
  active?: boolean;
  enabled?: boolean;
  used?: number;
  avail?: number;
  total?: number;
  used_fraction?: number;
}

interface ListStorageResponse {
  node: string;
  storage?: ProxmoxStorageRecord[];
}

export class ProxmoxStorageParser implements Parser<ListStorageResponse> {
  name = "proxmox_storage_parser";
  domain = "compute";

  async parse(input: ListStorageResponse, context: ParserContext): Promise<ParserResult> {
    const storageList = input?.storage ?? [];
    const nodeName = input.node;
    
    if (!nodeName) {
      return {
        entities: [],
        relationships: [],
        metadata: {
          source: context.source,
          processed: 0,
        },
      };
    }

    const entities: TwinEntity[] = storageList
      .filter((storage): storage is ProxmoxStorageRecord & { storage: string } => Boolean(storage?.storage))
      .map((storage) => this.toEntity(storage, nodeName, context));

    const relationships: TwinRelationship[] = entities.map((entity) => ({
      from: entity.id,
      to: `compute-node:${nodeName}`,
      type: "ATTACHED_TO",
    }));

    return {
      entities,
      relationships,
      metadata: {
        source: context.source,
        processed: storageList.length,
      },
    };
  }

  private toEntity(
    storage: ProxmoxStorageRecord & { storage: string },
    nodeName: string,
    context: ParserContext
  ): TwinEntity {
    const id = `storage:${nodeName}:${storage.storage}`;
    const displayName = `${storage.storage} (${nodeName})`;

    return {
      id,
      type: TwinEntityType.STORAGE,
      displayName,
      source: context.source,
      collectedAt: context.collectedAt,
      data: {
        nodeName,
        storageName: storage.storage,
        storageType: storage.type || "unknown",
        content: storage.content || [],
        shared: storage.shared ?? false,
        active: storage.active ?? true,
        enabled: storage.enabled ?? true,
        usedBytes: storage.used,
        availBytes: storage.avail,
        totalBytes: storage.total,
        usedFraction: storage.used_fraction,
      },
    };
  }
}
