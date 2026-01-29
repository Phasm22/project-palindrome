/**
 * Proxmox Inventory Ingestion Orchestrator
 * TL-2A.6: Ingestion Orchestrator & Provenance Compliance
 * 
 * Orchestrates Proxmox inventory data fetch, document generation, and ingestion
 * into both Vector Store (semantic memory) and Knowledge Graph (structural memory).
 * 
 * All data fetching uses ProxmoxClient to ensure provenance tracking.
 */

import { createHash } from "crypto";
import { promises as fs } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { DocumentType, ACLGroup } from "../types";
import { IngestionPipeline, type IngestionOptions } from "./pipeline";
import { GraphIngestionPipeline, type GraphIngestionOptions } from "./graph-pipeline";
import { ProxmoxClient, type ProxmoxApiConfig } from "../../tools/proxmox/client";
import { ProxmoxReadOnlyTool } from "../../tools/proxmox/readonly/proxmox-readonly-tool";
import {
  generateVmInventoryDocument,
  generateNodeProfileDocument,
  generateClusterStatusDocument,
  generateAllProxmoxDocuments,
  type ProxmoxDocument,
} from "../../tools/proxmox/readonly/vector-document-generator";
import { pceLogger } from "../utils/logger";
import type { GraphNode, GraphRelationship } from "../kg/schema/ontology";
import { NodeType, RelationshipType } from "../kg/schema/ontology";
import { Neo4jGraphStore } from "../kg/indexation/neo4j-client";
import {
  ParserRegistry,
  ProxmoxNodeParser,
  ProxmoxVmParser,
  ProxmoxStorageParser,
} from "../../parsers";
import { TwinUpdateService } from "../../twin";
import { PromptSuggestionService } from "../api/prompt-suggestion-service";
import { TwinQueryService } from "../../twin/api/twin-query-service";
import type { ExecutionContext } from "../../types/execution";

export interface ProxmoxIngestionOptions {
  aclGroup: ACLGroup;
  redact: boolean;
  reindex: boolean;
  ttl?: number; // TTL in seconds for short-lived documents (optional)
}

export interface ProxmoxIngestionResult {
  vectorIngestion: {
    documentsProcessed: number;
    chunksIndexed: number;
  };
  graphIngestion: {
    nodesWritten: number;
    relationshipsWritten: number;
  };
  provenance: {
    provenanceIds: string[];
    versionHashes: string[];
  };
}

/**
 * Compute version hash (SHA-256) of normalized entity payload
 * TL-2A.6.1: Helper function for integrity tracking
 */
export function computeVersionHash(payload: Record<string, any>): string {
  // Normalize payload: sort keys, remove undefined/null values, stringify
  const normalized: Record<string, any> = {};
  const sortedKeys = Object.keys(payload).sort();
  
  for (const key of sortedKeys) {
    const value = payload[key];
    if (value !== undefined && value !== null) {
      // Recursively normalize nested objects
      if (typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
        normalized[key] = Object.keys(value)
          .sort()
          .reduce((acc: any, k: string) => {
            if (value[k] !== undefined && value[k] !== null) {
              acc[k] = value[k];
            }
            return acc;
          }, {});
      } else {
        normalized[key] = value;
      }
    }
  }
  
  const jsonString = JSON.stringify(normalized);
  return createHash("sha256").update(jsonString).digest("hex");
}

/**
 * Proxmox Ingestion Orchestrator
 * TL-2A.6.1: Orchestrates data fetch using provenance-recording client wrappers
 */
export class ProxmoxIngestionOrchestrator {
  private vectorPipeline: IngestionPipeline;
  private graphPipeline: GraphIngestionPipeline;
  private graphStore: Neo4jGraphStore;
  private proxmoxClient: ProxmoxClient;
  private tempDir: string;
  private parserRegistry: ParserRegistry;
  private nodeParser: ProxmoxNodeParser;
  private vmParser: ProxmoxVmParser;
  private storageParser: ProxmoxStorageParser;
  private twinUpdater: TwinUpdateService;
  private proxmoxTool: ProxmoxReadOnlyTool;

