import { TwinUpdateService } from "../../twin";
import { TwinQueryService } from "../../twin/api/twin-query-service";
import type { TwinEntity } from "../../twin/models/entities";
import { TwinEntityType } from "../../twin/models/entities";
import type { TwinRelationship } from "../../twin/models/relationships";
import { TwinRelationshipType } from "../../twin/models/relationships";
import { PfctlFirewallParser } from "../../parsers/security/pfctl-firewall-parser";
import { OpnsenseReadOnlyTool } from "../../tools/opnsense/readonly/opnsense-readonly-tool";
import type { ExecutionContext } from "../../types/execution";
import type { ExposureSnapshotEntry } from "../api/ingestion-summary-store";
import { IngestionSummaryStore } from "../api/ingestion-summary-store";
import { pceLogger } from "../utils/logger";

type FirewallAliasDefinition = {
  name: string;
  aliasType: string | null;
  description: string | null;
  entries: string[];
  cidrs: string[];
};

export interface FirewallIngestionOptions {
  limit?: number;
}

export class FirewallIngestionOrchestrator {
  private opnsenseTool = new OpnsenseReadOnlyTool();
  private firewallParser = new PfctlFirewallParser();
  private twinUpdater = new TwinUpdateService();

  async ingestFirewall(options: FirewallIngestionOptions = {}): Promise<void> {
    const collectedAt = new Date();
    const context = this.createContext("opnsense_readonly");

    try {
      // Fetch firewall rules via opnsense_readonly (uses SSH + pfctl internally)
      const result = await this.opnsenseTool.execute(
        { action: "firewall_rules_list", limit: options.limit },
        context
      );

      if (result.error) {
        pceLogger.error("Failed to fetch firewall rules", { error: result.error });
        return;
      }

      // The result should have the structure from getFirewallRulesViaSSH:
      // { rules: string[], nat: string[], source: "ssh_pfctl", timestamp: string }
      const parserInput = {
        rules: result.data?.rules || [],
        nat: result.data?.nat || [],
        source: result.data?.source || "ssh_pfctl",
        timestamp: result.data?.timestamp || new Date().toISOString(),
      };

      // Parse into canonical entities
      const parseResult = await this.firewallParser.parse(parserInput, {
        source: "opnsense_firewall",
        collectedAt,
      });

      if (!parseResult.entities.length) {
        pceLogger.warn("No firewall rules parsed; twin not updated.");
        return;
      }

      const aliasDefinitions = await this.fetchFirewallAliases(context);
      const aliasEntities = this.buildAliasEntities(aliasDefinitions, collectedAt);
      const aliasRelationships = this.buildAliasRelationships(aliasDefinitions, collectedAt);
      const aliasMap = this.buildAliasMap(aliasDefinitions);

      const interfaceSubnetMap = await this.buildInterfaceSubnetMap(parseResult.entities);

      // Log sample entity to verify CIDR preservation
      const sampleEntity = parseResult.entities.find(
        (entity) => entity.type === TwinEntityType.FIREWALL_RULE
      );
      const sampleRuleData = sampleEntity?.data as
        | {
            source?: unknown;
            destination?: unknown;
          }
        | undefined;
      if (sampleEntity && (sampleRuleData?.source || sampleRuleData?.destination)) {
        pceLogger.debug("Sample parsed entity", {
          id: sampleEntity.id,
          source: sampleRuleData.source,
          destination: sampleRuleData.destination,
        });
      }

      // Create relationships to interfaces/subnets based on rule data
      const ruleRelationships = await this.createRuleRelationships(
        parseResult.entities,
        aliasMap,
        interfaceSubnetMap
      );
      const relationships = [...ruleRelationships, ...aliasRelationships];
      const entities = [...parseResult.entities, ...aliasEntities];

      // Ensure subnet entities exist for any CIDRs referenced in relationships
      await this.ensureSubnetEntities(entities, relationships);

      // Upsert into twin
      await this.twinUpdater.initialize();
      await this.twinUpdater.upsert(entities, relationships);

      try {
        await this.refreshExposureEdges();
      } catch (error: any) {
        pceLogger.warn("Failed to refresh exposure edges", { error: error.message });
      }

      try {
        await this.recordExposureSummary();
      } catch (error: any) {
        pceLogger.warn("Failed to record exposure summary", { error: error.message });
      }

      pceLogger.info("Firewall ingestion complete", {
        entities: entities.length,
        relationships: relationships.length,
      });
    } catch (error: any) {
      pceLogger.error("Firewall ingestion failed", { error: error.message });
      throw error;
    }
  }

