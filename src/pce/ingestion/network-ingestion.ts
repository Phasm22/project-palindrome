import { TwinUpdateService } from "../../twin";
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

export class NetworkIngestionOrchestrator {
  private proxmoxTool = new ProxmoxReadOnlyTool();
  private opnsenseTool = new MCPOpnsenseTool();
  private proxmoxParser = new ProxmoxInterfaceParser();
  private opnsenseParser = new OpnsenseInterfaceParser();
  private twinUpdater = new TwinUpdateService();

  async ingestNetwork(options: NetworkIngestionOptions = {}): Promise<void> {
    const includeProxmox = options.includeProxmox !== false;
    const includeOpnsense = options.includeOpnsense !== false;
    const collectedAt = new Date();

    const entities = [];
    const relationships = [];

    if (includeProxmox) {
      try {
        const proxInput = await this.fetchProxmoxInterfaces();
        const result = await this.proxmoxParser.parse(proxInput, {
          source: "proxmox",
          collectedAt,
        });
        entities.push(...result.entities);
        relationships.push(...result.relationships);
      } catch (error: any) {
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
        }
      } catch (error: any) {
        pceLogger.warn(`OPNsense interface ingestion failed: ${error.message}`);
      }
    }

    if (!entities.length) {
      pceLogger.warn("No network entities discovered; twin not updated.");
      return;
    }

    await this.twinUpdater.initialize();
    await this.twinUpdater.upsert(entities, relationships);

    pceLogger.info("Network ingestion complete", {
      entities: entities.length,
      relationships: relationships.length,
    });

    if (includeOpnsense && typeof (this.opnsenseTool as any)?.close === "function") {
      (this.opnsenseTool as any).close();
    }
  }

  private createContext(toolName: string): ExecutionContext {
    return { toolName, startedAt: Date.now() };
  }

  private async fetchProxmoxInterfaces(): Promise<ProxmoxInterfaceParserInput> {
    const listNodes = await this.proxmoxTool.execute(
      { action: "list_nodes" },
      this.createContext("network_ingest")
    );
    const nodes = listNodes.data?.nodes ?? [];
    const nodeEntries: ProxmoxInterfaceParserInput["nodes"] = [];
    const vmConfigs: ProxmoxInterfaceParserInput["vms"] = [];

    for (const node of nodes) {
      const nodeName = node.node || node.name;
      if (!nodeName) continue;

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
        { action: "list_vms", node: nodeName, type: "qemu" },
        this.createContext("network_ingest")
      );
      const vms = vmList.data?.vms ?? [];

      for (const vm of vms) {
        if (typeof vm.vmid !== "number") continue;
        const configRes = await this.proxmoxTool.execute(
          { action: "get_vm_config", node: nodeName, vmid: vm.vmid },
          this.createContext("network_ingest")
        );
        const config = configRes.data ?? {};
        const netEntries: Record<string, string> = {};
        for (const [key, value] of Object.entries(config)) {
          if (key.startsWith("net") && typeof value === "string") {
            netEntries[key] = value;
          }
        }
        
        // Fetch guest agent network interfaces if available
        let guestInterfaces: any[] | undefined;
        if (vm.status === "running") {
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
    }

    return { nodes: nodeEntries, vms: vmConfigs };
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

  async dispose(): Promise<void> {
    (this.opnsenseTool as any)?.close?.();
    // Close Neo4j connection
    if (this.twinUpdater) {
      await this.twinUpdater.close();
    }
  }
}