  constructor(
    vectorPipeline: IngestionPipeline,
    graphPipeline: GraphIngestionPipeline,
    graphStore: Neo4jGraphStore,
    proxmoxConfig: ProxmoxApiConfig
  ) {
    this.vectorPipeline = vectorPipeline;
    this.graphPipeline = graphPipeline;
    this.graphStore = graphStore;
    this.proxmoxClient = new ProxmoxClient(proxmoxConfig);
    this.tempDir = join(tmpdir(), "pce-proxmox-ingestion");
    this.parserRegistry = new ParserRegistry();
    this.nodeParser = new ProxmoxNodeParser();
    this.vmParser = new ProxmoxVmParser();
    this.storageParser = new ProxmoxStorageParser();
    this.parserRegistry.register(this.nodeParser);
    this.parserRegistry.register(this.vmParser);
    this.parserRegistry.register(this.storageParser);
    this.twinUpdater = new TwinUpdateService(this.graphStore);
    this.proxmoxTool = new ProxmoxReadOnlyTool();
  }

  /**
   * Ensure temp directory exists
   */
  private async ensureTempDir(): Promise<void> {
    await fs.mkdir(this.tempDir, { recursive: true });
  }

  /**
   * Write document to temp file
   */
  private async writeTempFile(document: ProxmoxDocument, index: number): Promise<string> {
    await this.ensureTempDir();
    const filename = `proxmox-${document.metadata.documentType}-${index}-${Date.now()}.txt`;
    const filePath = join(this.tempDir, filename);
    await fs.writeFile(filePath, document.content, "utf-8");
    return filePath;
  }

  /**
   * Clean up temp files
   */
  private async cleanupTempFiles(filePaths: string[]): Promise<void> {
    for (const filePath of filePaths) {
      try {
        await fs.unlink(filePath);
      } catch (error: any) {
        pceLogger.warn(`Failed to delete temp file: ${filePath}`, { error: error.message });
      }
    }
  }

  /**
   * TL-2A.6.A.4 & TL-2A.6.A.5: Ingest Proxmox inventory into Vector Store
   */
  async ingestProxmoxInventoryVector(
    documents: ProxmoxDocument[],
    options: ProxmoxIngestionOptions
  ): Promise<{ documentsProcessed: number; chunksIndexed: number; provenanceIds: string[] }> {
    const tempFiles: string[] = [];
    let totalChunks = 0;
    const provenanceIds: string[] = [];

    try {
      // Write documents to temp files
      for (let i = 0; i < documents.length; i++) {
        const filePath = await this.writeTempFile(documents[i], i);
        tempFiles.push(filePath);
      }

      // Ingest each document via vector pipeline
      const ingestionOptions: IngestionOptions = {
        documentType: "proxmox_inventory",
        aclGroup: options.aclGroup,
        redact: options.redact,
        reindex: options.reindex,
      };

      for (const filePath of tempFiles) {
        try {
          const result = await this.vectorPipeline.ingestFile(filePath, ingestionOptions);
          totalChunks += result.chunksIndexed;
          pceLogger.info(`Ingested vector document: ${filePath}`, { chunksIndexed: result.chunksIndexed });
        } catch (error: any) {
          pceLogger.error(`Failed to ingest vector document: ${filePath}`, { error: error.message });
        }
      }

      return {
        documentsProcessed: documents.length,
        chunksIndexed: totalChunks,
        provenanceIds, // TODO: Extract from document metadata if available
      };
    } finally {
      // Clean up temp files
      await this.cleanupTempFiles(tempFiles);
    }
  }

