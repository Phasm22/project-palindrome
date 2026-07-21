/**
 * Switch/VLAN Ingestion
 *
 * Writes SWITCH/SWITCH_PORT entities into the Twin graph (:TwinEntity) from
 * two independent sources, intentionally kept side by side rather than
 * merged:
 *
 *  - Declared: docs/topology.yaml's hand-maintained `switch:` block.
 *  - Observed: a real `show running-config` capture, parsed by
 *    CiscoIosSwitchParser.
 *
 * These are NOT reconciled here. Where they disagree (e.g. which VLAN
 * actually carries the lab subnet on this switch), both records are kept —
 * queryable side by side by id suffix (`:declared` vs `:observed`) — rather
 * than one silently overwriting the other. See docs/network/ for the
 * specific disagreement found for the 2960G.
 *
 * This is deliberately a separate file from topology-ingestion.ts: that
 * orchestrator's extractTopologyEntities() is built entirely around the
 * legacy ontology graph's node/relationship vocabulary (NodeType/
 * RelationshipType, :Entity), while switch/VLAN facts need to land in the
 * Twin graph (:TwinEntity) so twin_query's blast-radius/reachability
 * operations can actually read them.
 */

import { promises as fs } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { TwinUpdateService } from "../../twin";
import { TwinEntityType, type TwinEntity } from "../../twin/models/entities";
import { TwinRelationshipType, type TwinRelationship } from "../../twin/models/relationships";
import { CiscoIosSwitchParser } from "../../parsers/network/cisco-ios-switch-parser";
import { pceLogger } from "../utils/logger";

interface DeclaredSwitchBlock {
  model?: string;
  trunk_ports?: string[];
  vlans?: number[];
  ip?: string[];
}

export interface SwitchIngestionOptions {
  topologyPath?: string;
  ciscoConfigPaths?: string[];
}

export interface SwitchIngestionResult {
  entitiesWritten: number;
  relationshipsWritten: number;
}

// topology.yaml's `switch:` block has no name/hostname field of its own —
// it describes the lab's one Cisco switch, whose real hostname ("TJswitch")
// is only known from the observed config. Hardcoded here so the declared
// and observed records for this device share an id slug and are findable
// together; if a second Cisco switch is ever added, this block needs a
// real name field in topology.yaml instead.
const DECLARED_CISCO_SWITCH_SLUG = "tjswitch";

export class SwitchIngestionOrchestrator {
  private twinUpdater = new TwinUpdateService();
  private ciscoParser = new CiscoIosSwitchParser();

  async ingestSwitches(options: SwitchIngestionOptions = {}): Promise<SwitchIngestionResult> {
    const topologyPath = options.topologyPath || join(process.cwd(), "docs", "topology.yaml");
    const ciscoConfigPaths = options.ciscoConfigPaths || [
      join(process.cwd(), "docs", "network", "2960g-running-config-2026-07-20.txt"),
    ];
    const collectedAt = new Date();

    const entities: TwinEntity[] = [];
    const relationships: TwinRelationship[] = [];

    await this.collectDeclared(topologyPath, collectedAt, entities, relationships);
    for (const configPath of ciscoConfigPaths) {
      await this.collectObserved(configPath, collectedAt, entities, relationships);
    }

    if (entities.length > 0) {
      await this.twinUpdater.upsert(entities, relationships);
    }

    return { entitiesWritten: entities.length, relationshipsWritten: relationships.length };
  }

  private async collectDeclared(
    topologyPath: string,
    collectedAt: Date,
    entities: TwinEntity[],
    relationships: TwinRelationship[]
  ): Promise<void> {
    try {
      const content = await fs.readFile(topologyPath, "utf8");
      const topology = parseYaml(content) as { switch?: DeclaredSwitchBlock };
      if (!topology.switch) return;

      const switchId = `switch:${DECLARED_CISCO_SWITCH_SLUG}:declared`;
      entities.push({
        id: switchId,
        type: TwinEntityType.SWITCH,
        displayName: `${topology.switch.model || "Switch"} (declared)`,
        collectedAt,
        source: "topology.yaml",
        data: {
          hostname: DECLARED_CISCO_SWITCH_SLUG,
          model: topology.switch.model ?? null,
          managementIps: topology.switch.ip ?? [],
          role: null,
          provenance: "declared",
          declaredTrunkPorts: topology.switch.trunk_ports ?? [],
          declaredVlans: topology.switch.vlans ?? [],
        },
      });

      for (const portName of topology.switch.trunk_ports ?? []) {
        const portId = `switch-port:${DECLARED_CISCO_SWITCH_SLUG}:${portName.toLowerCase().replace(/\//g, "-")}:declared`;
        entities.push({
          id: portId,
          type: TwinEntityType.SWITCH_PORT,
          displayName: `${DECLARED_CISCO_SWITCH_SLUG}:${portName} (declared)`,
          collectedAt,
          source: "topology.yaml",
          data: {
            switchId,
            portName,
            mode: "trunk",
            accessVlan: null,
            trunkVlans: topology.switch.vlans ?? [],
            description: null,
            provenance: "declared",
          },
        });
        relationships.push({
          type: TwinRelationshipType.HAS_PORT,
          fromId: switchId,
          toId: portId,
          collectedAt,
          metadata: { portName },
        });
      }
    } catch (error: any) {
      pceLogger.warn("Switch ingestion: could not read declared topology.yaml switch block", { error: error.message });
    }
  }

  private async collectObserved(
    configPath: string,
    collectedAt: Date,
    entities: TwinEntity[],
    relationships: TwinRelationship[]
  ): Promise<void> {
    try {
      const configText = await fs.readFile(configPath, "utf8");
      const result = await this.ciscoParser.parse(
        { configText },
        { source: `cisco-ios:${configPath}`, collectedAt }
      );
      entities.push(...result.entities);
      relationships.push(...(result.relationships as TwinRelationship[]));
    } catch (error: any) {
      pceLogger.warn("Switch ingestion: could not read/parse observed switch config", {
        configPath,
        error: error.message,
      });
    }
  }

  async dispose(): Promise<void> {
    await this.twinUpdater.close();
  }
}
