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

interface ProxmoxNodeInterface {
  name?: string;
  iface?: string;
  type?: string;
  method?: string;
  cidr?: string;
  address?: string;
  netmask?: string | number;
  bridge_ports?: string;
  vlan_raw_device?: string;
  tag?: string | number;
  active?: number;
  autostart?: number;
  mac?: string;
}

interface ProxmoxGuestInterface {
  name: string;
  "hardware-address"?: string;
  "ip-addresses"?: Array<{
    "ip-address": string;
    "ip-address-type": string;
    prefix: number;
  }>;
}

interface ProxmoxVmNetConfig {
  vmid: number;
  node: string;
  name?: string;
  net?: Record<string, string>;
  guestInterfaces?: ProxmoxGuestInterface[];
}

export interface ProxmoxInterfaceParserInput {
  nodes: Array<{
    node: string;
    interfaces: ProxmoxNodeInterface[];
  }>;
  vms: ProxmoxVmNetConfig[];
}

export class ProxmoxInterfaceParser implements Parser<ProxmoxInterfaceParserInput> {
  name = "proxmox_interface_parser";
  domain = "network";

  async parse(input: ProxmoxInterfaceParserInput, context: ParserContext): Promise<ParserResult> {
    const entities: TwinEntity[] = [];
    const relationships: TwinRelationship[] = [];
    const subnetMap = new Map<string, TwinEntity>();

    for (const nodeEntry of input.nodes || []) {
      for (const iface of nodeEntry.interfaces || []) {
        const ifaceName = iface?.name || iface?.iface;
        if (!ifaceName) {
          continue;
        }
        const inferredCidr = this.inferCidr(iface.address, iface.netmask);
        const cidrs = parseCidrs([iface.cidr, inferredCidr, iface.address]);
        const entity = this.buildInterfaceEntity(
          nodeEntry.node,
          ifaceName,
          {
            mac: iface.mac || undefined,
            cidrs,
            vlan: coerceVlan(iface.tag ?? iface.vlan_raw_device),
            parent: iface.bridge_ports || null,
            status: safeStatus(iface.active),
          },
          context.collectedAt
        );
        entities.push(entity);
        this.attachSubnets(entity, cidrs, subnetMap, context.collectedAt, relationships);
        this.addAttachmentRelationship(
          relationships,
          entity.id,
          this.normalizeNodeEntityId(nodeEntry.node),
          context.collectedAt,
          { attachmentKind: "node_interface" }
        );
      }
    }

    for (const vm of input.vms || []) {
      const vmNets = vm.net || {};
      const guestInterfaces = vm.guestInterfaces || [];
      const vmId = `compute-vm:${vm.node.toLowerCase()}:${vm.vmid}`;
      
      // Build map of MAC -> guest IPs from guest agent data
      const macToIps = new Map<string, string[]>();
      for (const guestIf of guestInterfaces) {
        const mac = guestIf["hardware-address"]?.toLowerCase();
        if (!mac) continue;
        const ips = (guestIf["ip-addresses"] || [])
          .filter((addr) => addr["ip-address-type"] === "ipv4" || addr["ip-address-type"] === "ipv6")
          .map((addr) => `${addr["ip-address"]}/${addr.prefix}`);
        if (ips.length > 0) {
          macToIps.set(mac, ips);
        }
      }
      
      Object.entries(vmNets).forEach(([netKey, value]) => {
        if (!value) {
          return;
        }
        const parsed = this.parseVmNetString(value);
        
        // Try to get IPs from guest agent data using MAC address
        let cidrs: string[] = [];
        if (parsed.mac) {
          const guestIps = macToIps.get(parsed.mac.toLowerCase());
          if (guestIps && guestIps.length > 0) {
            cidrs = parseCidrs(guestIps);
          }
        }
        
        // Fallback to config IP if present (rare)
        if (cidrs.length === 0 && parsed.ip) {
          cidrs = parseCidrs([parsed.ip]);
        }
        
        const entity = this.buildInterfaceEntity(
          vm.node,
          `${vm.name || vm.vmid}-${netKey}`,
          {
            mac: parsed.mac ?? undefined,
            cidrs,
            vlan: coerceVlan(parsed.tag),
            parent: parsed.bridge ?? null,
            status: "unknown",
            vmId,
          },
          context.collectedAt
        );
        entities.push(entity);
        this.attachSubnets(entity, cidrs, subnetMap, context.collectedAt, relationships);
        this.addAttachmentRelationship(
          relationships,
          entity.id,
          vmId,
          context.collectedAt,
          { attachmentKind: "vm_interface", netKey }
        );
      });
    }

    return { entities: [...entities, ...subnetMap.values()], relationships };
  }

