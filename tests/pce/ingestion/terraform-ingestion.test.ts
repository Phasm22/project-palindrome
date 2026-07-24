import { describe, expect, it, vi } from "vitest";
import {
  ComputeNodeEntitySchema,
  ComputeVmEntitySchema,
  TwinEntityType,
  type ComputeVmEntity,
} from "../../../src/twin/models/entities";
import {
  TerraformIngestionOrchestrator,
  type TerraformTwinWriter,
  type TerraformVmConfigReader,
} from "../../../src/pce/ingestion/terraform-ingestion";

class FakeTwinGraphStore implements TerraformTwinWriter {
  readonly entities = new Map<string, ComputeVmEntity>();
  readonly upsertCalls: ComputeVmEntity[][] = [];
  closed = false;

  constructor(seed: ComputeVmEntity[] = []) {
    for (const entity of seed) {
      this.entities.set(entity.id, entity);
    }
  }

  async upsert(entities: ComputeVmEntity[], _relationships: []): Promise<void> {
    this.upsertCalls.push(entities);
    for (const entity of entities) {
      this.entities.set(entity.id, entity);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

describe("TerraformIngestionOrchestrator", () => {
  it("writes declared VMs with provenance-suffixed ids and leaves observed VMs untouched", async () => {
    const observed = ComputeVmEntitySchema.parse({
      id: "compute-vm:yin:210",
      type: TwinEntityType.COMPUTE_VM,
      displayName: "app-server",
      source: "proxmox",
      collectedAt: new Date("2026-07-23T12:00:00Z"),
      data: {
        provenance: "observed",
        nodeId: "compute-node:yin",
        state: "running",
        ipAddresses: ["172.16.0.210"],
        cpuCores: 2,
        memoryBytes: 2 * 1024 * 1024 * 1024,
        vmKind: "qemu",
      },
    });
    const graphStore = new FakeTwinGraphStore([observed]);
    const readVmConfigs: TerraformVmConfigReader = vi.fn(async () => [
      {
        environment: "palindrome",
        sourcePath: "/repo/lab-infra/environments/palindrome.tfvars",
        vmConfigs: {
          "app-server": {
            target_node: "yin",
            cores: 4,
            memory: 4096,
            disk_size: "32G",
            vm_id: 210,
          },
        },
      },
    ]);

    const orchestrator = new TerraformIngestionOrchestrator(
      readVmConfigs,
      graphStore
    );
    const result = await orchestrator.ingestTerraform({
      environmentsDir: "/repo/lab-infra/environments",
    });

    expect(readVmConfigs).toHaveBeenCalledWith(
      "/repo/lab-infra/environments"
    );
    expect(result).toEqual({ entitiesWritten: 1, environmentsRead: 1 });

    const declared = graphStore.entities.get(
      "compute-vm:yin:210:declared"
    );
    expect(declared).toMatchObject({
      id: "compute-vm:yin:210:declared",
      type: TwinEntityType.COMPUTE_VM,
      displayName: "app-server (declared)",
      source: "terraform:palindrome.tfvars",
      data: {
        provenance: "declared",
        nodeId: "compute-node:yin",
        ipAddresses: [],
        cpuCores: 4,
        memoryBytes: 4 * 1024 * 1024 * 1024,
        vmKind: "qemu",
      },
    });

    expect(declared?.id).not.toBe(observed.id);
    expect(graphStore.entities.get(observed.id)).toBe(observed);
    expect(graphStore.upsertCalls[0]?.map((entity) => entity.id)).toEqual([
      "compute-vm:yin:210:declared",
    ]);
  });

  it("uses the declared VM name when Terraform auto-assigns the VM id", async () => {
    const graphStore = new FakeTwinGraphStore();
    const readVmConfigs: TerraformVmConfigReader = vi.fn(async () => [
      {
        environment: "lab",
        sourcePath: "/repo/lab-infra/environments/lab.tfvars",
        vmConfigs: {
          "Ops Box": {
            target_node: "YANG",
            cores: 2,
            memory: 2048,
            disk_size: "16G",
          },
        },
      },
    ]);

    const orchestrator = new TerraformIngestionOrchestrator(
      readVmConfigs,
      graphStore
    );
    await orchestrator.ingestTerraform();

    expect(
      graphStore.entities.has("compute-vm:yang:ops-box:declared")
    ).toBe(true);
  });
});

describe("compute entity provenance schemas", () => {
  it("accept declared/observed provenance while remaining backward compatible", () => {
    expect(
      ComputeNodeEntitySchema.parse({
        id: "compute-node:yin",
        type: TwinEntityType.COMPUTE_NODE,
        displayName: "yin",
        data: {
          provenance: "observed",
          roles: [],
          ipAddresses: [],
        },
      }).data.provenance
    ).toBe("observed");

    expect(
      ComputeVmEntitySchema.parse({
        id: "compute-vm:yin:210:declared",
        type: TwinEntityType.COMPUTE_VM,
        displayName: "app-server (declared)",
        data: {
          provenance: "declared",
          nodeId: "compute-node:yin",
          ipAddresses: [],
        },
      }).data.provenance
    ).toBe("declared");

    expect(
      ComputeVmEntitySchema.parse({
        id: "compute-vm:yin:210",
        type: TwinEntityType.COMPUTE_VM,
        displayName: "app-server",
        data: {
          nodeId: "compute-node:yin",
          ipAddresses: [],
        },
      }).data.provenance
    ).toBeUndefined();
  });
});
