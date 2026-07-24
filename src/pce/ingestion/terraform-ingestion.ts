/**
 * Terraform declared-state ingestion.
 *
 * Reads lab-infra/environments/*.tfvars without invoking Terraform and writes
 * declared compute VM records alongside, never over, Proxmox-observed records.
 * The provenance suffix is part of each declared entity id, mirroring switch
 * ingestion's declared/observed identity model.
 *
 * Terraform state-list enrichment is intentionally deferred: vm_configs is the
 * repository's stable declared input and does not require live Terraform state.
 */

import { basename, join } from "path";
import {
  readTerraformVmConfigsFromEnvironmentDirectory,
  type TerraformVmConfigSource,
} from "../../actions/helpers/terraform-runner";
import { TwinUpdateService } from "../../twin";
import {
  TwinEntityType,
  type ComputeVmEntity,
} from "../../twin/models/entities";
import { pceLogger } from "../utils/logger";

export interface TerraformIngestionOptions {
  environmentsDir?: string;
}

export interface TerraformIngestionResult {
  entitiesWritten: number;
  environmentsRead: number;
}

export type TerraformVmConfigReader = (
  environmentsDir: string
) => Promise<TerraformVmConfigSource[]>;

export interface TerraformTwinWriter {
  upsert(entities: ComputeVmEntity[], relationships: []): Promise<void>;
  close(): Promise<void>;
}

function normalizeIdSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export class TerraformIngestionOrchestrator {
  constructor(
    private readonly readVmConfigs: TerraformVmConfigReader =
      readTerraformVmConfigsFromEnvironmentDirectory,
    private readonly twinUpdater: TerraformTwinWriter = new TwinUpdateService()
  ) {}

  async ingestTerraform(
    options: TerraformIngestionOptions = {}
  ): Promise<TerraformIngestionResult> {
    const environmentsDir =
      options.environmentsDir ||
      join(process.cwd(), "lab-infra", "environments");

    let sources: TerraformVmConfigSource[];
    try {
      sources = await this.readVmConfigs(environmentsDir);
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        pceLogger.warn(
          "Terraform ingestion: environments directory not found; no declared VMs written",
          { environmentsDir }
        );
        return { entitiesWritten: 0, environmentsRead: 0 };
      }
      throw error;
    }

    const collectedAt = new Date();
    const entitiesById = new Map<string, ComputeVmEntity>();

    for (const source of sources) {
      for (const [vmName, config] of Object.entries(source.vmConfigs)) {
        const nodeSlug = normalizeIdSegment(config.target_node);
        const vmSlug =
          config.vm_id !== undefined && config.vm_id > 0
            ? String(config.vm_id)
            : normalizeIdSegment(vmName);
        if (!nodeSlug || !vmSlug) {
          pceLogger.warn("Terraform ingestion: skipping VM with unusable identity", {
            environment: source.environment,
            vmName,
            targetNode: config.target_node,
          });
          continue;
        }

        const id = `compute-vm:${nodeSlug}:${vmSlug}:declared`;
        entitiesById.set(id, {
          id,
          type: TwinEntityType.COMPUTE_VM,
          displayName: `${vmName} (declared)`,
          source: `terraform:${basename(source.sourcePath)}`,
          collectedAt,
          data: {
            provenance: "declared",
            nodeId: `compute-node:${nodeSlug}`,
            ipAddresses: [],
            cpuCores: config.cores,
            memoryBytes: config.memory * 1024 * 1024,
            vmKind: "qemu",
          },
        });
      }
    }

    const entities = Array.from(entitiesById.values());
    if (entities.length > 0) {
      await this.twinUpdater.upsert(entities, []);
    }

    pceLogger.info("Terraform declared-state ingestion complete", {
      environments: sources.length,
      entities: entities.length,
    });

    return {
      entitiesWritten: entities.length,
      environmentsRead: sources.length,
    };
  }

  async dispose(): Promise<void> {
    await this.twinUpdater.close();
  }
}
