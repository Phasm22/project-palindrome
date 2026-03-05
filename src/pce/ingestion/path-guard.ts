/**
 * Path guard for file-based ingestion.
 * Rejects paths under known test/scratch directories unless explicitly allowed.
 */

import path from "node:path";

/**
 * Returns true if the given file path lies under a blocked test/scratch directory
 * (aligned with .gitignore: .pce*, .gold-path, .provenance-audit).
 */
export function isTestOrScratchPath(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  const segments = resolved.split(path.sep);
  for (const segment of segments) {
    if (segment === ".pce" || segment === ".gold-path" || segment === ".provenance-audit") {
      return true;
    }
    if (segment.startsWith(".pce-")) {
      return true;
    }
  }
  return false;
}
