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
  credentialSource?: string;
}

export interface ProxmoxCredentialSelection {
  tokenId: string;
  tokenSecret: string;
  source: string;
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

function env(name: string): string | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getNodeNameFromUrl(url: string): string | undefined {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const nodeSegment = hostname.split(".")[0];
    const sanitized = nodeSegment?.replace(/[^a-z0-9_-]/g, "");
    return sanitized ? sanitized.toUpperCase() : undefined;
  } catch {
    return undefined;
  }
}

interface CredentialCandidate {
  tokenId?: string;
  tokenSecret?: string;
  source: string;
}

function addCandidate(
  candidates: CredentialCandidate[],
  tokenIdVar: string,
  tokenSecretVar: string
): void {
  candidates.push({
    tokenId: env(tokenIdVar),
    tokenSecret: env(tokenSecretVar),
    source: `${tokenIdVar}+${tokenSecretVar}`,
  });
}

function selectCredentials(
  candidates: CredentialCandidate[]
): ProxmoxCredentialSelection | null {
  for (const candidate of candidates) {
    if (candidate.tokenId && candidate.tokenSecret) {
      return {
        tokenId: candidate.tokenId,
        tokenSecret: candidate.tokenSecret,
        source: candidate.source,
      };
    }
  }
  return null;
}

function resolveClusterCredentials(clusterUrl: string): ProxmoxCredentialSelection | null {
  const nodeName = getNodeNameFromUrl(clusterUrl);
  const candidates: CredentialCandidate[] = [];

  if (nodeName) {
    addCandidate(candidates, `PROXMOX_${nodeName}_TOKEN_ID`, `PROXMOX_${nodeName}_TOKEN_SECRET`);
    addCandidate(candidates, `${nodeName}_TOKEN_ID`, `${nodeName}_TOKEN_SECRET`);
    addCandidate(candidates, `PROXMOX_${nodeName}_TF_TOKEN_ID`, `PROXMOX_${nodeName}_TF_SECRET`);

    const nodeSecretVars = [
      `${nodeName}_TOKEN_SECRET`,
      `PROXMOX_${nodeName}_TF_SECRET`,
      `PROXMOX_${nodeName}_TOKEN_SECRET`,
    ];
    for (const nodeSecretVar of nodeSecretVars) {
      addCandidate(candidates, "CLUSTER_TF_TOKEN_ID", nodeSecretVar);
      addCandidate(candidates, "PROXMOX_TOKEN_ID", nodeSecretVar);
      addCandidate(candidates, "PROXMOX_API_TOKEN_ID", nodeSecretVar);
    }
  }

  addCandidate(candidates, "CLUSTER_TF_TOKEN_ID", "PROXMOX_CLUSTER_TF_SECRET");
  addCandidate(candidates, "PROXMOX_TOKEN_ID", "PROXMOX_TOKEN_SECRET");
  addCandidate(candidates, "PROXMOX_API_TOKEN_ID", "PROXMOX_API_TOKEN_SECRET");
  addCandidate(candidates, "PROXMOX_TOKEN_ID", "PROXMOX_CLUSTER_TF_SECRET");
  addCandidate(candidates, "PROXMOX_API_TOKEN_ID", "PROXMOX_CLUSTER_TF_SECRET");

  return selectCredentials(candidates);
}

