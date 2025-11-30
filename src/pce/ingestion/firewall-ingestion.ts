import { TwinUpdateService } from "../../twin";
import { PfctlFirewallParser } from "../../parsers/security/pfctl-firewall-parser";
import { OpnsenseReadOnlyTool } from "../../tools/opnsense/readonly/opnsense-readonly-tool";
import type { ExecutionContext } from "../../types/execution";
import { pceLogger } from "../utils/logger";

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

      // Log sample entity to verify CIDR preservation
      const sampleEntity = parseResult.entities.find((e: any) => e.data?.source || e.data?.destination);
      if (sampleEntity) {
        pceLogger.debug("Sample parsed entity", {
          id: sampleEntity.id,
          source: sampleEntity.data?.source,
          destination: sampleEntity.data?.destination,
        });
      }

      // Create relationships to interfaces/subnets based on rule data
      const relationships = await this.createRuleRelationships(parseResult.entities);

      // Ensure subnet entities exist for any CIDRs referenced in relationships
      await this.ensureSubnetEntities(parseResult.entities, relationships);

      // Upsert into twin
      await this.twinUpdater.initialize();
      await this.twinUpdater.upsert(parseResult.entities, relationships);

      pceLogger.info("Firewall ingestion complete", {
        entities: parseResult.entities.length,
        relationships: relationships.length,
      });
    } catch (error: any) {
      pceLogger.error("Firewall ingestion failed", { error: error.message });
      throw error;
    }
  }

  /**
   * Create ALLOWS/BLOCKS relationships between firewall rules and interfaces/subnets.
   * Also link rules to interfaces based on the interface field.
   */
  private async createRuleRelationships(
    entities: any[]
  ): Promise<any[]> {
    const relationships: any[] = [];
    let skippedCidrInvalid = 0;
    let skippedSubnetMissing = 0;
    let createdCount = 0;

    for (const entity of entities) {
      if (entity.type !== "firewall_rule") continue;

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
        if (data.destination && this.isCidr(data.destination)) {
          const subnetId = `network-subnet:${data.destination.toLowerCase()}`;
          relationships.push({
            type: "ALLOWS",
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
        } else if (data.destination && data.destination !== "any") {
          skippedCidrInvalid++;
          pceLogger.debug(`Skipping rule ${ruleId}: destination "${data.destination}" is not a valid CIDR`);
        }
        // If source is a CIDR and destination is "any", also link to source subnet
        if (data.source && this.isCidr(data.source) && (!data.destination || data.destination === "any")) {
          const subnetId = `network-subnet:${data.source.toLowerCase()}`;
          relationships.push({
            type: "ALLOWS",
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
        } else if (data.source && data.source !== "any" && !this.isCidr(data.source)) {
          skippedCidrInvalid++;
          pceLogger.debug(`Skipping rule ${ruleId}: source "${data.source}" is not a valid CIDR`);
        }
      }

      // Create BLOCKS relationship for block/reject rules
      // Check both source and destination for CIDRs
      if (data.action === "block" || data.action === "reject") {
        if (data.destination && this.isCidr(data.destination)) {
          const subnetId = `network-subnet:${data.destination.toLowerCase()}`;
          relationships.push({
            type: "BLOCKS",
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
        } else if (data.destination && data.destination !== "any") {
          skippedCidrInvalid++;
          pceLogger.debug(`Skipping rule ${ruleId}: destination "${data.destination}" is not a valid CIDR`);
        }
        // If source is a CIDR and destination is "any", also link to source subnet
        if (data.source && this.isCidr(data.source) && (!data.destination || data.destination === "any")) {
          const subnetId = `network-subnet:${data.source.toLowerCase()}`;
          relationships.push({
            type: "BLOCKS",
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
        } else if (data.source && data.source !== "any" && !this.isCidr(data.source)) {
          skippedCidrInvalid++;
          pceLogger.debug(`Skipping rule ${ruleId}: source "${data.source}" is not a valid CIDR`);
        }
      }
    }

    if (skippedCidrInvalid > 0) {
      pceLogger.warn(`Skipped ${skippedCidrInvalid} relationships due to invalid CIDR format`);
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
      if (data.source && this.isCidr(data.source)) {
        subnetIds.add(`network-subnet:${data.source.toLowerCase()}`);
      }
      if (data.destination && this.isCidr(data.destination)) {
        subnetIds.add(`network-subnet:${data.destination.toLowerCase()}`);
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
      const mask = cidr.includes("/") ? parseInt(cidr.split("/")[1]) : 0;
      
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

  private isCidr(str: string): boolean {
    if (!str || typeof str !== "string") return false;
    // Handle redacted IPs like "IP-[REDACTED]/22" - treat as CIDR if it has /mask
    if (str.includes("/") && str.match(/\/\d+$/)) {
      return true;
    }
    // Standard IPv4 CIDR
    if (/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(str)) {
      return true;
    }
    // IPv6 CIDR
    if (/^[0-9a-f:]+::\/\d+$/i.test(str)) {
      return true;
    }
    return false;
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


