import { BaseTool } from "../../BaseTool";
import type { ExecutionResult, ExecutionContext } from "../../../types/execution";
import { pceLogger as logger } from "../../../pce/utils/logger";
import { ProxmoxClient, ProxmoxApiConfig } from "../client";
import { sanitizeToolPayload } from "../../../agent/tool-sanitizer";

/**
 * Base class for Proxmox read-only tools
 * Provides common functionality: API client, authentication, sanitization, provenance tracking
 */
export abstract class ProxmoxReadOnlyBase extends BaseTool {
  protected apiClient: ProxmoxClient | null = null;

  /**
   * Get API configuration from environment variables
   */
  protected getApiConfig(): ProxmoxApiConfig {
    const url = process.env.PROXMOX_URL;
    const tokenId = process.env.PROXMOX_TOKEN_ID;
    const tokenSecret = process.env.PROXMOX_TOKEN_SECRET;
    const verifySsl = process.env.PROXMOX_VERIFY_SSL !== "false";

    if (!url || !tokenId || !tokenSecret) {
      throw new Error(
        "PROXMOX_URL, PROXMOX_TOKEN_ID, and PROXMOX_TOKEN_SECRET must be set"
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
   * Check if an action is a write operation
   * Write operations are forbidden in read-only tools
   */
  protected isWriteOperation(action: string): boolean {
    const writePatterns = [
      /^(add|create|set|update|delete|remove|apply|save|install|uninstall|start|stop|shutdown|reboot|migrate|clone|resize)/i,
      /_(add|create|set|update|delete|remove|apply|save|install|uninstall|start|stop|shutdown|reboot|migrate|clone|resize)$/i,
    ];

    return writePatterns.some((pattern) => pattern.test(action));
  }

  /**
   * Validate that an action is read-only
   * Returns an error result if the action is a write operation
   */
  protected validateReadOnly(action: string): ExecutionResult | null {
    if (this.isWriteOperation(action)) {
      logger.warn("Write operation attempted in read-only tool", {
        tool: this.metadata.name,
        action,
      });
      return {
        error: `OPERATION_FORBIDDEN: Action '${action}' is a write operation and is not allowed in read-only tools.`,
      };
    }
    return null;
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
      // The provenance ID from the client is tracked in the metadata
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
        durationMs: result.metadata.durationMs,
      };
    } catch (error: any) {
      logger.error("Proxmox API call failed", {
        tool: this.metadata.name,
        error: error.message,
        status: error.response?.status,
        endpoint: error.config?.url,
      });

      // Sanitize error messages too
      const errorMessage =
        error.response?.data?.message ||
        error.message ||
        "Unknown error";
      const sanitizedError =
        typeof errorMessage === "string"
          ? sanitizeToolPayload(errorMessage)
          : sanitizeToolPayload(JSON.stringify(errorMessage));

      return {
        error: `Proxmox API error: ${sanitizedError}`,
        durationMs: error.response?.metadata?.durationMs,
      };
    }
  }

  /**
   * Normalize Proxmox API response data
   * This is a placeholder - specific tools will override with their normalization logic
   */
  protected normalizeResponse<T>(data: T): T {
    // Base implementation returns data as-is
    // Subclasses should override for specific normalization
    return data;
  }
}

