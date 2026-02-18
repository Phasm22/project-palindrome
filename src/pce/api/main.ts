#!/usr/bin/env bun

// Load .env before any other imports so PROXMOX_*, CLUSTER_TF_*, PROXBIG_* are available
// (Bun may auto-load .env; this ensures it when started from other cwd or non-Bun)
import "dotenv/config";

import { bootstrapPceApiServer } from "./server";
import { pceLogger } from "../utils/logger";
import { getProxmoxEndpointConfigs } from "../../tools/proxmox/config";

(async () => {
  try {
    const { server } = await bootstrapPceApiServer();
    await server.start();

    const configs = getProxmoxEndpointConfigs();
    const labels = configs.map((c) => c.label);
    if (configs.length === 0) {
      pceLogger.warn(
        "Proxmox endpoints: none. Set PROXMOX_* (cluster) and/or PROXBIG_* (standalone) so list_nodes/ingestion/create_vm see all nodes."
      );
    } else {
      pceLogger.info("Proxmox endpoints configured", { count: configs.length, labels });
      if (configs.length === 1 && labels[0] === "proxbig") {
        pceLogger.warn(
          "Only proxBig endpoint is configured. To see cluster nodes (yin/YANG), set PROXMOX_URL, PROXMOX_TOKEN_ID, PROXMOX_TOKEN_SECRET (or CLUSTER_TF_*) in .env and restart."
        );
      }
    }

    pceLogger.info("PCE API server is running", { port: server.getPort() });
  } catch (error: any) {
    pceLogger.error("Failed to start PCE API server", { error: error.message });
    process.exit(1);
  }
})();
