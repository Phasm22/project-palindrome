/**
 * Topology YAML Ingestion
 * Phase I-B: Extract entities and relationships from topology.yaml
 * 
 * Extracts:
 * - Networks (Network nodes)
 * - Hosts (Host nodes)
 * - Containers (Container nodes)
 * - Services (Service nodes)
 * - Dependencies (Dependency nodes)
 * - VLANs (VLAN nodes)
 * 
 * Relationships:
 * - Host CONNECTS_TO Network
 * - Container RUNS_ON Host
 * - Container DEPENDS_ON Service/Container
 * - Service RUNS_ON Host
 * - Host HOSTS Container/VM
 * - Network BELONGS_TO VLAN (if VLAN specified)
 */

import { promises as fs } from "fs";
import { parse as parseYaml } from "yaml";
import { createHash } from "crypto";
import type { ACLGroup } from "../types";
import type { GraphNode, GraphRelationship } from "../kg/schema/ontology";
import { NodeType, RelationshipType } from "../kg/schema/ontology";
import { generateCanonicalId, normalizeEntityText } from "../edl/normalization/normalizer";
import { pceLogger } from "../utils/logger";

export interface TopologyYaml {
  networks?: Record<string, {
    cidr: string;
    gateway?: string;
    vlan?: number | null;
  }>;
  vpn?: Record<string, {
    cidr?: string;
    server?: string;
    dns?: string;
  }>;
  hosts?: Array<{
    name: string;
    role?: string;
    ip?: string;
    network?: string;
    os?: string;
    status?: string;
  }>;
  containers?: Array<{
    name: string;
    type?: string;
    host?: string;
    image?: string;
    status?: string;
    depends_on?: string[];
  }>;
  services?: Array<{
    name: string;
    port?: number;
    protocol?: string;
    host?: string;
    status?: string;
  }>;
  dependencies?: Array<{
    name: string;
    depends_on?: string;
    source?: string;
    target?: string;
    type?: string;
    critical?: boolean;
  }> | Record<string, {
    source?: string;
    target?: string;
    depends_on?: string;
    type?: string;
    critical?: boolean;
  }>;
  switch?: {
    model?: string;
    trunk_ports?: string[];
    vlans?: number[];
  };
}

export interface TopologyIngestionResult {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  versionHash: string;
}

/**
 * Compute version hash for topology file
 */
function computeTopologyVersionHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Extract entities and relationships from topology.yaml
 */
