import { BaseTool } from "../../BaseTool";
import type { ExecutionResult, ExecutionContext } from "../../../types/execution";
import { pceLogger as logger } from "../../../pce/utils/logger";
import { ProxmoxClient, ProxmoxApiConfig } from "../client";
import { sanitizeToolPayload } from "../../../agent/tool-sanitizer";
import crypto from "crypto";

/**
 * Base class for Proxmox write tools
 * Provides common functionality: API client, authentication, sanitization, provenance tracking,
 * dry-run support, and pre-write state capture
 */
export abstract class ProxmoxWriteBase extends BaseTool {
  protected apiClient: ProxmoxClient | null = null;

  /**
   * Get API configuration from environment variables
   */
  protected getApiConfig(): ProxmoxApiConfig {
    const url = process.env.PROXMOX_URL;
    const tokenId = process.env.PROXMOX_TOKEN_ID;
    // Support node-specific token secrets (e.g., PROXBIG_TOKEN_SECRET) as fallback
    // Extract node name from URL if possible, or use default
    let tokenSecret = process.env.PROXMOX_TOKEN_SECRET;
    
    // Try to find node-specific token secret based on URL hostname
    if (url) {
      try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname.toLowerCase();
        // Check for node-specific secrets (e.g., proxbig -> PROXBIG_TOKEN_SECRET)
        const nodeName = hostname.split('.')[0].toUpperCase();
        const nodeSpecificSecret = process.env[`${nodeName}_TOKEN_SECRET`];
        if (nodeSpecificSecret) {
          tokenSecret = nodeSpecificSecret;
        }
      } catch {
        // If URL parsing fails, use default
      }
    }
    
    const verifySsl = process.env.PROXMOX_VERIFY_SSL !== "false";

    // Check after trying to find node-specific secret
    if (!url || !tokenId || !tokenSecret) {
      const nodeHint = url ? ` (or ${new URL(url).hostname.split('.')[0].toUpperCase()}_TOKEN_SECRET for node-specific secret)` : '';
      throw new Error(
        `PROXMOX_URL, PROXMOX_TOKEN_ID, and PROXMOX_TOKEN_SECRET${nodeHint} must be set`
      );
    }

    return { url, tokenId, tokenSecret, verifySsl };
  }

  /**
   * Get or create Proxmox API client instance
   */
  protected getApiClient(): ProxmoxClient {
    if (this.apiClient) {
      return this.apiClient;
    }

    const config = this.getApiConfig();
    this.apiClient = new ProxmoxClient(config);
    return this.apiClient;
  }

  /**
   * Capture pre-write state for provenance
   * This must be called BEFORE executing any write operation
   */
  protected async capturePreWriteState(
    client: ProxmoxClient,
    node: string,
    vmid: number,
    type: string = "qemu"
  ): Promise<{ snapshot: any; hash: string }> {
    try {
      const vmType = type === "lxc" ? "lxc" : "qemu";
      // Get current VM config/status before write
      const statusResult = await client.get(`/nodes/${node}/${vmType}/${vmid}/status/current`);
      const configResult = await client.get(`/nodes/${node}/${vmType}/${vmid}/config`);

      const preWriteState = {
        timestamp: new Date().toISOString(),
        node,
        vmid,
        status: statusResult.data.data,
        config: configResult.data.data,
      };

      // Generate unique hash for this snapshot
      const stateJson = JSON.stringify(preWriteState);
      const hash = crypto.createHash("sha256").update(stateJson).digest("hex");

      logger.info("Pre-write state captured", {
        node,
        vmid,
        hash: hash.substring(0, 8),
      });

      return {
        snapshot: preWriteState,
        hash: `proxmox-pre-write-${hash.substring(0, 16)}`,
      };
    } catch (error: any) {
      logger.warn("Failed to capture pre-write state", {
        node,
        vmid,
        error: error.message,
      });
      // Return empty snapshot if capture fails (don't block write)
      return {
        snapshot: { timestamp: new Date().toISOString(), node, vmid, error: "capture_failed" },
        hash: `proxmox-pre-write-${Date.now()}`,
      };
    }
  }

  /**
   * Execute API call and sanitize response
   * Wraps the API call with error handling and sanitization
   * Includes provenance metadata from the Proxmox client
   */
  protected async executeApiCall<T>(
    apiCall: () => Promise<{ data: T; metadata: any }>,
    context: ExecutionContext
  ): Promise<ExecutionResult> {
    try {
      const result = await apiCall();

      // Sanitize output before returning
      const sanitizedData = sanitizeToolPayload(result.data);

      // Include provenance metadata in the response
      const responseData = {
        ...(typeof sanitizedData === "object" && sanitizedData !== null
          ? sanitizedData
          : { value: sanitizedData }),
        _provenance: {
          provenanceId: result.metadata.provenanceId,
          timestamp: result.metadata.timestamp,
          durationMs: result.metadata.durationMs,
        },
      };

      return {
        data: responseData,
        metadata: result.metadata,
      };
    } catch (error: any) {
      logger.error("Proxmox API call failed", {
        tool: this.metadata.name,
        error: error.message,
      });

      return {
        error: `Proxmox API error: ${error.message}`,
      };
    }
  }

  /**
   * Generate diff preview for dry-run mode
   * Shows what would change without executing the operation
   */
  protected generateDiffPreview(
    action: string,
    currentState: any,
    proposedChanges: any
  ): any {
    return {
      action,
      dryRun: true,
      currentState: sanitizeToolPayload(currentState),
      proposedChanges: sanitizeToolPayload(proposedChanges),
      summary: `Would execute ${action} with the following changes`,
      timestamp: new Date().toISOString(),
    };
  }
}

