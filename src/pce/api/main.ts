#!/usr/bin/env bun

import { bootstrapPceApiServer } from "./server";
import { pceLogger } from "../utils/logger";

(async () => {
  try {
    const { server } = await bootstrapPceApiServer();
    await server.start();
    pceLogger.info("PCE API server is running", { port: server.getPort() });
  } catch (error: any) {
    pceLogger.error("Failed to start PCE API server", { error: error.message });
    process.exit(1);
  }
})();