export async function extractTopologyEntities(
  topologyPath: string,
  aclGroup: ACLGroup = "viewer"
): Promise<TopologyIngestionResult> {
  try {
    pceLogger.info(`Extracting topology entities from: ${topologyPath}`);

    // Read and parse YAML
    const content = await fs.readFile(topologyPath, "utf-8");
    const topology = parseYaml(content) as TopologyYaml;
    const versionHash = computeTopologyVersionHash(content);
    const sourcePath = `topology://${topologyPath}`;
    const timestamp = new Date();

    const nodes: GraphNode[] = [];
    const relationships: GraphRelationship[] = [];
    const nodeIdMap = new Map<string, string>(); // Map entity names to canonical IDs

    // Extract Networks
    if (topology.networks) {
      for (const [networkName, networkData] of Object.entries(topology.networks)) {
        const normalizedName = normalizeEntityText(networkName);
        const networkId = generateCanonicalId(normalizedName, NodeType.NETWORK);
        nodeIdMap.set(networkName, networkId);

        const networkNode: GraphNode = {
          id: networkId,
          type: NodeType.NETWORK,
          attributes: {
            cidr: networkData.cidr,
            name: networkName,
            gateway: networkData.gateway,
          },
          versionHash,
          sourcePath,
          aclGroup,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        nodes.push(networkNode);

        // Create VLAN node if VLAN is specified
        if (networkData.vlan !== null && networkData.vlan !== undefined) {
          const vlanId = generateCanonicalId(`vlan-${networkData.vlan}`, NodeType.VLAN);
          if (!nodeIdMap.has(`vlan-${networkData.vlan}`)) {
            const vlanNode: GraphNode = {
              id: vlanId,
              type: NodeType.VLAN,
              attributes: {
                id: networkData.vlan,
                name: `VLAN ${networkData.vlan}`,
                description: `VLAN for ${networkName} network`,
              },
              versionHash,
              sourcePath,
              aclGroup,
              createdAt: timestamp,
              updatedAt: timestamp,
            };
            nodes.push(vlanNode);
            nodeIdMap.set(`vlan-${networkData.vlan}`, vlanId);

            // Network BELONGS_TO VLAN
            relationships.push({
              id: `${networkId}-belongs_to-${vlanId}`,
              type: RelationshipType.BELONGS_TO,
              from: networkId,
              to: vlanId,
              versionHash,
              sourcePath,
              aclGroup,
              createdAt: timestamp,
            });
          }
        }
      }
    }

    // Extract Hosts
    if (topology.hosts) {
      for (const host of topology.hosts) {
        const normalizedName = normalizeEntityText(host.name);
        const hostId = generateCanonicalId(normalizedName, NodeType.HOST);
        nodeIdMap.set(host.name, hostId);

        const hostNode: GraphNode = {
          id: hostId,
          type: NodeType.HOST,
          attributes: {
            hostname: host.name,
            ip: host.ip,
            role: host.role,
            os: host.os,
            status: host.status,
          },
          versionHash,
          sourcePath,
          aclGroup,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        nodes.push(hostNode);

        // Host CONNECTS_TO Network
        if (host.network && topology.networks?.[host.network]) {
          const networkId = nodeIdMap.get(host.network);
          if (networkId) {
            relationships.push({
              id: `${hostId}-connects_to-${networkId}`,
              type: RelationshipType.CONNECTS_TO,
              from: hostId,
              to: networkId,
              properties: {
                ip: host.ip,
              },
              versionHash,
              sourcePath,
              aclGroup,
              createdAt: timestamp,
            });
          }
        }
      }
    }

    // Extract Containers
    if (topology.containers) {
      for (const container of topology.containers) {
        const normalizedName = normalizeEntityText(container.name);
        const containerId = generateCanonicalId(normalizedName, NodeType.CONTAINER);
        nodeIdMap.set(container.name, containerId);

        const containerNode: GraphNode = {
          id: containerId,
          type: NodeType.CONTAINER,
          attributes: {
            name: container.name,
            type: container.type,
            host: container.host,
            image: container.image,
            status: container.status,
          },
          versionHash,
          sourcePath,
          aclGroup,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        nodes.push(containerNode);

        // Container RUNS_ON Host
        if (container.host) {
          const hostId = nodeIdMap.get(container.host);
          if (hostId) {
            relationships.push({
              id: `${containerId}-runs_on-${hostId}`,
              type: RelationshipType.RUNS_ON,
              from: containerId,
              to: hostId,
              versionHash,
              sourcePath,
              aclGroup,
              createdAt: timestamp,
            });

            // Host HOSTS Container
            relationships.push({
              id: `${hostId}-hosts-${containerId}`,
              type: RelationshipType.HOSTS,
              from: hostId,
              to: containerId,
              versionHash,
              sourcePath,
              aclGroup,
              createdAt: timestamp,
            });
          }
        }

        // Container DEPENDS_ON other containers/services
        if (container.depends_on) {
          for (const depName of container.depends_on) {
            const depId = nodeIdMap.get(depName);
            if (depId) {
              relationships.push({
                id: `${containerId}-depends_on-${depId}`,
                type: RelationshipType.DEPENDS_ON,
                from: containerId,
                to: depId,
                versionHash,
                sourcePath,
                aclGroup,
                createdAt: timestamp,
              });
            }
          }
        }
      }
    }

    // Extract Services
    if (topology.services) {
      for (const service of topology.services) {
        const normalizedName = normalizeEntityText(service.name);
        const serviceId = generateCanonicalId(normalizedName, NodeType.SERVICE);
        nodeIdMap.set(service.name, serviceId);

        const serviceNode: GraphNode = {
          id: serviceId,
          type: NodeType.SERVICE,
          attributes: {
            name: service.name,
            port: service.port,
            protocol: service.protocol,
            status: service.status,
          },
          versionHash,
          sourcePath,
          aclGroup,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        nodes.push(serviceNode);

        // Service RUNS_ON Host
        if (service.host) {
          const hostId = nodeIdMap.get(service.host);
          if (hostId) {
            relationships.push({
              id: `${serviceId}-runs_on-${hostId}`,
              type: RelationshipType.RUNS_ON,
              from: serviceId,
              to: hostId,
              versionHash,
              sourcePath,
              aclGroup,
              createdAt: timestamp,
            });

            // Host HOSTS Service
            relationships.push({
              id: `${hostId}-hosts-${serviceId}`,
              type: RelationshipType.HOSTS,
              from: hostId,
              to: serviceId,
              versionHash,
              sourcePath,
              aclGroup,
              createdAt: timestamp,
            });
          }
        }
      }
    }

    // Extract Dependencies
    if (topology.dependencies) {
      // Handle both array and object formats
      const dependenciesArray = Array.isArray(topology.dependencies)
        ? topology.dependencies
        : Object.entries(topology.dependencies).map(([name, dep]) => ({
            name,
            ...dep,
          }));

      for (const dependency of dependenciesArray) {
        // Determine source and target
        // Support both formats: depends_on (single target) or source/target (explicit)
        const sourceName = dependency.source || dependency.name;
        const targetName = dependency.target || dependency.depends_on;

        if (!sourceName || !targetName) {
          pceLogger.warn("Skipping dependency with missing source or target", { dependency });
          continue;
        }

        // Look up source and target entity IDs
        const sourceId = nodeIdMap.get(sourceName);
        const targetId = nodeIdMap.get(targetName);

        if (sourceId && targetId) {
          // Direct relationship: source DEPENDS_ON target
          relationships.push({
            id: `${sourceId}-depends_on-${targetId}`,
            type: RelationshipType.DEPENDS_ON,
            from: sourceId,
            to: targetId,
            properties: {
              critical: dependency.critical,
              type: dependency.type,
            },
            versionHash,
            sourcePath,
            aclGroup,
            createdAt: timestamp,
          });
        } else {
          // If entities not found, log warning
          pceLogger.warn("Could not find source or target entity for dependency", {
            sourceName,
            targetName,
            sourceId: !!sourceId,
            targetId: !!targetId,
          });
        }
      }
    }

    pceLogger.info("Topology extraction complete", {
      nodes: nodes.length,
      relationships: relationships.length,
    });

    return {
      nodes,
      relationships,
      versionHash,
    };
  } catch (error: any) {
    pceLogger.error("Failed to extract topology entities", { error: error.message });
    throw error;
  }
}

/**
 * Topology Ingestion Orchestrator
 * Integrates with GraphIngestionPipeline
 */
export class TopologyIngestionOrchestrator {
  /**
   * Ingest topology.yaml into knowledge graph
   */
  static async ingestTopology(
    topologyPath: string,
    graphStore: any, // Neo4jGraphStore
    aclGroup: ACLGroup = "viewer"
  ): Promise<{ nodesWritten: number; relationshipsWritten: number }> {
    const result = await extractTopologyEntities(topologyPath, aclGroup);

    // Write nodes to graph
    if (result.nodes.length > 0) {
      await graphStore.writeNodes(result.nodes);
      pceLogger.info(`Wrote ${result.nodes.length} topology nodes to graph`);
    }

    // Write relationships to graph
    if (result.relationships.length > 0) {
      await graphStore.writeRelationships(result.relationships);
      pceLogger.info(`Wrote ${result.relationships.length} topology relationships to graph`);
    }

    return {
      nodesWritten: result.nodes.length,
      relationshipsWritten: result.relationships.length,
    };
  }
}

