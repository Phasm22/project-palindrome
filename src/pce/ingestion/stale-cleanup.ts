import {
  StaleNodeCleaner,
  type StaleCleanupOptions,
  type StaleCleanupResult,
} from "../../twin/cleanup/stale-node-cleaner";

export interface IngestionCleanupResult {
  deleted: number;
  results: StaleCleanupResult[];
}

type StaleCleanupRunner = Pick<StaleNodeCleaner, "cleanAll">;

export async function runIngestionStaleCleanup(
  options: StaleCleanupOptions = { maxAgeMinutes: 10 },
  cleaner?: StaleCleanupRunner
): Promise<IngestionCleanupResult> {
  const activeCleaner =
    cleaner || new StaleNodeCleaner(undefined, options);
  const results = await activeCleaner.cleanAll(options);
  return {
    deleted: results.reduce((sum, result) => sum + result.deleted, 0),
    results,
  };
}
