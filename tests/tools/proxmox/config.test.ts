import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getPrimaryProxmoxConfig,
  getProxmoxEndpointConfigs,
  resolveCredentialsForUrl,
} from "../../../src/tools/proxmox/config";

describe("Proxmox credential pairing", () => {
  const originalEnv = { ...process.env };
  const proxmoxKeys = [
    "PROXMOX_URL",
    "PROXBIG_URL",
    "PROXMOX_TOKEN_ID",
    "PROXMOX_TOKEN_SECRET",
    "PROXMOX_API_TOKEN_ID",
    "PROXMOX_API_TOKEN_SECRET",
    "CLUSTER_TF_TOKEN_ID",
    "PROXMOX_CLUSTER_TF_SECRET",
    "PROXBIG_TOKEN_ID",
    "PROXBIG_TOKEN_SECRET",
    "PROXBIG_TF_TOKEN_ID",
    "PROXBIG_TF_SECRET",
    "PROXMOX_PROXBIG_TF_TOKEN_ID",
    "PROXMOX_PROXBIG_TF_SECRET",
    "PROXMOX_YIN_URL",
    "PROXMOX_YANG_URL",
    "YIN_TOKEN_ID",
    "YIN_TOKEN_SECRET",
    "YANG_TOKEN_ID",
    "YANG_TOKEN_SECRET",
    "PROXMOX_YIN_TF_TOKEN_ID",
    "PROXMOX_YIN_TF_SECRET",
    "PROXMOX_YANG_TF_TOKEN_ID",
    "PROXMOX_YANG_TF_SECRET",
  ];

  function clearProxmoxEnv() {
    for (const key of proxmoxKeys) {
      delete process.env[key];
    }
  }

  beforeEach(() => {
    process.env = { ...originalEnv };
    clearProxmoxEnv();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("resolves proxBig credentials as a matched pair without mixing secret families", () => {
    process.env.PROXBIG_TF_TOKEN_ID = "llm@pve!llm-agent";
    process.env.PROXBIG_TF_SECRET = "tf-secret";
    process.env.PROXBIG_TOKEN_SECRET = "legacy-secret";
    process.env.PROXMOX_TOKEN_ID = "palindrome-agent@pve!pce-token";

    const resolved = resolveCredentialsForUrl("https://proxbig.prox:8006");
    expect(resolved).not.toBeNull();
    expect(resolved?.tokenId).toBe("llm@pve!llm-agent");
    expect(resolved?.tokenSecret).toBe("tf-secret");
    expect(resolved?.source).toBe("PROXBIG_TF_TOKEN_ID+PROXBIG_TF_SECRET");
  });

  it("prefers cluster token pair for cluster endpoints before unrelated generic pairs", () => {
    process.env.PROXMOX_TOKEN_ID = "palindrome-agent@pve!pce-token";
    process.env.PROXMOX_TOKEN_SECRET = "pal-secret";
    process.env.CLUSTER_TF_TOKEN_ID = "llm@pve!llm-agent";
    process.env.PROXMOX_CLUSTER_TF_SECRET = "cluster-secret";

    const resolved = resolveCredentialsForUrl("https://yin.prox:8006/api2/json");
    expect(resolved).not.toBeNull();
    expect(resolved?.tokenId).toBe("llm@pve!llm-agent");
    expect(resolved?.tokenSecret).toBe("cluster-secret");
    expect(resolved?.source).toBe("CLUSTER_TF_TOKEN_ID+PROXMOX_CLUSTER_TF_SECRET");
  });

  it("builds proxBig endpoint config with deterministic credential source", () => {
    process.env.PROXMOX_URL = "https://proxBig.prox:8006/api2/json";
    process.env.PROXBIG_TF_TOKEN_ID = "llm@pve!llm-agent";
    process.env.PROXBIG_TF_SECRET = "tf-secret";
    process.env.PROXBIG_TOKEN_SECRET = "legacy-secret";

    const configs = getProxmoxEndpointConfigs();
    const proxBig = configs.find((cfg) => cfg.label === "proxbig");
    expect(proxBig).toBeDefined();
    expect(proxBig?.tokenId).toBe("llm@pve!llm-agent");
    expect(proxBig?.tokenSecret).toBe("tf-secret");
    expect(proxBig?.credentialSource).toBe("PROXBIG_TF_TOKEN_ID+PROXBIG_TF_SECRET");
  });

  it("resolves primary config from PROXMOX_URL with a complete pair", () => {
    process.env.PROXMOX_URL = "https://proxBig.prox:8006/api2/json";
    process.env.PROXMOX_TOKEN_ID = "palindrome-agent@pve!pce-token";
    process.env.PROXBIG_TOKEN_SECRET = "proxbig-secret";

    const primary = getPrimaryProxmoxConfig();
    expect(primary).not.toBeNull();
    expect(primary?.tokenId).toBe("palindrome-agent@pve!pce-token");
    expect(primary?.tokenSecret).toBe("proxbig-secret");
    expect(primary?.credentialSource).toBe("PROXMOX_TOKEN_ID+PROXBIG_TOKEN_SECRET");
  });
});
