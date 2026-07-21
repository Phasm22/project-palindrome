import { TwinUpdateService } from "../../twin";
import { TwinEntityType } from "../../twin/models/entities";
import { ProxmoxInterfaceParser, type ProxmoxInterfaceParserInput } from "../../parsers/network/proxmox-interface-parser";
import { OpnsenseInterfaceParser, type OpnsenseInterfaceParserInput } from "../../parsers/network/opnsense-interface-parser";
import { ProxmoxReadOnlyTool } from "../../tools/proxmox/readonly/proxmox-readonly-tool";
import { MCPOpnsenseTool } from "../../tools/MCPOpnsenseTool";
import type { ExecutionContext } from "../../types/execution";
import { pceLogger } from "../utils/logger";

export interface NetworkIngestionOptions {
  includeProxmox?: boolean;
  includeOpnsense?: boolean;
}

export interface NetworkIngestionResult {
  entitiesWritten: number;
  relationshipsWritten: number;
  // True when at least one node's Proxmox interface fetch failed this cycle
  // (or the fetch overall failed/is disabled) — the source's snapshot is
  // incomplete, so stale-interface pruning for it was skipped this cycle
  // rather than risk deleting real data that simply didn't refresh.
  proxmoxDegraded: boolean;
  opnsenseDegraded: boolean;
}

export class NetworkIngestionOrchestrator {
  private proxmoxTool = new ProxmoxReadOnlyTool();
  private opnsenseTool = new MCPOpnsenseTool();
  private proxmoxParser = new ProxmoxInterfaceParser();
  private opnsenseParser = new OpnsenseInterfaceParser();
  private twinUpdater = new TwinUpdateService();

  async ingestNetwork(options: NetworkIngestionOptions = {}): Promise<NetworkIngestionResult> {
    const includeProxmox = options.includeProxmox !== false;
    const includeOpnsense = options.includeOpnsense !== false;
    const collectedAt = new Date();

    const entities = [];
    const relationships = [];
    const interfaceIdsBySource = new Map<string, Set<string>>();
    let proxmoxDegraded = false;
    let opnsenseDegraded = false;

    if (includeProxmox) {
      try {
        const proxInput = await this.fetchProxmoxInterfaces();
        const result = await this.proxmoxParser.parse(proxInput, {
          source: "proxmox",
          collectedAt,
        });
        entities.push(...result.entities);
        relationships.push(...result.relationships);
        if (proxInput.hadPartialFailure) {
          // Incomplete view of this source this cycle — including it in the
          // prune snapshot would delete real interfaces that simply didn't
          // get re-fetched, not ones that are actually gone. Still upsert
          // what DID succeed so those interfaces' collectedAt refreshes.
          proxmoxDegraded = true;
          pceLogger.warn(
            "Proxmox interface ingestion had partial node failures this cycle; skipping stale-interface pruning for the proxmox source"
          );
        } else {
          this.captureInterfaceSnapshot(interfaceIdsBySource, "proxmox", result.entities);
        }
      } catch (error: any) {
        proxmoxDegraded = true;
        pceLogger.warn(`Proxmox interface ingestion failed: ${error.message}`);
      }
    }

    if (includeOpnsense) {
      try {
        const opnInput = await this.fetchOpnsenseInterfaces();
        if (opnInput.interfaces.length) {
          const result = await this.opnsenseParser.parse(opnInput, {
            source: "opnsense",
            collectedAt,
          });
          entities.push(...result.entities);
          relationships.push(...result.relationships);
          this.captureInterfaceSnapshot(interfaceIdsBySource, "opnsense", result.entities);
        }
      } catch (error: any) {
        opnsenseDegraded = true;
        pceLogger.warn(`OPNsense interface ingestion failed: ${error.message}`);
      }
    }

    if (!entities.length) {
      pceLogger.warn("No network entities discovered; twin not updated.");
      return { entitiesWritten: 0, relationshipsWritten: 0, proxmoxDegraded, opnsenseDegraded };
    }

    await this.twinUpdater.initialize();
    await this.pruneStaleInterfaceEntities(interfaceIdsBySource);
    await this.twinUpdater.upsert(entities, relationships);

    pceLogger.info("Network ingestion complete", {
      entities: entities.length,
      relationships: relationships.length,
    });

    if (includeOpnsense && typeof (this.opnsenseTool as any)?.close === "function") {
      (this.opnsenseTool as any).close();
    }

    return {
      entitiesWritten: entities.length,
      relationshipsWritten: relationships.length,
      proxmoxDegraded,
      opnsenseDegraded,
    };
  }

  private createContext(toolName: string): ExecutionContext {
    return { toolName, startedAt: Date.now() };
  }