  private buildInterfaceEntity(
    nodeName: string,
    ifaceName: string,
    options: {
      mac?: string;
      cidrs?: string[];
      vlan?: string | null;
      parent?: string | null;
      status?: "up" | "down" | "unknown";
      vmId?: string;
    },
    collectedAt: Date
  ): TwinEntity {
    const cidrs = options.cidrs ?? [];
    return {
      id: normalizeInterfaceId(nodeName, ifaceName),
      type: TwinEntityType.NETWORK_INTERFACE,
      displayName: `${nodeName}:${ifaceName}`,
      collectedAt,
      source: "proxmox",
      data: {
        nodeName,
        vmId: options.vmId ?? null,
        name: ifaceName,
        mac: options.mac ?? null,
        ips: cidrs,
        primaryIp: derivePrimaryIp(cidrs),
        cidrs,
        status: options.status ?? "unknown",
        vlan: options.vlan ?? null,
        parent: options.parent ?? null,
      },
    };
  }

  private attachSubnets(
    ifaceEntity: TwinEntity,
    cidrs: string[],
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
          collectedAt,
          source: ifaceEntity.source,
          data: {
            cidr,
            mask: cidrMask(cidr),
            gateway: null,
            interfaceCount: 1,
          },
        });
      } else {
        const existing = subnetMap.get(subnetId)!;
        const current = existing.data as any;
        current.interfaceCount = (current.interfaceCount ?? 0) + 1;
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

  private addAttachmentRelationship(
    relationships: TwinRelationship[],
    fromId: string,
    toId: string,
    collectedAt: Date,
    metadata: Record<string, any> = {}
  ): void {
    relationships.push({
      type: TwinRelationshipType.ATTACHED_TO,
      fromId,
      toId,
      metadata,
      collectedAt,
    });
  }

  private normalizeNodeEntityId(nodeName: string): string {
    return `compute-node:${nodeName.toLowerCase()}`;
  }

  private parseVmNetString(netValue: string): {
    mac?: string;
    bridge?: string;
    tag?: string;
    ip?: string;
  } {
    const parts = netValue.split(",").map((p) => p.trim());
    const result: { [key: string]: string } = {};
    for (const part of parts) {
      const [key, value] = part.split("=").map((v) => v.trim());
      if (key && value) {
        result[key] = value;
      }
    }
    return {
      mac: result.virtio || result.hwaddr,
      bridge: result.bridge,
      tag: result.tag,
      ip: result.ip,
    };
  }

  private inferCidr(address?: string, netmask?: string | number): string | null {
    if (!address || typeof address !== "string") {
      return null;
    }
    if (address.includes("/")) {
      return address;
    }

    const prefix = this.netmaskToPrefix(netmask);
    if (prefix === null) {
      return null;
    }
    return `${address}/${prefix}`;
  }

  private netmaskToPrefix(netmask?: string | number): number | null {
    if (netmask === undefined || netmask === null) return null;
    if (typeof netmask === "number") {
      return netmask >= 0 && netmask <= 128 ? netmask : null;
    }

    const trimmed = netmask.trim();
    if (!trimmed.length) return null;
    if (/^\d+$/.test(trimmed)) {
      const numeric = Number.parseInt(trimmed, 10);
      return numeric >= 0 && numeric <= 128 ? numeric : null;
    }

    // Dotted-decimal IPv4 netmask (e.g. 255.255.252.0 -> 22)
    if (!trimmed.includes(".")) return null;
    const octets = trimmed.split(".");
    if (octets.length !== 4) return null;

    let bits = 0;
    let seenZero = false;
    for (const octet of octets) {
      const value = Number.parseInt(octet, 10);
      if (Number.isNaN(value) || value < 0 || value > 255) {
        return null;
      }
      const binary = value.toString(2).padStart(8, "0");
      for (const bit of binary) {
        if (bit === "1") {
          if (seenZero) return null;
          bits += 1;
        } else {
          seenZero = true;
        }
      }
    }

    return bits;
  }
}
