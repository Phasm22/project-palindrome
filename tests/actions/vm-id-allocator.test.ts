import { expect, test } from "bun:test";
import { allocateVmId } from "../../src/actions/helpers/vm-id-allocator";

test("allocateVmId excludes IDs reserved by Terraform config", async () => {
  const client = {
    get: async () => ({ data: { data: [] } }),
  } as any;

  const allocation = await allocateVmId(client, {
    startId: 9000,
    endId: 9002,
    reservedIds: [9000, 9001],
  });

  expect(allocation?.vmId).toBe(9002);
});
