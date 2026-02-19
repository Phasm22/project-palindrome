import { TwinUpdateService } from "../../twin/state/twin-updater";
import { TwinQueryService } from "../../twin/api/twin-query-service";
import type { TwinEntity } from "../../twin/models/entities";
import { TwinEntityType } from "../../twin/models/entities";
import { TwinRelationshipType, type TwinRelationship } from "../../twin/models/relationships";
import type { TerraformOutput } from "./terraform-runner";
import { pceLogger as logger } from "../../pce/utils/logger";
import { normalizeVmId, normalizeNodeId } from "../../parsers/compute/helpers";

/**
 * Sync terraform state/outputs to the digital twin
 */
export class TwinSync {
  private twinUpdater: TwinUpdateService;
  private twinQuery: TwinQueryService;

  constructor() {
    this.twinUpdater = new TwinUpdateService();
    this.twinQuery = new TwinQueryService();
  }

  /**
   * Sync VM information from terraform outputs to twin
   */
  async syncTerraformVms(outputs: TerraformOutput): Promise<{
    entities: number;
    relationships: number;
  }> {
    if (!outputs.vm_info) {
      logger.warn("No VM info in terraform outputs");
      return { entities: 0, relationships: 0 };
    }

    const entities: TwinEntity[] = [];
    const relationships: TwinRelationship[] = [];
    const collectedAt = new Date();

    for (const [vmName, vmInfo] of Object.entries(outputs.vm_info)) {
      // Parse VM ID from terraform output
      // Format: "proxBig/qemu/101" or just the number
      let vmId: string;
      if (typeof vmInfo.id === "number") {
        vmId = normalizeVmId(vmInfo.node, vmInfo.id);
      } else {
        // Assume it's already in the right format
        vmId = String(vmInfo.id);
      }

      const nodeId = normalizeNodeId(vmInfo.node);

      // Create ComputeVM entity
      const vmEntity: TwinEntity = {
        id: vmId,
        type: TwinEntityType.COMPUTE_VM,
        displayName: vmName,
        source: "terraform",
        collectedAt,
        data: {
          nodeId,
          state: "running", // Assume running if terraform created it
          ipAddresses: Array.isArray(vmInfo.ip_addresses)
            ? vmInfo.ip_addresses
            : vmInfo.ip_addresses
            ? [vmInfo.ip_addresses]
            : [],
          agentAvailable: true, // Cloud-init template includes guest agent
          vmKind: "qemu", // Terraform creates QEMU VMs
        },
      };

      entities.push(vmEntity);

      // Create RUNS_ON relationship
      const relationship: TwinRelationship = {
        fromId: vmId,
        toId: nodeId,
        type: TwinRelationshipType.RUNS_ON,
        metadata: { source: "terraform" },
        collectedAt,
      };

      relationships.push(relationship);
    }

    if (entities.length === 0) {
      logger.warn("No entities to sync");
      return { entities: 0, relationships: 0 };
    }

    // Upsert to twin
    await this.twinUpdater.initialize();
    await this.twinUpdater.upsert(entities, relationships);

    logger.info("Synced terraform VMs to twin", {
      entities: entities.length,
      relationships: relationships.length,
    });

    return {
      entities: entities.length,
      relationships: relationships.length,
    };
  }

  /**
   * Remove VM from twin (after terraform destroy)
   */
  async removeVm(vmId: string): Promise<void> {
    // Note: TwinUpdateService doesn't have a delete method yet
    // For now, we'll mark it as deleted or let it be cleaned up by next ingestion
    logger.info("VM removed from terraform, will be cleaned up by next ingestion", { vmId });
  }
}