  private async refreshExposureEdges(): Promise<void> {
    const queryService = new TwinQueryService();
    try {
      const exposureEntries = await queryService.exposureMap();
      const derivedRelationships = this.buildExposureRelationships(exposureEntries);
      if (!derivedRelationships.length) {
        return;
      }

      await this.twinUpdater.initialize();
      await this.twinUpdater.deleteRelationshipsByType([
        TwinRelationshipType.EXPOSES,
        TwinRelationshipType.REACHABLE,
      ]);
      await this.twinUpdater.upsert([], derivedRelationships);
    } finally {
      await queryService.close();
    }
  }

  private buildExposureRelationships(
    exposures: Array<{
      vmId: string;
      subnet: string;
      subnetId?: string;
      allowedBy: string[];
      blockedBy: string[];
    }>
  ): TwinRelationship[] {
    const relationships: TwinRelationship[] = [];
    const now = new Date();

    for (const entry of exposures) {
      const subnetId =
        entry.subnetId ?? `network-subnet:${entry.subnet.toLowerCase()}`;
      if (entry.allowedBy.length === 0 && entry.blockedBy.length === 0) {
        continue;
      }

      if (entry.allowedBy.length > 0) {
        relationships.push({
          type: TwinRelationshipType.EXPOSES,
          fromId: entry.vmId,
          toId: subnetId,
          metadata: {
            allowedBy: entry.allowedBy,
            blockedBy: entry.blockedBy,
          },
          collectedAt: now,
        });
      }

      if (entry.allowedBy.length > 0 && entry.blockedBy.length === 0) {
        relationships.push({
          type: TwinRelationshipType.REACHABLE,
          fromId: subnetId,
          toId: entry.vmId,
          metadata: {
            allowedBy: entry.allowedBy,
          },
          collectedAt: now,
        });
      }
    }

    return relationships;
  }

  private async recordExposureSummary(): Promise<void> {
    const queryService = new TwinQueryService();
    const summaryStore = new IngestionSummaryStore();
    try {
      const current = await queryService.exposureMap();
      const snapshot: ExposureSnapshotEntry[] = current.map((entry) => ({
        vmId: entry.vmId,
        vmName: entry.vmName,
        subnet: entry.subnet,
        subnetId: entry.subnetId,
        allowedBy: entry.allowedBy,
        blockedBy: entry.blockedBy,
      }));

      const previous = await summaryStore.getLatestSummary();
      const diff = this.diffExposureSnapshots(previous?.snapshot ?? [], snapshot);
      await summaryStore.saveSummary({
        createdAt: new Date(),
        newlyExposed: diff.newlyExposed,
        newlyBlocked: diff.newlyBlocked,
        snapshot,
      });

      if (diff.newlyExposed.length > 0 || diff.newlyBlocked.length > 0) {
        pceLogger.info("Exposure summary updated", {
          newlyExposed: diff.newlyExposed.length,
          newlyBlocked: diff.newlyBlocked.length,
        });
      }
    } finally {
      await queryService.close();
      summaryStore.close();
    }
  }

  private diffExposureSnapshots(
    previous: ExposureSnapshotEntry[],
    current: ExposureSnapshotEntry[]
  ): { newlyExposed: ExposureSnapshotEntry[]; newlyBlocked: ExposureSnapshotEntry[] } {
    const prevMap = new Map<string, ExposureSnapshotEntry>();
    for (const entry of previous) {
      prevMap.set(`${entry.vmId}|${entry.subnetId}`, entry);
    }

    const newlyExposed: ExposureSnapshotEntry[] = [];
    const newlyBlocked: ExposureSnapshotEntry[] = [];

    for (const entry of current) {
      const key = `${entry.vmId}|${entry.subnetId}`;
      const prev = prevMap.get(key);

      if (entry.allowedBy.length > 0 && (!prev || prev.allowedBy.length === 0)) {
        newlyExposed.push(entry);
      }
      if (entry.blockedBy.length > 0 && (!prev || prev.blockedBy.length === 0)) {
        newlyBlocked.push(entry);
      }
    }

    return { newlyExposed, newlyBlocked };
  }

