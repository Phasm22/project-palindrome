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
import { SSHTool } from "../../tools/SSHTool";
import { pceLogger } from "../utils/logger";

interface DeclaredSwitchBlock {
  model?: string;
  trunk_ports?: string[];
  vlans?: number[];
  ip?: string[];
}

interface CiscoSwitchSource {
  /** approved-commands.yaml host alias to try a live `show running-config` fetch against first. */
  liveHostAlias?: string;
  /** Falls back to this committed snapshot if the live fetch fails or isn't configured. */
  staticSeedPath: string;
}

export interface SwitchIngestionOptions {
  topologyPath?: string;
  ciscoSources?: CiscoSwitchSource[];
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
  private sshTool = new SSHTool();

  async ingestSwitches(options: SwitchIngestionOptions = {}): Promise<SwitchIngestionResult> {
    const topologyPath = options.topologyPath || join(process.cwd(), "docs", "topology.yaml");
    const ciscoSources = options.ciscoSources || [
      {
        liveHostAlias: "tjswitch",
        staticSeedPath: join(process.cwd(), "docs", "network", "2960g-running-config-2026-07-20.txt"),
      },
    ];
    const collectedAt = new Date();

    const entities: TwinEntity[] = [];
    const relationships: TwinRelationship[] = [];

    await this.collectDeclared(topologyPath, collectedAt, entities, relationships);
    for (const source of ciscoSources) {
      await this.collectObserved(source, collectedAt, entities, relationships);
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
    source: CiscoSwitchSource,
    collectedAt: Date,
    entities: TwinEntity[],
    relationships: TwinRelationship[]
  ): Promise<void> {
    // A live fetch can return a non-empty string that still isn't usable
    // config (e.g. an IOS error message for a rejected command) — so
    // "fetched something" isn't enough to skip the static fallback. Only a
    // config that actually PARSES counts as a successful live fetch.
    if (source.liveHostAlias) {
      const live = await this.fetchLiveConfig(source.liveHostAlias);
      if (live && await this.tryParseInto(live, `cisco-ios:live:${source.liveHostAlias}`, collectedAt, entities, relationships)) {
        return;
      }
      pceLogger.warn("Switch ingestion: live config unusable, falling back to static seed", {
        hostAlias: source.liveHostAlias,
      });
    }

    let configText: string;
    try {
      configText = await fs.readFile(source.staticSeedPath, "utf8");
    } catch (error: any) {
      pceLogger.warn("Switch ingestion: could not read static switch config seed", {
        staticSeedPath: source.staticSeedPath,
        error: error.message,
      });
      return;
    }
    await this.tryParseInto(configText, `cisco-ios:${source.staticSeedPath}`, collectedAt, entities, relationships);
  }

  private async tryParseInto(
    configText: string,
    sourceLabel: string,
    collectedAt: Date,
    entities: TwinEntity[],
    relationships: TwinRelationship[]
  ): Promise<boolean> {
    try {
      const result = await this.ciscoParser.parse({ configText }, { source: sourceLabel, collectedAt });
      entities.push(...result.entities);
      relationships.push(...(result.relationships as TwinRelationship[]));
      return true;
    } catch (error: any) {
      pceLogger.warn("Switch ingestion: could not parse observed switch config", {
        source: sourceLabel,
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Attempts a live `show running-config` fetch via the approved-commands.yaml
   * host alias. Returns null (never throws) on any failure — missing
   * credentials, unreachable host, or (currently, for the 2960G specifically)
   * this IOS image rejecting multi-word commands over non-interactive SSH
   * exec with "invalid autocommand". Falling back to the static seed keeps
   * ingestion working either way; fixing the underlying exec-vs-interactive-
   * shell gap for this device is a follow-up, not blocking.
   */
  private async fetchLiveConfig(hostAlias: string): Promise<string | null> {
    try {
      const result: any = await this.sshTool.execute(
        { host: hostAlias, command: "show running-config" },
        { userId: "switch-ingestion", aclGroup: "admin" } as any
      );
      if (result.error || typeof result.data?.stdout !== "string") {
        pceLogger.warn("Switch ingestion: live config fetch failed, falling back to static seed", {
          hostAlias,
          error: result.error,
        });
        return null;
      }
      return result.data.stdout as string;
    } catch (error: any) {
      pceLogger.warn("Switch ingestion: live config fetch threw, falling back to static seed", {
        hostAlias,
        error: error.message,
      });
      return null;
    }
  }

  async dispose(): Promise<void> {
    await this.twinUpdater.close();
  }
}
