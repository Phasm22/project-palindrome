import type { Parser, ParserContext, ParserResult } from "../types";
import type { TwinEntity } from "../../twin/models/entities";
import { TwinEntityType } from "../../twin/models/entities";
import type { TwinRelationship } from "../../twin/models/relationships";
import { TwinRelationshipType } from "../../twin/models/relationships";
import { normalizeSubnetId } from "./network-utils";

/**
 * Input format: raw `show running-config` text captured from a Cisco IOS
 * switch (e.g. via the CLI, or an HTTP CLI-exec export like this repo's
 * docs/network/2960g-running-config-*.txt seed).
 */
export interface CiscoIosSwitchParserInput {
  configText: string;
}

interface ParsedPort {
  name: string; // normalized short form, e.g. "Gi0/41"
  description: string | null;
  mode: "access" | "trunk" | null;
  accessVlan: number | null;
  trunkVlans: number[];
}

interface ParsedSvi {
  name: string; // e.g. "Vlan40"
  description: string | null;
  ip: string | null;
  prefixLength: number | null;
  shutdown: boolean;
}

const PORT_NAME_ABBREVIATIONS: Array<[RegExp, string]> = [
  [/^GigabitEthernet/i, "Gi"],
  [/^TenGigabitEthernet/i, "Te"],
  [/^FastEthernet/i, "Fa"],
  [/^Ethernet/i, "Eth"],
];

function normalizePortName(rawName: string): string {
  for (const [pattern, abbreviation] of PORT_NAME_ABBREVIATIONS) {
    if (pattern.test(rawName)) {
      return rawName.replace(pattern, abbreviation);
    }
  }
  return rawName;
}