  private async fetchFirewallAliases(
    context: ExecutionContext
  ): Promise<FirewallAliasDefinition[]> {
    const listResult = await this.opnsenseTool.execute(
      { action: "firewall_aliases_list" },
      context
    );
    if (listResult.error) {
      pceLogger.warn("Failed to fetch firewall aliases", { error: listResult.error });
      return [];
    }

    const rawAliases = this.toArray(listResult.data?.aliases);
    const aliasRows = rawAliases.filter((row): row is Record<string, unknown> =>
      this.isRecord(row)
    );

    const aliasDefinitions: FirewallAliasDefinition[] = [];
    for (const row of aliasRows) {
      const name = this.coerceString(row.name ?? row.alias ?? row.alias_name ?? row.id);
      if (!name) continue;

      const rowContent = row.content ?? row.addresses ?? row.items;
      if (rowContent !== undefined) {
        aliasDefinitions.push(this.buildAliasDefinition(name, row));
        continue;
      }

      const detailResult = await this.opnsenseTool.execute(
        { action: "firewall_aliases_get", alias_name: name },
        context
      );
      if (detailResult.error) {
        pceLogger.warn("Failed to fetch firewall alias detail", {
          alias: name,
          error: detailResult.error,
        });
        continue;
      }

      const detail = this.extractAliasDetail(detailResult.data);
      aliasDefinitions.push(this.buildAliasDefinition(name, detail ?? row));
    }

    return aliasDefinitions;
  }

  private buildAliasEntities(
    aliases: FirewallAliasDefinition[],
    collectedAt: Date
  ): TwinEntity[] {
    return aliases.map((alias) => ({
      id: this.normalizeAliasId(alias.name),
      type: TwinEntityType.FIREWALL_ALIAS,
      displayName: alias.name,
      source: "opnsense_alias",
      collectedAt,
      data: {
        name: alias.name,
        aliasType: alias.aliasType ?? null,
        description: alias.description ?? null,
        entries: alias.entries,
        cidrs: alias.cidrs,
      },
    }));
  }

  private buildAliasRelationships(
    aliases: FirewallAliasDefinition[],
    collectedAt: Date
  ): TwinRelationship[] {
    const relationships: TwinRelationship[] = [];
    for (const alias of aliases) {
      for (const cidr of alias.cidrs) {
        relationships.push({
          type: TwinRelationshipType.ALIAS_RESOLVES_TO,
          fromId: this.normalizeAliasId(alias.name),
          toId: `network-subnet:${cidr.toLowerCase()}`,
          metadata: { aliasName: alias.name },
          collectedAt,
        });
      }
    }
    return relationships;
  }

