import { expect, test } from "bun:test";
import { runIngestionStaleCleanup } from "../../../src/pce/ingestion/stale-cleanup";

test("runIngestionStaleCleanup aggregates one shared cleaner run", async () => {
  const calls: unknown[] = [];
  const cleaner = {
    cleanAll: async (options: unknown) => {
      calls.push(options);
      return [
        { entityType: "switch", deleted: 2, errors: 0, details: [] },
        { entityType: "switch_port", deleted: 3, errors: 0, details: [] },
      ];
    },
  };

  const result = await runIngestionStaleCleanup(
    { maxAgeMinutes: 15 },
    cleaner
  );

  expect(calls).toEqual([{ maxAgeMinutes: 15 }]);
  expect(result.deleted).toBe(5);
  expect(result.results).toHaveLength(2);
});