function resolveProxBigCredentials(): ProxmoxCredentialSelection | null {
  const candidates: CredentialCandidate[] = [];
  addCandidate(candidates, "PROXBIG_TOKEN_ID", "PROXBIG_TOKEN_SECRET");
  addCandidate(candidates, "PROXBIG_TF_TOKEN_ID", "PROXBIG_TF_SECRET");
  addCandidate(candidates, "PROXMOX_PROXBIG_TF_TOKEN_ID", "PROXMOX_PROXBIG_TF_SECRET");
  addCandidate(candidates, "PROXMOX_TOKEN_ID", "PROXBIG_TOKEN_SECRET");
  addCandidate(candidates, "PROXMOX_TOKEN_ID", "PROXBIG_TF_SECRET");
  addCandidate(candidates, "CLUSTER_TF_TOKEN_ID", "PROXBIG_TF_SECRET");
  addCandidate(candidates, "CLUSTER_TF_TOKEN_ID", "PROXMOX_PROXBIG_TF_SECRET");
  addCandidate(candidates, "PROXMOX_TOKEN_ID", "PROXMOX_TOKEN_SECRET");
  addCandidate(candidates, "PROXMOX_API_TOKEN_ID", "PROXMOX_API_TOKEN_SECRET");
  addCandidate(candidates, "CLUSTER_TF_TOKEN_ID", "PROXMOX_CLUSTER_TF_SECRET");
  return selectCredentials(candidates);
}

/**
 * Resolve token credentials for the target URL using deterministic ID/secret pairing.
 * This prevents mismatches like taking an ID from one env family and a secret from another.
 */
export function resolveCredentialsForUrl(url: string): ProxmoxCredentialSelection | null {
  if (isProxBigUrl(url)) {
    return resolveProxBigCredentials();
  }
  return resolveClusterCredentials(url);
}

/**
 * Resolve the primary Proxmox client config using PROXMOX_URL.
 */
export function getPrimaryProxmoxConfig(): ProxmoxEndpointConfig | null {
  const url = env("PROXMOX_URL");
  if (!url) return null;

  const credentials = resolveCredentialsForUrl(url);
  if (!credentials) return null;

  return {
    url,
    tokenId: credentials.tokenId,
    tokenSecret: credentials.tokenSecret,
    verifySsl: env("PROXMOX_VERIFY_SSL") !== "false",
    label: "primary",
    credentialSource: credentials.source,
  };
}

/**
 * Returns all Proxmox endpoint configs: cluster (yin/YANG) and proxBig.
 * Uses same env precedence as ProxmoxReadOnlyBase and server (CLUSTER_TF_*, PROXMOX_*, PROXBIG_*).
 * Dedupes by normalized URL.
 * Important: cluster URL must point at the cluster (yin/yang), not at proxBig. If PROXMOX_URL
 * points at proxBig, we use PROXMOX_YIN_URL or default for cluster so both endpoints are present.
 */
export function getProxmoxEndpointConfigs(): ProxmoxEndpointConfig[] {
  const verifySsl = env("PROXMOX_VERIFY_SSL") !== "false";
  const configs: ProxmoxEndpointConfig[] = [];
  const seenUrls = new Set<string>();

  // --- Cluster (yin + YANG): URL must be cluster, not proxBig ---
  const rawProxmoxUrl = env("PROXMOX_URL");
  const clusterUrl = env("PROXMOX_YIN_URL") ||
    (rawProxmoxUrl && !isProxBigUrl(rawProxmoxUrl) ? rawProxmoxUrl : undefined) ||
    "https://yin.prox:8006";
  const clusterCredentials = resolveClusterCredentials(clusterUrl);

  if (clusterCredentials) {
    const base = normalizeUrl(clusterUrl);
    if (!seenUrls.has(base)) {
      seenUrls.add(base);
      configs.push({
        url: clusterUrl,
        tokenId: clusterCredentials.tokenId,
        tokenSecret: clusterCredentials.tokenSecret,
        verifySsl,
        label: "cluster",
        credentialSource: clusterCredentials.source,
      });
    }
  }

  // --- proxBig: single node, own token ---
  const proxbigUrl = env("PROXBIG_URL") || "https://proxbig.prox:8006";
  const proxbigCredentials = resolveProxBigCredentials();

  if (proxbigCredentials) {
    const base = normalizeUrl(proxbigUrl);
    if (!seenUrls.has(base)) {
      seenUrls.add(base);
      configs.push({
        url: proxbigUrl,
        tokenId: proxbigCredentials.tokenId,
        tokenSecret: proxbigCredentials.tokenSecret,
        verifySsl,
        label: "proxbig",
        credentialSource: proxbigCredentials.source,
      });
    }
  }

  return configs;
}
