/**
 * Graph Store Entity Extractor for Proxmox Data
 * TL-2A.6.B: Extract Proxmox entities and relationships for Knowledge Graph ingestion
 * 
 * Models Proxmox as first-class KG entities:
 * - Nodes → PVE_NODE
 * - VMs → VM_INSTANCE
 * - Storage → PVE_STORAGE
 * 
 * Relationships:
 * - VM RUNS_ON Node
 * - VM USES Storage
 * - Node CONNECTS_TO Node (cluster ring)
 * - Storage CONNECTED_TO Node
 */

import { NodeType, RelationshipType } from "../../../pce/kg/schema/ontology";
import type { GraphNode, GraphRelationship } from "../../../pce/kg/schema/ontology";
import { ProxmoxReadOnlyTool } from "./proxmox-readonly-tool";
import type { ACLGroup } from "../../../pce/types";

export interface ProxmoxGraphEntities {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
}

/**
 * Extract Proxmox entities and relationships from cluster data
 */
export async function extractProxmoxGraphEntities(
  aclGroup: ACLGroup = "viewer",
  versionHash?: string,
  sourcePath?: string
): Promise<ProxmoxGraphEntities> {
  const tool = new ProxmoxReadOnlyTool();
  const nodes: GraphNode[] = [];
  const relationships: GraphRelationship[] = [];
  const timestamp = new Date();

  // Get cluster data
  const nodesResult = await tool.execute(
    { action: "list_nodes" },
    { toolName: "proxmox_readonly", startedAt: Date.now() }
  );

  if (nodesResult.error || !nodesResult.data) {
    throw new Error(`Failed to list nodes: ${nodesResult.error}`);
  }

  const clusterNodes = nodesResult.data.nodes || [];

  // Extract PVE_NODE entities
  for (const nodeData of clusterNodes) {
    const nodeId = `pve_node:${nodeData.node}`;
    const node: GraphNode = {
      id: nodeId,
      type: NodeType.PVE_NODE,
      attributes: {
        node: nodeData.node,
        status: nodeData.status_normalized || nodeData.status,
        cpu: nodeData.cpu,
        maxcpu: nodeData.maxcpu,
        memory: nodeData.mem_normalized?.raw || nodeData.mem,
        maxmem: nodeData.maxmem_normalized?.raw || nodeData.maxmem,
        uptime: nodeData.uptime,
      },
      versionHash,
      sourcePath,
      aclGroup,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    nodes.push(node);
  }

  // Extract cluster ring relationships (Node CONNECTS_TO Node)
  for (let i = 0; i < clusterNodes.length; i++) {
    for (let j = i + 1; j < clusterNodes.length; j++) {
      const node1 = clusterNodes[i].node;
      const node2 = clusterNodes[j].node;
      
      const rel: GraphRelationship = {
        id: `connects:${node1}:${node2}`,
        type: RelationshipType.CONNECTS_TO,
        from: `pve_node:${node1}`,
        to: `pve_node:${node2}`,
        properties: {
          cluster: true,
        },
        versionHash,
        sourcePath,
        aclGroup,
        createdAt: timestamp,
      };
      relationships.push(rel);
    }
  }

  // Extract VM entities and relationships for each node
  for (const nodeData of clusterNodes) {
    const nodeName = nodeData.node;
    if (!nodeName) continue;

    try {
      // Get VMs on this node
      const vmsResult = await tool.execute(
        { action: "list_vms", node: nodeName },
        { toolName: "proxmox_readonly", startedAt: Date.now() }
      );

      if (vmsResult.error || !vmsResult.data) {
        console.warn(`Failed to list VMs for node ${nodeName}: ${vmsResult.error}`);
        continue;
      }

      const vms = vmsResult.data.vms || [];

      for (const vmData of vms) {
        const vmId = `vm_instance:${vmData.vmid}`;
        
        // Create VM_INSTANCE node
        const vm: GraphNode = {
          id: vmId,
          type: NodeType.VM_INSTANCE,
          attributes: {
            vmid: vmData.vmid,
            name: vmData.name,
            node: nodeName,
            type: vmData.type || "qemu",
            status: vmData.status_normalized || vmData.status,
            cpu: vmData.cpu,
            memory: vmData.mem_normalized?.raw || vmData.mem,
            maxmem: vmData.maxmem_normalized?.raw || vmData.maxmem,
            uptime: vmData.uptime,
          },
          versionHash,
          sourcePath,
          aclGroup,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        nodes.push(vm);

        // Create VM RUNS_ON Node relationship
        const runsOnRel: GraphRelationship = {
          id: `runs_on:${vmData.vmid}:${nodeName}`,
          type: RelationshipType.RUNS_ON,
          from: vmId,
          to: `pve_node:${nodeName}`,
          properties: {
            type: vmData.type || "qemu",
          },
          versionHash,
          sourcePath,
          aclGroup,
          createdAt: timestamp,
        };
        relationships.push(runsOnRel);
      }
    } catch (error: any) {
      console.warn(`Error processing node ${nodeName}: ${error.message}`);
    }
  }

  // Extract storage entities and relationships
  // Note: Storage extraction requires additional API calls per node
  // For now, we'll extract basic storage info if available
  for (const nodeData of clusterNodes) {
    const nodeName = nodeData.node;
    if (!nodeName) continue;

    try {
      // Get node disks (which can indicate storage)
      const disksResult = await tool.execute(
        { action: "node_disks", node: nodeName },
        { toolName: "proxmox_readonly", startedAt: Date.now() }
      );

      if (disksResult.error || !disksResult.data) {
        continue;
      }

      const disks = disksResult.data.disks || [];
      
      // Create storage entities for each disk
      for (const disk of disks) {
        const storageId = `pve_storage:${nodeName}:${disk.devpath || disk.type}`;
        
        // Check if storage node already exists
        if (!nodes.find((n) => n.id === storageId)) {
          const storage: GraphNode = {
            id: storageId,
            type: NodeType.PVE_STORAGE,
            attributes: {
              storage: disk.devpath || disk.type || "unknown",
              type: disk.type,
              nodes: [nodeName],
            },
            versionHash,
            sourcePath,
            aclGroup,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          nodes.push(storage);
        }

        // Create Storage CONNECTED_TO Node relationship
        const connectedRel: GraphRelationship = {
          id: `connected:${storageId}:${nodeName}`,
          type: RelationshipType.CONNECTED_TO,
          from: storageId,
          to: `pve_node:${nodeName}`,
          properties: {
            devpath: disk.devpath,
            type: disk.type,
          },
          versionHash,
          sourcePath,
          aclGroup,
          createdAt: timestamp,
        };
        relationships.push(connectedRel);
      }
    } catch (error: any) {
      // Storage extraction is optional, continue on error
      console.warn(`Error extracting storage for node ${nodeName}: ${error.message}`);
    }
  }

  // Extract VM USES Storage relationships
  // This would require VM config data to see which storage each VM uses
  // For now, we'll create a simplified version based on node storage
  // In a full implementation, you'd parse VM config to find storage references

  return { nodes, relationships };
}

/**
 * Normalize entity ID for consistent graph IDs
 */
export function normalizeProxmoxEntityId(type: NodeType, identifier: string): string {
  const normalized = identifier.toLowerCase().replace(/[^a-z0-9]/g, "-");
  return `${type.toLowerCase()}:${normalized}`;
}