  private async fetchProxmoxInterfaces(): Promise<
    ProxmoxInterfaceParserInput & { hadPartialFailure: boolean }
  > {
    const listNodes = await this.proxmoxTool.execute(
      { action: "list_nodes" },
      this.createContext("network_ingest")
    );
    const nodes = listNodes.data?.nodes ?? [];
    const nodeEntries: ProxmoxInterfaceParserInput["nodes"] = [];
    const vmConfigs: ProxmoxInterfaceParserInput["vms"] = [];
    let hadPartialFailure = false;

    for (const node of nodes) {
      const nodeName = node.node || node.name;
      if (!nodeName) continue;

      // Isolated per node: one node's failure must not discard interfaces
      // already fetched from other, healthy nodes this cycle.
      try {
        const networkResult = await this.proxmoxTool.execute(
          { action: "node_network_interfaces", node: nodeName },
          this.createContext("network_ingest")
        );
        let interfaces =
          networkResult.data?.interfaces ??
          networkResult.data?.result ??
          networkResult.data ??
          [];
        if (!Array.isArray(interfaces) && interfaces && typeof interfaces === "object") {
          interfaces = Object.values(interfaces);
        }
        nodeEntries.push({ node: nodeName, interfaces });

        const vmList = await this.proxmoxTool.execute(
          { action: "list_vms", node: nodeName },
          this.createContext("network_ingest")
        );
        const vms = vmList.data?.vms ?? [];

        for (const vm of vms) {
          if (vm?.node && vm.node.toLowerCase() !== nodeName.toLowerCase()) {
            pceLogger.warn(`Skipping VM ${vm.vmid} from mismatched node listing`, {
              expectedNode: nodeName,
              reportedNode: vm.node,
              name: vm.name,
            });
            continue;
          }
          if (typeof vm.vmid !== "number") continue;
          const vmType = vm.type === "qemu" || vm.type === "lxc" ? vm.type : undefined;
          const configRes = await this.proxmoxTool.execute(
            { action: "get_vm_config", node: nodeName, vmid: vm.vmid, ...(vmType ? { type: vmType } : {}) },
            this.createContext("network_ingest")
          );
          const config = configRes.data ?? {};
          const netEntries: Record<string, string> = {};
          for (const [key, value] of Object.entries(config)) {
            if (key.startsWith("net") && typeof value === "string") {
              netEntries[key] = value;
            }
          }

          // Fetch guest agent network interfaces only for QEMU VMs (LXC has no guest agent endpoint)
          let guestInterfaces: any[] | undefined;
          if (vmType === "qemu" && vm.status === "running") {
            try {
              const agentRes = await this.proxmoxTool.execute(
                { action: "get_vm_guest_network", node: nodeName, vmid: vm.vmid, type: "qemu" },
                this.createContext("network_ingest")
              );
              if (agentRes.data?.interfaces && Array.isArray(agentRes.data.interfaces)) {
                guestInterfaces = agentRes.data.interfaces;
              }
            } catch (error: any) {
              // Guest agent not available or not running - this is expected for many VMs
              pceLogger.debug(`Guest agent network unavailable for VM ${vm.vmid}: ${error.message}`);
            }
          }

          if (Object.keys(netEntries).length > 0 || guestInterfaces) {
            vmConfigs.push({
              vmid: vm.vmid,
              node: nodeName,
              name: vm.name,
              net: netEntries,
              guestInterfaces,
            });
          }
        }
      } catch (error: any) {
        hadPartialFailure = true;
        pceLogger.warn(`Skipping node ${nodeName} this ingestion cycle: ${error.message}`, {
          node: nodeName,
        });
        continue;
      }
    }

    return { nodes: nodeEntries, vms: vmConfigs, hadPartialFailure };
  }

  private async fetchOpnsenseInterfaces(): Promise<OpnsenseInterfaceParserInput> {
    const hostname = process.env.OPNSENSE_HOSTNAME || "opnsense";
    const interfacesRes = await this.opnsenseTool.execute(
      { module: "interfaces", action: "listInterfaces" },
      this.createContext("network_ingest")
    );
    if (interfacesRes.error) {
      throw new Error(interfacesRes.error);
    }
    let interfaces = interfacesRes.data?.interfaces ?? interfacesRes.data?.items ?? interfacesRes.data ?? [];
    if (!Array.isArray(interfaces) && interfaces && typeof interfaces === "object") {
      interfaces = Object.values(interfaces);
    }

    let vlans: any[] = [];
    try {
      const vlanRes = await this.opnsenseTool.execute(
        { module: "interfaces", action: "listVlan" },
        this.createContext("network_ingest")
      );
      if (!vlanRes.error) {
        vlans = vlanRes.data?.vlans ?? vlanRes.data ?? [];
      }
    } catch (error: any) {
      pceLogger.warn(`Failed to load OPNsense VLANs: ${error.message}`);
    }

    return {
      hostname,
      interfaces,
      vlans,
    };
  }

  private captureInterfaceSnapshot(
    interfaceIdsBySource: Map<string, Set<string>>,
    source: string,
    parsedEntities: Array<{ id: string; type: string }>
  ): void {
    const interfaceIds = parsedEntities
      .filter((entity) => entity.type === TwinEntityType.NETWORK_INTERFACE)
      .map((entity) => entity.id)
      .filter((id) => Boolean(id));

    if (!interfaceIds.length) {
      pceLogger.warn("Skipping stale-interface prune for source; no interfaces discovered", {
        source,
      });
      return;
    }

    interfaceIdsBySource.set(source, new Set(interfaceIds));
  }

  private async pruneStaleInterfaceEntities(
    interfaceIdsBySource: Map<string, Set<string>>
  ): Promise<void> {
    for (const [source, interfaceIds] of interfaceIdsBySource.entries()) {
      const deleted = await this.twinUpdater.pruneEntitiesByTypeAndSource(
        TwinEntityType.NETWORK_INTERFACE,
        source,
        Array.from(interfaceIds)
      );

      if (deleted > 0) {
        pceLogger.info("Pruned stale network interfaces", {
          source,
          deleted,
        });
      }
    }
  }

  async dispose(): Promise<void> {
    (this.opnsenseTool as any)?.close?.();
    // Close Neo4j connection
    if (this.twinUpdater) {
      await this.twinUpdater.close();
    }
  }
}
