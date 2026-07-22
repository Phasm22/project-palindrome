/**
 * Composite query detection: queries that combine multiple dimensions (e.g. node + exposure,
 * subnet + exposure level, nodes + temperature + no agent). These should route to the EXECUTE
 * path so the LLM can coordinate multiple tools instead of a single twin-first chain.
 */

import type { IntentClassification } from "./intent-classifier";

/** Conjunction + second concept: "and their exposure level", "with temperature", etc. */
const COMPOSITE_CONJUNCTION_PATTERNS = [
  /\band\s+(their\s+)?(exposure|temperature|temp|level)\b/i,
  /\bwith\s+(their\s+)?(exposure|temperature|no\s+agent)\b/i,
  /\band\s+(high\s+)?temperature\b/i,
  /\b(which\s+)?nodes\s+have\b.*\b(and|with)\b/i,
];

/** Node/subnet filter presence (narrows scope). */
const NODE_OR_SUBNET_FILTER = [
  /\b(on|in)\s+(yang|yin|proxbig|node)\b/i,
  /\bwhich\s+nodes\b/i,
  /\bin\s+172\.\d+\.\d+\.\d+\/\d+/i,
  /\bsubnet\s+172\.\d+/i,
];

/** Second dimension: exposure or no-agent (combined with a filter = composite). */
const EXPOSURE_OR_AGENT_DIMENSION = [
  /\bexposure\b/i,
  /\bexposed\b/i,
  /\b(and\s+)?their\s+(exposure\s+)?level\b/i,
  /\bno\s+guest\s+agent\b/i,
  /\bwithout\s+agent\b/i,
];

/**
 * Returns true if the query likely combines multiple dimensions and should use the EXECUTE path
 * (LLM coordinates multiple tools) instead of a single twin-first chain.
 */
export function isLikelyCompositeQuery(
  userInput: string,
  classification?: IntentClassification | null
): boolean {
  if (!userInput?.trim()) return false;

  if (classification?.metadata?.composite === true) return true;

  const normalized = userInput.trim();
  const lower = normalized.toLowerCase();

  // Conjunction + second dimension: "list VMs in 172.16.0.0/22 and their exposure level"
  if (COMPOSITE_CONJUNCTION_PATTERNS.some((p) => p.test(normalized))) return true;

  // Node/subnet filter + exposure or no-agent: "VMs on yang exposed to internet", "in 172.16 and their exposure"
  const hasNodeOrSubnetFilter = NODE_OR_SUBNET_FILTER.some((p) => p.test(normalized));
  const hasExposureOrAgentDimension = EXPOSURE_OR_AGENT_DIMENSION.some((p) => p.test(normalized));
  if (hasNodeOrSubnetFilter && hasExposureOrAgentDimension) return true;

  // Subnet + exposure, or "no agent" + "temperature" (multiple dimensions)
  if (lower.includes("subnet") && lower.includes("exposure")) return true;
  if (lower.includes("no ") && lower.includes("agent") && (lower.includes("temperature") || lower.includes(" temp") || lower.includes("nodes"))) return true;

  // DNS + a second dimension (exposure, VM, or node) — e.g. "which client makes
  // the most DNS queries, and is that host exposed to the internet". Needs
  // pihole_readonly plus a compute/exposure tool across steps.
  if (lower.includes("dns") && (lower.includes("expos") || lower.includes("vm") || lower.includes("node"))) return true;

  return false;
}