  /**
   * TL-2A.6.B.6: Ingest Proxmox inventory into Knowledge Graph
   * Creates nodes (ProxmoxNode, ProxmoxVM) and relationships (HOSTS_ON/RUNS_ON)
   */
  async upsertProxmoxInventoryToGraph(
    documents: ProxmoxDocument[],
    options: ProxmoxIngestionOptions
  ): Promise<{ nodesWritten: number; relationshipsWritten: number; versionHashes: string[] }> {
    const nodes: GraphNode[] = [];
    const relationships: GraphRelationship[] = [];
    const versionHashes: string[] = [];

    // Extract structured data from documents
    for (const doc of documents) {
      const versionHash = computeVersionHash({
        content: doc.content,
        metadata: doc.metadata,
      });
      versionHashes.push(versionHash);

      if (doc.metadata.documentType === "node_profile" && doc.metadata.node) {
        // Create PVE_NODE
        const nodeId = `pve_node:${doc.metadata.node}`;
        const nodePayload = this.parseNodeProfile(doc.content, doc.metadata.node);
        const nodeVersionHash = computeVersionHash(nodePayload);

        nodes.push({
          id: nodeId,
          type: NodeType.PVE_NODE,
          attributes: {
            ...nodePayload,
            // Ensure temperature is included if present
            temperature: nodePayload.temperature,
          },
          versionHash: nodeVersionHash,
          sourcePath: `proxmox://node/${doc.metadata.node}`,
          aclGroup: options.aclGroup,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      } else if (doc.metadata.documentType === "vm_inventory" && doc.metadata.node) {
        // Parse VM inventory and create VM_INSTANCE nodes and RUNS_ON relationships
        const vmData = this.parseVmInventory(doc.content, doc.metadata.node);
        
        for (const vm of vmData) {
          const vmId = `vm_instance:${vm.vmid}`;
          const vmPayload = {
            vmid: vm.vmid,
            name: vm.name,
            node: doc.metadata.node,
            type: vm.type,
            status: vm.status,
            cpu: vm.cpu,
            memory: vm.memory,
            maxmem: vm.maxmem,
            uptime: vm.uptime,
          };
          const vmVersionHash = computeVersionHash(vmPayload);

          nodes.push({
            id: vmId,
            type: NodeType.VM_INSTANCE,
            attributes: vmPayload,
            versionHash: vmVersionHash,
            sourcePath: `proxmox://vm/${vm.vmid}`,
            aclGroup: options.aclGroup,
            createdAt: new Date(),
            updatedAt: new Date(),
          });

          // Create HOSTS_ON relationship: VM -> Node (VM is hosted on Node)
          const nodeId = `pve_node:${doc.metadata.node}`;
          relationships.push({
            from: vmId,
            to: nodeId,
            type: RelationshipType.HOSTS_ON,
            versionHash: computeVersionHash({ vm: vmId, node: nodeId }),
            sourcePath: `proxmox://vm/${vm.vmid}`,
            aclGroup: options.aclGroup,
            createdAt: new Date(),
          });
        }
      }
    }

    // Write nodes and relationships to graph
    if (nodes.length > 0) {
      await this.graphStore.writeNodes(nodes);
      pceLogger.info(`Wrote ${nodes.length} nodes to graph`);
    }

    if (relationships.length > 0) {
      await this.graphStore.writeRelationships(relationships);
      pceLogger.info(`Wrote ${relationships.length} relationships to graph`);
    }

    return {
      nodesWritten: nodes.length,
      relationshipsWritten: relationships.length,
      versionHashes,
    };
  }

  /**
   * Parse node profile document content
   */
  private parseNodeProfile(content: string, nodeName: string): any {
    const lines = content.split("\n");
    const profile: any = { node: nodeName };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith("- Status:")) {
        profile.status = line.replace("- Status:", "").trim();
      } else if (line.startsWith("- CPU Usage:")) {
        const cpuStr = line.replace("- CPU Usage:", "").trim().replace("%", "");
        profile.cpu = parseFloat(cpuStr) / 100;
      } else if (line.startsWith("- Cores:")) {
        profile.maxcpu = parseInt(line.replace("- Cores:", "").trim()) || undefined;
      } else if (line.includes("Memory") && i + 1 < lines.length) {
        // Parse memory from next lines
        const memLine = lines[i + 1];
        if (memLine.includes("Total:")) {
          const totalStr = memLine.split("Total:")[1].trim();
          // Extract number and unit
          const match = totalStr.match(/([\d.]+)\s*(\w+)/);
          if (match) {
            const value = parseFloat(match[1]);
            const unit = match[2].toLowerCase();
            profile.maxmem = unit === "gb" ? value * 1024 * 1024 * 1024 : value * 1024 * 1024;
          }
        }
      } else if (line.startsWith("## Temperature")) {
        // Parse temperature section
        const tempReadings: any[] = [];
        let maxTemp: number | undefined;
        let avgTemp: number | undefined;
        
        // Look ahead for temperature data
        for (let j = i + 1; j < lines.length && !lines[j].trim().startsWith("##"); j++) {
          const tempLine = lines[j].trim();
          if (tempLine.startsWith("- Maximum:")) {
            const match = tempLine.match(/([\d.]+)°C/);
            if (match) {
              maxTemp = parseFloat(match[1]);
            }
          } else if (tempLine.startsWith("- Average:")) {
            const match = tempLine.match(/([\d.]+)°C/);
            if (match) {
              avgTemp = parseFloat(match[1]);
            }
          } else if (tempLine.includes(":") && tempLine.includes("°C")) {
            // Individual sensor reading: "- label: 45.0°C (max: 80.0°C)"
            const sensorMatch = tempLine.match(/^-\s*([^:]+):\s*([\d.]+)°C/);
            if (sensorMatch) {
              const label = sensorMatch[1].trim();
              const value = parseFloat(sensorMatch[2]);
              const maxMatch = tempLine.match(/max:\s*([\d.]+)°C/);
              const critMatch = tempLine.match(/crit:\s*([\d.]+)°C/);
              tempReadings.push({
                sensor: label,
                value,
                max: maxMatch ? parseFloat(maxMatch[1]) : undefined,
                crit: critMatch ? parseFloat(critMatch[1]) : undefined,
              });
            }
          }
        }
        
        if (maxTemp !== undefined || tempReadings.length > 0) {
          profile.temperature = {
            max: maxTemp,
            average: avgTemp,
            sensors: tempReadings.length > 0 ? tempReadings : undefined,
          };
        }
      }
    }

    return profile;
  }