function portSlug(portName: string): string {
  return portName.toLowerCase().replace(/\//g, "-");
}

/** Dotted-decimal netmask (e.g. "255.255.252.0") -> CIDR prefix length. */
function netmaskToPrefixLength(netmask: string): number | null {
  const octets = netmask.trim().split(".");
  if (octets.length !== 4) return null;

  let bits = 0;
  let seenZero = false;
  for (const octet of octets) {
    const value = Number.parseInt(octet, 10);
    if (Number.isNaN(value) || value < 0 || value > 255) return null;
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

/**
 * Parses a Cisco IOS `show running-config` export into structured
 * ports/VLANs/SVIs/static-routes, then into Twin SWITCH/SWITCH_PORT
 * entities. Only extracts what is literally present in the config text —
 * it does not infer or fabricate a device model, physical link partners,
 * or routing decisions (those require MAC-table/CDP data or a full policy
 * evaluator, neither of which exist yet).
 */
export class CiscoIosSwitchParser implements Parser<CiscoIosSwitchParserInput> {
  name = "cisco_ios_switch_parser";
  domain = "network";

  async parse(input: CiscoIosSwitchParserInput, context: ParserContext): Promise<ParserResult> {
    const lines = (input.configText || "").split(/\r?\n/);

    let hostname: string | null = null;
    const ports: ParsedPort[] = [];
    const svis: ParsedSvi[] = [];
    const staticRoutes: string[] = [];
    let defaultGateway: string | null = null;

    let current: { kind: "port" | "svi"; port?: ParsedPort; svi?: ParsedSvi } | null = null;

    const closeCurrent = () => {
      if (current?.kind === "port" && current.port) ports.push(current.port);
      if (current?.kind === "svi" && current.svi) svis.push(current.svi);
      current = null;
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();

      const hostnameMatch = line.match(/^hostname\s+(\S+)/i);
      if (hostnameMatch) hostname = hostnameMatch[1]!;

      const physicalIfaceMatch = line.match(/^interface\s+((?:GigabitEthernet|TenGigabitEthernet|FastEthernet|Ethernet)\S*)/i);
      if (physicalIfaceMatch) {
        closeCurrent();
        current = {
          kind: "port",
          port: { name: normalizePortName(physicalIfaceMatch[1]!), description: null, mode: null, accessVlan: null, trunkVlans: [] },
        };
        continue;
      }

      const sviMatch = line.match(/^interface\s+(Vlan\d+)/i);
      if (sviMatch) {
        closeCurrent();
        current = {
          kind: "svi",
          svi: { name: sviMatch[1]!, description: null, ip: null, prefixLength: null, shutdown: false },
        };
        continue;
      }

      if (line === "!" || /^interface\s/i.test(line)) {
        // A non-port/SVI interface (e.g. a management/loopback iface) or a
        // block separator — close whatever we were accumulating.
        if (line === "!") closeCurrent();
        continue;
      }

      if (!current) {
        // Top-level (not inside an interface block) directives.
        const routeMatch = line.match(/^ip route\s+(\S+\s+\S+\s+\S+)/i);
        if (routeMatch) staticRoutes.push(routeMatch[1]!.trim());

        const gatewayMatch = line.match(/^ip default-gateway\s+(\S+)/i);
        if (gatewayMatch) defaultGateway = gatewayMatch[1]!;
        continue;
      }

      const descriptionMatch = line.match(/^description\s+(.+)/i);
      if (descriptionMatch) {
        if (current.kind === "port") current.port!.description = descriptionMatch[1]!.trim();
        else current.svi!.description = descriptionMatch[1]!.trim();
        continue;
      }

      if (current.kind === "port") {
        const modeMatch = line.match(/^switchport mode (access|trunk)/i);
        if (modeMatch) current.port!.mode = modeMatch[1]!.toLowerCase() as "access" | "trunk";

        const accessVlanMatch = line.match(/^switchport access vlan (\d+)/i);
        if (accessVlanMatch) current.port!.accessVlan = Number.parseInt(accessVlanMatch[1]!, 10);

        const trunkVlanMatch = line.match(/^switchport trunk allowed vlan ([\d,]+)/i);
        if (trunkVlanMatch) {
          current.port!.trunkVlans = trunkVlanMatch[1]!.split(",").map((v) => Number.parseInt(v, 10)).filter((v) => !Number.isNaN(v));
        }
      } else {
        const ipMatch = line.match(/^ip address\s+(\S+)\s+(\S+)/i);
        if (ipMatch) {
          current.svi!.ip = ipMatch[1]!;
          current.svi!.prefixLength = netmaskToPrefixLength(ipMatch[2]!);
        }
        if (/^no ip address/i.test(line)) {
          current.svi!.ip = null;
          current.svi!.prefixLength = null;
        }
        if (/^shutdown/i.test(line)) current.svi!.shutdown = true;
      }
    }
    closeCurrent();

    if (!hostname) {
      throw new Error("cisco_ios_switch_parser: could not find a hostname in the provided config text");
    }

    const switchSlug = hostname.toLowerCase();
    const switchId = `switch:${switchSlug}:observed`;
    const managementIps = svis
      .filter((svi) => svi.ip && !svi.shutdown)
      .map((svi) => svi.ip!)
      .filter((ip, index, all) => all.indexOf(ip) === index);

    const entities: TwinEntity[] = [];
    const relationships: TwinRelationship[] = [];

    entities.push({
      id: switchId,
      type: TwinEntityType.SWITCH,
      displayName: hostname,
      collectedAt: context.collectedAt,
      source: context.source,
      data: {
        hostname,
        model: null, // not present in `show running-config` text
        managementIps,
        role: null,
        provenance: "observed",
        // Static routes and the legacy default-gateway are captured as plain
        // context here rather than modeled as first-class route entities —
        // full routing-table modeling is deferred (see project plan Phase 2/3).
        ...(staticRoutes.length ? { staticRoutes } : {}),
        ...(defaultGateway ? { defaultGateway } : {}),
      } as any,
    });

    for (const port of ports) {
      const portId = `switch-port:${switchSlug}:${portSlug(port.name)}:observed`;
      entities.push({
        id: portId,
        type: TwinEntityType.SWITCH_PORT,
        displayName: `${hostname}:${port.name}`,
        collectedAt: context.collectedAt,
        source: context.source,
        data: {
          switchId,
          portName: port.name,
          mode: port.mode,
          accessVlan: port.accessVlan,
          trunkVlans: port.trunkVlans,
          description: port.description,
          provenance: "observed",
        },
      });
      relationships.push({
        type: TwinRelationshipType.HAS_PORT,
        fromId: switchId,
        toId: portId,
        collectedAt: context.collectedAt,
        metadata: { portName: port.name },
      });
    }

    // Routed SVIs -> the subnet they serve, so blast-radius/reachability
    // queries can find which device actually routes a given subnet. Only
    // linked when a matching NetworkSubnet entity already exists elsewhere
    // in the Twin graph; writeRelationships() skips edges to missing nodes.
    for (const svi of svis) {
      if (!svi.ip || svi.prefixLength === null || svi.shutdown) continue;
      const cidr = `${svi.ip}/${svi.prefixLength}`;
      relationships.push({
        type: TwinRelationshipType.ROUTES_FOR,
        fromId: switchId,
        toId: normalizeSubnetId(cidr),
        collectedAt: context.collectedAt,
        metadata: { svi: svi.name, cidr, description: svi.description ?? undefined },
      });
    }

    return {
      entities,
      relationships,
      metadata: { source: context.source, portsParsed: ports.length, svisParsed: svis.length },
    };
  }
}