  private buildAliasMap(aliases: FirewallAliasDefinition[]): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const alias of aliases) {
      map.set(alias.name.toLowerCase(), alias.cidrs);
    }
    return map;
  }

  private async buildInterfaceSubnetMap(
    entities: TwinEntity[]
  ): Promise<Map<string, string[]>> {
    const interfaceNames = new Set<string>();
    for (const entity of entities) {
      if (entity.type !== TwinEntityType.FIREWALL_RULE) continue;
      const data = entity.data;
      if (typeof data?.source === "string") {
        this.extractInterfaceMacros(data.source).forEach((iface) => interfaceNames.add(iface));
      }
      if (typeof data?.destination === "string") {
        this.extractInterfaceMacros(data.destination).forEach((iface) => interfaceNames.add(iface));
      }
    }

    const interfaceSubnetMap = new Map<string, string[]>();
    if (interfaceNames.size === 0) {
      return interfaceSubnetMap;
    }

    const queryService = new TwinQueryService();
    try {
      for (const ifaceName of interfaceNames) {
        const subnets = await queryService.subnetsByInterfaceName(ifaceName);
        if (subnets.length > 0) {
          interfaceSubnetMap.set(ifaceName.toLowerCase(), subnets);
        }
      }
    } finally {
      await queryService.close();
    }

    return interfaceSubnetMap;
  }

  private resolveCidrs(
    value: string,
    aliasMap: Map<string, string[]>,
    interfaceSubnetMap: Map<string, string[]>
  ): { cidrs: string[]; unresolvedAliases: string[]; unresolvedInterfaces: string[] } {
    const cidrs = new Set<string>();
    const unresolvedAliases: string[] = [];
    const unresolvedInterfaces: string[] = [];

    for (const cidr of this.extractCidrs(value)) {
      cidrs.add(cidr);
    }

    for (const alias of this.extractAliasNames(value)) {
      const resolved = aliasMap.get(alias.toLowerCase());
      if (resolved && resolved.length > 0) {
        resolved.forEach((cidr) => cidrs.add(cidr));
      } else {
        unresolvedAliases.push(alias);
      }
    }

    for (const iface of this.extractInterfaceMacros(value)) {
      const resolved = interfaceSubnetMap.get(iface.toLowerCase());
      if (resolved && resolved.length > 0) {
        resolved.forEach((cidr) => cidrs.add(cidr));
      } else {
        unresolvedInterfaces.push(iface);
      }
    }

    return {
      cidrs: Array.from(cidrs.values()),
      unresolvedAliases,
      unresolvedInterfaces,
    };
  }

  private buildAliasDefinition(
    name: string,
    raw: Record<string, unknown>
  ): FirewallAliasDefinition {
    const aliasType = this.coerceString(raw.type ?? raw.alias_type ?? raw.category);
    const description = this.coerceString(raw.description ?? raw.descr ?? raw.desc);
    const content = raw.content ?? raw.addresses ?? raw.items ?? raw.aliases ?? raw.values;
    const entries = this.parseAliasEntries(content);
    const cidrs = this.dedupeCidrs(entries.flatMap((entry) => this.extractCidrs(entry)));
    return {
      name,
      aliasType,
      description,
      entries,
      cidrs,
    };
  }

  private extractAliasDetail(data: unknown): Record<string, unknown> | null {
    if (!this.isRecord(data)) return null;
    if (this.isRecord(data.alias)) {
      return data.alias;
    }
    if (this.isRecord(data.item)) {
      return data.item;
    }
    return data;
  }

  private parseAliasEntries(raw: unknown): string[] {
    if (Array.isArray(raw)) {
      return raw
        .map((entry) => this.coerceString(entry))
        .filter((entry): entry is string => Boolean(entry));
    }
    const str = this.coerceString(raw);
    if (!str) return [];
    return str
      .split(/[,\n]+/)
      .flatMap((segment) => segment.split(/\s+/))
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
  }

  private extractAliasNames(value: string): string[] {
    const matches = value.matchAll(/<([^>]+)>/g);
    const names: string[] = [];
    for (const match of matches) {
      const name = match[1]?.trim();
      if (name) names.push(name);
    }
    return names;
  }

  private extractInterfaceMacros(value: string): string[] {
    const matches = value.matchAll(/\(([^():]+):network\)/gi);
    const names: string[] = [];
    for (const match of matches) {
      const name = match[1]?.trim();
      if (name && name.toLowerCase() !== "self") {
        names.push(name);
      }
    }
    return names;
  }

  private normalizeAliasId(aliasName: string): string {
    return `firewall-alias:${aliasName.toLowerCase()}`;
  }

  private dedupeCidrs(cidrs: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const cidr of cidrs) {
      const key = cidr.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(cidr);
    }
    return out;
  }

  private coerceString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  private toArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }

  /**
   * Create ALLOWS/BLOCKS relationships between firewall rules and interfaces/subnets.
   * Also link rules to interfaces based on the interface field.
   */
  private async createRuleRelationships(
    entities: TwinEntity[],
    aliasMap: Map<string, string[]>,
    interfaceSubnetMap: Map<string, string[]>
  ): Promise<TwinRelationship[]> {
    const relationships: TwinRelationship[] = [];
    let skippedCidrInvalid = 0;
    let skippedAliasUnresolved = 0;
    let skippedInterfaceMacroUnresolved = 0;
    let createdCount = 0;
    const unresolvedAliasNames = new Set<string>();
    const unresolvedInterfaceNames = new Set<string>();

    for (const entity of entities) {
      if (entity.type !== TwinEntityType.FIREWALL_RULE) continue;

      const data = entity.data || {};
      const ruleId = entity.id;

      // Link rule to interface if interface is specified
      if (data.interface) {
        const ifaceId = `network-if:opnsense:${data.interface.toLowerCase()}`;
        // We'll create this relationship during ingestion when we have the full graph
        // For now, we'll just log it
      }

      // Create ALLOWS relationship for pass rules
      // Check both source and destination for CIDRs
      if (data.action === "pass") {
        // If destination is a CIDR, link to subnet
        if (typeof data.destination === "string" && data.destination.toLowerCase() !== "any") {
          const resolvedDest = this.resolveCidrs(data.destination, aliasMap, interfaceSubnetMap);
          const destCidrs = resolvedDest.cidrs;
          if (destCidrs.length > 0) {
            for (const cidr of destCidrs) {
              const subnetId = `network-subnet:${cidr.toLowerCase()}`;
              relationships.push({
                type: TwinRelationshipType.ALLOWS,
                fromId: ruleId,
                toId: subnetId,
                metadata: {
                  direction: data.direction,
                  protocol: data.protocol,
                  port: data.destinationPort,
                },
                collectedAt: entity.collectedAt,
              });
              createdCount++;
            }
          } else {
            if (resolvedDest.unresolvedAliases.length > 0) {
              skippedAliasUnresolved++;
              resolvedDest.unresolvedAliases.forEach((name) => unresolvedAliasNames.add(name));
            } else if (resolvedDest.unresolvedInterfaces.length > 0) {
              skippedInterfaceMacroUnresolved++;
              resolvedDest.unresolvedInterfaces.forEach((name) => unresolvedInterfaceNames.add(name));
            } else {
              skippedCidrInvalid++;
            }
            pceLogger.debug(
              `Skipping rule ${ruleId}: destination "${data.destination}" contains no valid CIDR`
            );
          }
        }
        // If source is a CIDR and destination is "any", also link to source subnet
        if (!data.destination || (typeof data.destination === "string" && data.destination.toLowerCase() === "any")) {
          if (typeof data.source === "string" && data.source.toLowerCase() !== "any") {
            const resolvedSource = this.resolveCidrs(data.source, aliasMap, interfaceSubnetMap);
            const sourceCidrs = resolvedSource.cidrs;
            if (sourceCidrs.length > 0) {
              for (const cidr of sourceCidrs) {
                const subnetId = `network-subnet:${cidr.toLowerCase()}`;
                relationships.push({
                  type: TwinRelationshipType.ALLOWS,
                  fromId: ruleId,
                  toId: subnetId,
                  metadata: {
                    direction: data.direction,
                    protocol: data.protocol,
                    port: data.sourcePort,
                  },
                  collectedAt: entity.collectedAt,
                });
                createdCount++;
              }
            } else {
              if (resolvedSource.unresolvedAliases.length > 0) {
                skippedAliasUnresolved++;
                resolvedSource.unresolvedAliases.forEach((name) => unresolvedAliasNames.add(name));
              } else if (resolvedSource.unresolvedInterfaces.length > 0) {
                skippedInterfaceMacroUnresolved++;
                resolvedSource.unresolvedInterfaces.forEach((name) => unresolvedInterfaceNames.add(name));
              } else {
                skippedCidrInvalid++;
              }
              pceLogger.debug(
                `Skipping rule ${ruleId}: source "${data.source}" contains no valid CIDR`
              );
            }
          }
        }
      }

      // Create BLOCKS relationship for block/reject rules
      // Check both source and destination for CIDRs
      if (data.action === "block" || data.action === "reject") {
        if (typeof data.destination === "string" && data.destination.toLowerCase() !== "any") {
          const resolvedDest = this.resolveCidrs(data.destination, aliasMap, interfaceSubnetMap);
          const destCidrs = resolvedDest.cidrs;
          if (destCidrs.length > 0) {
            for (const cidr of destCidrs) {
              const subnetId = `network-subnet:${cidr.toLowerCase()}`;
              relationships.push({
                type: TwinRelationshipType.BLOCKS,
                fromId: ruleId,
                toId: subnetId,
                metadata: {
                  direction: data.direction,
                  protocol: data.protocol,
                  port: data.destinationPort,
                },
                collectedAt: entity.collectedAt,
              });
              createdCount++;
            }
          } else {
            if (resolvedDest.unresolvedAliases.length > 0) {
              skippedAliasUnresolved++;
              resolvedDest.unresolvedAliases.forEach((name) => unresolvedAliasNames.add(name));
            } else if (resolvedDest.unresolvedInterfaces.length > 0) {
              skippedInterfaceMacroUnresolved++;
              resolvedDest.unresolvedInterfaces.forEach((name) => unresolvedInterfaceNames.add(name));
            } else {
              skippedCidrInvalid++;
            }
            pceLogger.debug(
              `Skipping rule ${ruleId}: destination "${data.destination}" contains no valid CIDR`
            );
          }
        }
        // If source is a CIDR and destination is "any", also link to source subnet
        if (!data.destination || (typeof data.destination === "string" && data.destination.toLowerCase() === "any")) {
          if (typeof data.source === "string" && data.source.toLowerCase() !== "any") {
            const resolvedSource = this.resolveCidrs(data.source, aliasMap, interfaceSubnetMap);
            const sourceCidrs = resolvedSource.cidrs;
            if (sourceCidrs.length > 0) {
              for (const cidr of sourceCidrs) {
                const subnetId = `network-subnet:${cidr.toLowerCase()}`;
                relationships.push({
                  type: TwinRelationshipType.BLOCKS,
                  fromId: ruleId,
                  toId: subnetId,
                  metadata: {
                    direction: data.direction,
                    protocol: data.protocol,
                    port: data.sourcePort,
                  },
                  collectedAt: entity.collectedAt,
                });
                createdCount++;
              }
            } else {
              if (resolvedSource.unresolvedAliases.length > 0) {
                skippedAliasUnresolved++;
                resolvedSource.unresolvedAliases.forEach((name) => unresolvedAliasNames.add(name));
              } else if (resolvedSource.unresolvedInterfaces.length > 0) {
                skippedInterfaceMacroUnresolved++;
                resolvedSource.unresolvedInterfaces.forEach((name) => unresolvedInterfaceNames.add(name));
              } else {
                skippedCidrInvalid++;
              }
              pceLogger.debug(
                `Skipping rule ${ruleId}: source "${data.source}" contains no valid CIDR`
              );
            }
          }
        }
      }
    }

    if (skippedCidrInvalid > 0) {
      pceLogger.warn(`Skipped ${skippedCidrInvalid} relationships due to invalid CIDR format`);
    }
    if (skippedAliasUnresolved > 0) {
      // "Unresolved" here almost always means the alias exists but its content
      // isn't expressible as a CIDR — a dynamic/runtime table (sshlockout,
      // virusprot), a GeoIP country-code alias, or a hostname/FQDN alias — not
      // a missing/misconfigured alias. Naming them here saves re-deriving this
      // by hand each time (see aliasMap in buildAliasMap for where the actual
      // content gets checked).
      pceLogger.warn(
        `Skipped ${skippedAliasUnresolved} relationships: alias content not expressible as a CIDR (dynamic table, GeoIP, or hostname alias) — ${Array.from(unresolvedAliasNames).sort().join(", ")}`
      );
    }
    if (skippedInterfaceMacroUnresolved > 0) {
      pceLogger.warn(
        `Skipped ${skippedInterfaceMacroUnresolved} relationships due to unresolved interface macros: ${Array.from(unresolvedInterfaceNames).sort().join(", ")}`
      );
    }
    if (createdCount > 0) {
      pceLogger.info(`Created ${createdCount} firewall rule relationships`);
    }

    return relationships;
  }

  /**
   * Ensure subnet entities exist for any CIDRs referenced in relationships.
   * Creates subnet entities on-the-fly if they don't exist.
   */
  private async ensureSubnetEntities(
    entities: any[],
    relationships: any[]
  ): Promise<void> {
    const subnetIds = new Set<string>();
    
    // Extract all subnet IDs from relationships
    for (const rel of relationships) {
      if (rel.toId && rel.toId.startsWith("network-subnet:")) {
        subnetIds.add(rel.toId);
      }
    }

    // Also check entities for source/destination CIDRs that might need subnets
    for (const entity of entities) {
      if (entity.type !== "firewall_rule") continue;
      const data = entity.data || {};
      for (const cidr of this.extractCidrs(data.source)) {
        subnetIds.add(`network-subnet:${cidr.toLowerCase()}`);
      }
      for (const cidr of this.extractCidrs(data.destination)) {
        subnetIds.add(`network-subnet:${cidr.toLowerCase()}`);
      }
    }

    if (subnetIds.size === 0) {
      return;
    }

    // Create subnet entities for all referenced CIDRs
    // MERGE in Neo4j will handle duplicates if they already exist
    const subnetEntities: any[] = [];
    for (const subnetId of subnetIds) {
      // Extract CIDR from subnet ID: "network-subnet:172.16.0.0/22" -> "172.16.0.0/22"
      const cidr = subnetId.replace("network-subnet:", "");
      const cidrMask = cidr.split("/")[1];
      const mask = cidr.includes("/") && cidrMask ? parseInt(cidrMask, 10) : 0;
      
      subnetEntities.push({
        id: subnetId,
        type: "network_subnet",
        displayName: cidr,
        source: "firewall_ingestion",
        collectedAt: new Date(),
        data: {
          cidr,
          mask,
          gateway: null,
          interfaceCount: 0,
        },
      });
    }
    
    if (subnetEntities.length > 0) {
      pceLogger.info(`Ensuring ${subnetEntities.length} subnet entities exist for firewall relationships`);
      await this.twinUpdater.initialize();
      // Upsert subnets (MERGE will handle existing ones)
      await this.twinUpdater.upsert(subnetEntities, []);
    }
  }

  /**
   * Extract and normalize one-or-more CIDRs from a pfctl-derived field.
   *
   * pfctl rules can contain:
   * - single IPs (no mask)
   * - CIDRs
   * - sets like "{ 10.0.0.0/8, 172.16.0.0/22 }"
   * - redacted values like "IP-[REDACTED]/22"
   */
  private extractCidrs(input: unknown): string[] {
    if (typeof input !== "string") return [];
    const raw = input.trim();
    if (!raw) return [];
    if (raw.toLowerCase() === "any") return [];

    const cidrs: string[] = [];

    // Preserve redacted CIDR markers if they include a mask
    const redactedMatch = raw.match(/\bIP-\[REDACTED\]\/\d{1,3}\b/i);
    if (redactedMatch) {
      cidrs.push(redactedMatch[0]);
    }

    // IPv4 tokens, with optional /mask
    const ipv4Re = /\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?\b/g;
    for (const match of raw.matchAll(ipv4Re)) {
      const normalized = this.normalizeIpv4CidrToken(match[0]);
      if (normalized) cidrs.push(normalized);
    }

    // IPv6 tokens, with optional /mask
    const ipv6Re = /\b(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}(?:\/\d{1,3})?\b/g;
    for (const match of raw.matchAll(ipv6Re)) {
      const normalized = this.normalizeIpv6CidrToken(match[0]);
      if (normalized) cidrs.push(normalized);
    }

    // De-dupe while preserving order
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of cidrs) {
      const key = c.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
    return out;
  }

  private normalizeIpv4CidrToken(token: string): string | null {
    const [ipPart, maskPart] = token.split("/");
    if (!ipPart) return null;
    const octets = ipPart.split(".").map((n) => Number(n));
    if (octets.length !== 4) return null;
    if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;

    const mask = maskPart === undefined ? 32 : Number(maskPart);
    if (!Number.isInteger(mask) || mask < 0 || mask > 32) return null;

    return `${octets.join(".")}/${mask}`;
  }

  private normalizeIpv6CidrToken(token: string): string | null {
    // We don't fully validate IPv6 here; we only normalize the mask and keep the address text.
    const [addr, maskPart] = token.split("/");
    if (!addr) return null;
    if (!addr.includes(":")) return null;

    const mask = maskPart === undefined ? 128 : Number(maskPart);
    if (!Number.isInteger(mask) || mask < 0 || mask > 128) return null;

    return `${addr}/${mask}`;
  }

  private createContext(toolName: string): ExecutionContext {
    return { toolName, startedAt: Date.now() };
  }

  async dispose(): Promise<void> {
    // Close Neo4j connection
    if (this.twinUpdater) {
      await this.twinUpdater.close();
    }
  }
}

