import type { Parser, ParserContext, ParserResult } from "../types";
import type { TwinEntity } from "../../twin/models/entities";
import { TwinEntityType } from "../../twin/models/entities";
import type { TwinRelationship } from "../../twin/models/relationships";
import { TwinRelationshipType } from "../../twin/models/relationships";
import {
  cidrMask,
  coerceVlan,
  derivePrimaryIp,
  normalizeInterfaceId,
  normalizeSubnetId,
  parseCidrs,
  safeStatus,
} from "./network-utils";

interface OpnsenseInterfaceRecord {
  name: string;
  if: string;
  mac?: string;
  ipaddr?: string;
  ipaddrv6?: string;
  subnet?: number;
  subnetv6?: number;
  gateway?: string;
  enable?: string | number;
  descr?: string;
}

interface OpnsenseVlanRecord {
  if: string;
  tag: string;
  descr?: string;
}

export interface OpnsenseInterfaceParserInput {
  hostname: string;
  interfaces: OpnsenseInterfaceRecord[];
  vlans?: OpnsenseVlanRecord[];
}

export class OpnsenseInterfaceParser implements Parser<OpnsenseInterfaceParserInput> {
  name = "opnsense_interface_parser";
  domain = "network";

  async parse(input: OpnsenseInterfaceParserInput, context: ParserContext): Promise<ParserResult> {
    const entities: TwinEntity[] = [];
    const relationships: TwinRelationship[] = [];
    const subnetMap = new Map<string, TwinEntity>();
    const vlanMap = new Map<string, string>();

    for (const vlan of input.vlans || []) {
      vlanMap.set(vlan.if, vlan.tag);
    }

    for (const iface of input.interfaces || []) {
      if (!iface?.if) {
        continue;
      }
      const cidrs = this.collectCidrs(iface);
      const entity = this.buildInterfaceEntity(
        input.hostname,
        iface.if,
        {
          mac: iface.mac,
          cidrs,
          vlan: coerceVlan(vlanMap.get(iface.if)),
          status: safeStatus(iface.enable),
          description: iface.descr,
        },
        context.collectedAt
      );
      entities.push(entity);

      this.attachSubnetsWithGateway(entity, cidrs, iface.gateway, subnetMap, context.collectedAt, relationships);
    }

    return { entities: [...entities, ...subnetMap.values()], relationships };
  }

  private collectCidrs(iface: OpnsenseInterfaceRecord): string[] {
    const cidrs: string[] = [];
    if (iface.ipaddr && iface.subnet !== undefined) {
      cidrs.push(`${iface.ipaddr}/${iface.subnet}`);
    }
    if (iface.ipaddrv6 && iface.subnetv6 !== undefined) {
      cidrs.push(`${iface.ipaddrv6}/${iface.subnetv6}`);
    }
    return parseCidrs(cidrs);
  }

  private buildInterfaceEntity(
    nodeName: string,
    ifaceName: string,
    options: {
      mac?: string;
      cidrs?: string[];
      vlan?: string | null;
      status?: "up" | "down" | "unknown";
      description?: string;
    },
    collectedAt: Date
  ): TwinEntity {
    const cidrs = options.cidrs ?? [];
    return {
      id: normalizeInterfaceId(nodeName, ifaceName),
      type: TwinEntityType.NETWORK_INTERFACE,
      displayName: `${nodeName}:${ifaceName}`,
      source: "opnsense",
      collectedAt,
      data: {
        nodeName,
        vmId: null,
        name: ifaceName,
        mac: options.mac ?? null,
        ips: cidrs,
        primaryIp: derivePrimaryIp(cidrs),
        cidrs,
        status: options.status ?? "unknown",
        vlan: options.vlan ?? null,
        parent: null,
      },
    };
  }

  private attachSubnetsWithGateway(
    ifaceEntity: TwinEntity,
    cidrs: string[],
    gateway: string | undefined,
    subnetMap: Map<string, TwinEntity>,
    collectedAt: Date,
    relationships: TwinRelationship[]
  ) {
    for (const cidr of cidrs) {
      const subnetId = normalizeSubnetId(cidr);
      if (!subnetMap.has(subnetId)) {
        subnetMap.set(subnetId, {
          id: subnetId,
          type: TwinEntityType.NETWORK_SUBNET,
          displayName: cidr,
          source: ifaceEntity.source,
          collectedAt,
          data: {
            cidr,
            mask: cidrMask(cidr),
            gateway: gateway ?? null,
            interfaceCount: 1,
          },
        });
      } else {
        const current = subnetMap.get(subnetId)!;
        const data = current.data as any;
        data.interfaceCount = (data.interfaceCount ?? 0) + 1;
        if (!data.gateway && gateway) {
          data.gateway = gateway;
        }
      }

      relationships.push({
        type: TwinRelationshipType.CONNECTS_TO,
        fromId: ifaceEntity.id,
        toId: subnetId,
        metadata: { cidr },
        collectedAt,
      });
    }
  }
}

