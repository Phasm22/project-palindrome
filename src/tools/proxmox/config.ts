/**
 * Shared Proxmox endpoint configuration.
 *
 * Setup: one token for the cluster (yin + YANG), one token for proxBig (single node).
 * Env precedence matches ingestion/server: CLUSTER_TF_*, PROXMOX_*, PROXBIG_*.
 */

export interface ProxmoxEndpointConfig {
  url: string;
  tokenId: string;
  tokenSecret: string;
  verifySsl: boolean;
  label: string;
}

function normalizeUrl(url: string): string {
  return url.replace(/\/api2\/json\/?$/, "").replace(/\/$/, "").toLowerCase();
}

/** True if URL hostname is proxBig (standalone), so it must not be used as "cluster" (yin/YANG). */
function isProxBigUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.includes("proxbig");
  } catch {
    return false;
  }
}

/**
 * Returns all Proxmox endpoint configs: cluster (yin/YANG) and proxBig.
 * Uses same env precedence as ProxmoxReadOnlyBase and server (CLUSTER_TF_*, PROXMOX_*, PROXBIG_*).
 * Dedupes by normalized URL.
 * Important: cluster URL must point at the cluster (yin/yang), not at proxBig. If PROXMOX_URL
 * points at proxBig, we use PROXMOX_YIN_URL or default for cluster so both endpoints are present.
 */
export function getProxmoxEndpointConfigs(): ProxmoxEndpointConfig[] {
  const verifySsl = process.env.PROXMOX_VERIFY_SSL !== "false";
  const configs: ProxmoxEndpointConfig[] = [];
  const seenUrls = new Set<string>();

  // --- Cluster (yin + YANG): URL must be cluster, not proxBig ---
  const rawProxmoxUrl = process.env.PROXMOX_URL;
  const clusterUrl =
    process.env.PROXMOX_YIN_URL ||
    (rawProxmoxUrl && !isProxBigUrl(rawProxmoxUrl) ? rawProxmoxUrl : undefined) ||
    "https://yin.prox:8006";
  const clusterTokenId =
    process.env.PROXMOX_TOKEN_ID ||
    process.env.PROXMOX_API_TOKEN_ID ||
    process.env.CLUSTER_TF_TOKEN_ID ||
    process.env.PROXMOX_YIN_TOKEN_ID ||
    process.env.YIN_TOKEN_ID;
  let clusterTokenSecret =
    process.env.PROXMOX_TOKEN_SECRET ||
    process.env.PROXMOX_API_TOKEN_SECRET ||
    process.env.PROXMOX_CLUSTER_TF_SECRET ||
    process.env.YIN_TOKEN_SECRET ||
    process.env.PROXMOX_YIN_TF_SECRET ||
    process.env.PROXMOX_YIN_TOKEN_SECRET;
  // Node-specific from URL hostname (e.g. yin.prox -> YIN_TOKEN_SECRET)
  try {
    const urlObj = new URL(clusterUrl);
    const hostname = urlObj.hostname.toLowerCase();
    const nodeSegment = hostname.split(".")[0];
    const nodeName = nodeSegment ? nodeSegment.toUpperCase() : "";
    const nodeSecret =
      (nodeName
        ? process.env[`${nodeName}_TOKEN_SECRET`] ||
          process.env[`PROXMOX_${nodeName}_TF_SECRET`] ||
          process.env[`PROXMOX_${nodeName}_TOKEN_SECRET`]
        : undefined);
    if (nodeSecret) clusterTokenSecret = nodeSecret;
  } catch {
    // ignore
  }

  if (clusterTokenId && clusterTokenSecret) {
    const base = normalizeUrl(clusterUrl);
    if (!seenUrls.has(base)) {
      seenUrls.add(base);
      configs.push({
        url: clusterUrl,
        tokenId: clusterTokenId,
        tokenSecret: clusterTokenSecret,
        verifySsl,
        label: "cluster",
      });
    }
  }

  // --- proxBig: single node, own token ---
  const proxbigUrl = process.env.PROXBIG_URL || "https://proxbig.prox:8006";
  const proxbigTokenId =
    process.env.PROXBIG_TOKEN_ID ||
    process.env.PROXBIG_TF_TOKEN_ID ||
    process.env.PROXMOX_PROXBIG_TF_TOKEN_ID;
  const proxbigTokenSecret =
    process.env.PROXBIG_TOKEN_SECRET ||
    process.env.PROXBIG_TF_SECRET ||
    process.env.PROXMOX_PROXBIG_TF_SECRET;

  if (proxbigTokenId && proxbigTokenSecret) {
    const base = normalizeUrl(proxbigUrl);
    if (!seenUrls.has(base)) {
      seenUrls.add(base);
      configs.push({
        url: proxbigUrl,
        tokenId: proxbigTokenId,
        tokenSecret: proxbigTokenSecret,
        verifySsl,
        label: "proxbig",
      });
    }
  }

  return configs;
}
