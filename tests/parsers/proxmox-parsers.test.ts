import {
  ProxmoxNodeParser,
  ProxmoxStorageParser,
  ProxmoxVmParser,
} from "../../src/parsers";
import type { ParserContext } from "../../src/parsers";

const context: ParserContext = {
  source: "test",
  collectedAt: new Date("2025-01-01T00:00:00Z"),
};

test("ProxmoxNodeParser converts list_nodes output to twin entity", async () => {
  const parser = new ProxmoxNodeParser();
  const result = await parser.parse(
    {
      nodes: [
        {
          node: "proxBig",
          status: "online",
          maxcpu: 32,
          maxmem: 128 * 1024 * 1024 * 1024,
          ip: "172.16.0.10",
        },
      ],
    },
    context
  );

  expect(result.entities).toHaveLength(1);
  const entity = result.entities[0];
  expect(entity.id).toBe("compute-node:proxbig");
  expect(entity.data.cpuTotalCores).toBe(32);
  expect(entity.data.ipAddresses).toContain("172.16.0.10");
});

test("ProxmoxVmParser converts list_vms output to twin entity and relationship", async () => {
  const parser = new ProxmoxVmParser();
  const result = await parser.parse(
    {
      vms: [
        {
          vmid: 101,
          name: "app-server",
          node: "proxBig",
          status: "running",
          maxcpu: 4,
          maxmem: 8 * 1024 * 1024 * 1024,
          ip: "172.16.0.50",
        },
      ],
    },
    context
  );

  expect(result.entities).toHaveLength(1);
  expect(result.relationships).toHaveLength(1);
  const vmEntity = result.entities[0];
  expect(vmEntity.id).toBe("compute-vm:proxbig:101");
  expect(vmEntity.data.nodeId).toBe("compute-node:proxbig");
  const relationship = result.relationships[0];
  expect(relationship.toId).toBe("compute-node:proxbig");
});

test("ProxmoxStorageParser creates ATTACHED_TO relationships", async () => {
  const parser = new ProxmoxStorageParser();
  const result = await parser.parse(
    {
      node: "yin",
      storage: [
        {
          storage: "local-lvm",
          type: "lvmthin",
        },
      ],
    },
    context
  );

  expect(result.entities).toHaveLength(1);
  expect(result.relationships).toHaveLength(1);
  const relationship = result.relationships[0];
  expect(relationship.fromId).toBe("storage:yin:local-lvm");
  expect(relationship.toId).toBe("compute-node:yin");
  expect(relationship.type).toBe("ATTACHED_TO");
});

test("Parsers tolerate missing optional fields", async () => {
  const nodeParser = new ProxmoxNodeParser();
  const nodeResult = await nodeParser.parse(
    {
      nodes: [
        {
          node: "yin",
          status: undefined,
          ip: undefined,
        },
      ],
    },
    context
  );
  expect(nodeResult.entities).toHaveLength(1);
  expect(nodeResult.entities[0].data.status).toBe("unknown");
  expect(nodeResult.entities[0].data.ipAddresses).toEqual([]);

  const vmParser = new ProxmoxVmParser();
  const vmResult = await vmParser.parse(
    {
      vms: [
        {
          vmid: 200,
          node: "yin",
          name: "no-agent",
        },
      ],
    },
    context
  );
  expect(vmResult.entities).toHaveLength(1);
  expect(vmResult.entities[0].data.agentAvailable).toBeUndefined();
});

