/**
 * Shared logic for attributing a twin VM/node to the Proxmox endpoint that's
 * supposed to know about it ("cluster" for yin/yang, "proxbig" for proxBig —
 * see getProxmoxEndpointConfigs), and for deciding whether that endpoint was
 * actually reachable during a given verification/cleanup pass.
 *
 * Extracted from TwinQueryService.verifyVmsAgainstProxmox — a transient
 * failure fetching ONE endpoint must not be treated as "every VM/node that
 * lives there is gone"; it must be treated as "unknown, don't touch it."
 * Every caller that decides whether to delete a stale twin entity based on
 * live Proxmox state should go through this rather than re-deriving it.
 */

const PROXBIG_LABEL = "proxbig";
const CLUSTER_LABEL = "cluster";

/**
 * Which configured Proxmox endpoint is expected to know about a node/VM with
 * this displayName. Returns undefined when the node name itself is unknown
 * (caller should then fall back to "were ALL endpoints checked?").
 */
export function getExpectedEndpointLabel(nodeName?: string): string | undefined {
  if (!nodeName) return undefined;
  return nodeName.toLowerCase() === PROXBIG_LABEL ? PROXBIG_LABEL : CLUSTER_LABEL;
}

/**
 * Whether the endpoint expected to know about this node/VM was successfully
 * queried this run. When the expected endpoint can't be determined, only
 * treat it as verified if every configured endpoint succeeded.
 */
export function wasEndpointVerified(
  expectedEndpoint: string | undefined,
  successfulEndpoints: Set<string>,
  totalConfigCount: number
): boolean {
  return expectedEndpoint
    ? successfulEndpoints.has(expectedEndpoint)
    : successfulEndpoints.size === totalConfigCount;
}