  /**
   * Parse VM inventory document content
   */
  private parseVmInventory(content: string, nodeName: string): Array<{
    vmid: number;
    name?: string;
    type?: "qemu" | "lxc";
    status?: string;
    cpu?: number;
    memory?: number;
    maxmem?: number;
    uptime?: number;
  }> {
    const vms: Array<{
      vmid: number;
      name?: string;
      type?: "qemu" | "lxc";
      status?: string;
      cpu?: number;
      memory?: number;
      maxmem?: number;
      uptime?: number;
    }> = [];

    const lines = content.split("\n");
    let currentVm: any = null;

    for (const line of lines) {
      if (line.startsWith("## VM ")) {
        // Save previous VM
        if (currentVm && currentVm.vmid) {
          vms.push(currentVm);
        }
        // Start new VM
        const match = line.match(/VM (\d+):\s*(.+)/);
        if (match) {
          currentVm = {
            vmid: parseInt(match[1]),
            name: match[2] !== "Unnamed" ? match[2] : undefined,
            node: nodeName,
          };
        }
      } else if (currentVm) {
        if (line.startsWith("- Status:")) {
          currentVm.status = line.replace("- Status:", "").trim();
        } else if (line.startsWith("- Type:")) {
          const type = line.replace("- Type:", "").trim().toLowerCase();
          currentVm.type = type === "lxc" ? "lxc" : "qemu";
        } else if (line.startsWith("- CPU Usage:")) {
          const cpuStr = line.replace("- CPU Usage:", "").trim().replace("%", "");
          currentVm.cpu = parseFloat(cpuStr) / 100;
        } else if (line.startsWith("- Memory:")) {
          // Parse memory: "X MB / Y MB" or "X GB / Y GB"
          const memStr = line.replace("- Memory:", "").trim();
          const match = memStr.match(/([\d.]+)\s*(\w+)\s*\/\s*([\d.]+)\s*(\w+)/);
          if (match) {
            const usedValue = parseFloat(match[1]);
            const usedUnit = match[2].toLowerCase();
            const maxValue = parseFloat(match[3]);
            const maxUnit = match[4].toLowerCase();
            
            currentVm.memory = usedUnit === "gb" ? usedValue * 1024 * 1024 * 1024 : usedValue * 1024 * 1024;
            currentVm.maxmem = maxUnit === "gb" ? maxValue * 1024 * 1024 * 1024 : maxValue * 1024 * 1024;
          }
        }
      }
    }

    // Save last VM
    if (currentVm && currentVm.vmid) {
      vms.push(currentVm);
    }

    return vms;
  }

  /**
   * Ensure graph store is connected
   */
  async ensureGraphStoreConnected(): Promise<void> {
    // Check if driver exists, if not connect
    try {
      this.graphStore.getDriver();
      // Driver exists, already connected
    } catch (error: any) {
      // Driver doesn't exist, need to connect
      await this.graphStore.connect();
    }
  }

  private createToolContext(action: string): ExecutionContext {
    return {
      toolName: `proxmox_ingestion:${action}`,
      startedAt: Date.now(),
    };
  }

  private async fetchNodeInventory(): Promise<Record<string, any>> {
    const result = await this.proxmoxTool.execute(
      { action: "list_nodes" },
      this.createToolContext("list_nodes")
    );

    if (result.error) {
      throw new Error(`Failed to list nodes: ${result.error}`);
    }

    return result.data || { nodes: [] };
  }

  private async fetchVmInventory(nodeNames: string[]): Promise<{ vms: any[] }> {
    const vms: any[] = [];

    await Promise.all(
      nodeNames.map(async (node) => {
        const [qemu, lxc] = await Promise.all([
          this.proxmoxTool.execute(
            { action: "list_vms", node, type: "qemu" },
            this.createToolContext(`list_vms:${node}:qemu`)
          ),
          this.proxmoxTool.execute(
            { action: "list_vms", node, type: "lxc" },
            this.createToolContext(`list_vms:${node}:lxc`)
          ),
        ]);

        const results = [qemu, lxc];
        for (const result of results) {
          if (result.error) {
            pceLogger.warn("Failed to fetch VM inventory for node", {
              node,
              error: result.error,
            });
            continue;
          }
          const vmList = result.data?.vms ?? [];
          vmList.forEach((vm: any) => {
            if (!vm.node) {
              vm.node = node;
            }
            vms.push(vm);
          });
        }
      })
    );

    return { vms };
  }

  private async fetchStorageInventory(nodeNames: string[]): Promise<Array<{ node: string; storage: any[] }>> {
    const storageData: Array<{ node: string; storage: any[] }> = [];

    await Promise.all(
      nodeNames.map(async (node) => {
        try {
          const result = await this.proxmoxTool.execute(
            { action: "node_storage", node },
            this.createToolContext(`node_storage:${node}`)
          );

          if (result.error) {
            pceLogger.warn("Failed to fetch storage inventory for node", {
              node,
              error: result.error,
            });
            return;
          }

          const storageList = result.data?.storage ?? [];
          if (storageList.length > 0) {
            storageData.push({ node, storage: storageList });
          }
        } catch (error: any) {
          pceLogger.warn("Error fetching storage for node", {
            node,
            error: error.message,
          });
        }
      })
    );

    return storageData;
  }

  private async ingestTwinInventory(): Promise<void> {
    const collectedAt = new Date();
    const nodeData = await this.fetchNodeInventory();
    const nodeResult = await this.nodeParser.parse(nodeData, {
      source: "proxmox_readonly.list_nodes",
      collectedAt,
    });

    // Fetch temperature data for each node and add to entities
    const nodeNames = (nodeData.nodes || [])
      .map((node: any) => node?.node)
      .filter((name: string | undefined): name is string => Boolean(name));
    
    // Import temperature fetcher
    const { fetchNodeTemperature, getSummaryTemperature } = await import("../../tools/proxmox/readonly/temperature-fetcher");
    
    // Fetch temperature for each node and merge into entities
    pceLogger.info("Fetching temperature data for nodes during twin ingestion", {
      nodeCount: nodeResult.entities.filter(e => e.type === "compute_node").length,
    });
    
    for (const entity of nodeResult.entities) {
      if (entity.type === "compute_node" && entity.displayName) {
        try {
          pceLogger.debug(`Fetching temperature for node: ${entity.displayName}`);
          const tempData = await fetchNodeTemperature(entity.displayName);
          if (tempData && tempData.temperatures.length > 0) {
            const summary = getSummaryTemperature(tempData);
            (entity.data as any).temperature = {
              max: summary?.max,
              average: summary?.avg,
              sensors: tempData.temperatures.length,
              readings: tempData.temperatures.map((t) => ({
                sensor: t.sensor,
                label: t.label || t.sensor.split("/").pop(),
                value: t.value,
                unit: t.unit,
                max: t.max,
                crit: t.crit,
              })),
            };
            pceLogger.info(`Successfully fetched temperature for ${entity.displayName}`, {
              max: summary?.max,
              sensors: tempData.temperatures.length,
            });
          } else {
            pceLogger.debug(`No temperature data available for ${entity.displayName}`);
          }
        } catch (error: any) {
          pceLogger.warn(`Failed to fetch temperature for ${entity.displayName} during twin ingestion`, {
            error: error.message,
          });
          // Continue without temperature data
        }
      }
    }

    const vmData = await this.fetchVmInventory(nodeNames);
    const vmResult = await this.vmParser.parse(vmData, {
      source: "proxmox_readonly.list_vms",
      collectedAt,
    });

    // Fetch and parse storage for each node
    const storageDataList = await this.fetchStorageInventory(nodeNames);
    const storageResults = await Promise.all(
      storageDataList.map((storageData) =>
        this.storageParser.parse(storageData, {
          source: "proxmox_readonly.node_storage",
          collectedAt,
        })
      )
    );

    const entities = [
      ...nodeResult.entities,
      ...vmResult.entities,
      ...storageResults.flatMap((r) => r.entities),
    ];
    const relationships = [
      ...nodeResult.relationships,
      ...vmResult.relationships,
      ...storageResults.flatMap((r) => r.relationships),
    ];

    if (!entities.length && !relationships.length) {
      pceLogger.warn("Twin ingestion skipped (no entities or relationships)");
      return;
    }

    await this.twinUpdater.initialize();
    await this.twinUpdater.upsert(entities, relationships);
    pceLogger.info("Twin ingestion complete", {
      entities: entities.length,
      relationships: relationships.length,
      storageEntities: storageResults.reduce((sum, r) => sum + r.entities.length, 0),
    });
  }

  private async refreshPromptSuggestions(): Promise<void> {
    if (process.env.PCE_PROMPT_SUGGESTIONS_ENABLED === "false") {
      return;
    }
    const maxSuggestions = Number(process.env.PCE_PROMPT_SUGGESTIONS_LIMIT || "6");
    const suggestionService = new PromptSuggestionService({
      twinQuery: new TwinQueryService(this.graphStore),
      maxSuggestions: Number.isFinite(maxSuggestions) ? Math.max(1, maxSuggestions) : 6,
    });
    const result = await suggestionService.generateAndStore();
    pceLogger.info("Prompt suggestions updated", {
      suggestions: result.suggestions.length,
    });
  }

  /**
   * Main ingestion method: Fetch data, generate documents, ingest to both stores
   * TL-2A.6.1: All fetching uses ProxmoxClient for provenance tracking
   */
  async ingestProxmoxInventory(
    options: ProxmoxIngestionOptions
  ): Promise<ProxmoxIngestionResult> {
    try {
      pceLogger.info("Starting Proxmox inventory ingestion");

      // Ensure graph store is connected
      await this.ensureGraphStoreConnected();

      // Step 1: Fetch data using ProxmoxClient (ensures provenance tracking)
      // Note: generateAllProxmoxDocuments uses ProxmoxReadOnlyTool which uses ProxmoxClient
      const documents = await generateAllProxmoxDocuments(this.proxmoxClient);
      pceLogger.info(`Generated ${documents.length} Proxmox documents`);

      // Step 2: Ingest to Vector Store
      const vectorResult = await this.ingestProxmoxInventoryVector(documents, options);

      // Step 3: Ingest to Graph Store
      const graphResult = await this.upsertProxmoxInventoryToGraph(documents, options);

      // Step 3b: Update digital twin
      try {
        await this.ingestTwinInventory();
        try {
          await this.refreshPromptSuggestions();
        } catch (error: any) {
          pceLogger.warn("Prompt suggestions refresh failed", { error: error.message });
        }
      } catch (error: any) {
        pceLogger.warn("Twin ingestion failed", { error: error.message });
      }

      // Step 4: Also ingest via graph pipeline for EDL processing (optional, for text-based extraction)
      const tempFiles: string[] = [];
      try {
        for (let i = 0; i < documents.length; i++) {
          const filePath = await this.writeTempFile(documents[i], i);
          tempFiles.push(filePath);
        }

        const graphIngestionOptions: GraphIngestionOptions = {
          documentType: "proxmox_inventory",
          aclGroup: options.aclGroup,
          redact: options.redact,
          reindex: options.reindex,
        };

        for (const filePath of tempFiles) {
          try {
            await this.graphPipeline.ingestFile(filePath, graphIngestionOptions);
          } catch (error: any) {
            pceLogger.warn(`Graph pipeline ingestion failed for ${filePath}`, { error: error.message });
          }
        }
      } finally {
        await this.cleanupTempFiles(tempFiles);
      }

      pceLogger.info("Proxmox inventory ingestion complete", {
        vectorChunks: vectorResult.chunksIndexed,
        graphNodes: graphResult.nodesWritten,
        graphRelationships: graphResult.relationshipsWritten,
      });

      return {
        vectorIngestion: {
          documentsProcessed: vectorResult.documentsProcessed,
          chunksIndexed: vectorResult.chunksIndexed,
        },
        graphIngestion: {
          nodesWritten: graphResult.nodesWritten,
          relationshipsWritten: graphResult.relationshipsWritten,
        },
        provenance: {
          provenanceIds: vectorResult.provenanceIds,
          versionHashes: graphResult.versionHashes,
        },
      };
    } catch (error: any) {
      pceLogger.error("Proxmox inventory ingestion failed", { error: error.message });
      throw error;
    }
  }
}

