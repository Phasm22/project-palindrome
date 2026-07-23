import { BaseTool } from "../../BaseTool";
import type { ExecutionResult, ExecutionContext } from "../../../types/execution";
import { logger } from "../../../utils/logger";
import { getPiholeClient, type PiholeClient } from "../client";
import { sanitizeToolPayload } from "../../../agent/tool-sanitizer";

/**
 * Base class for Pi-hole read-only tools.
 * Simpler than OpnsenseReadOnlyBase/ProxmoxReadOnlyBase because PiholeClient
 * already owns session auth/CSRF handling internally (see client.ts) — this
 * base only needs the shared write-guard and error-sanitizing wrapper.
 */
export abstract class PiholeReadOnlyBase extends BaseTool {
  protected getClient(): PiholeClient {
    return getPiholeClient();
  }

  /**
   * Check if an action is a write operation.
   * Write operations are forbidden in read-only tools.
   */
  protected isWriteOperation(action: string): boolean {
    const writePatterns = [
      /^(add|create|set|update|delete|remove|apply|save|install|uninstall)/i,
      /_(add|create|set|update|delete|remove|apply|save|install|uninstall)$/i,
    ];

    return writePatterns.some((pattern) => pattern.test(action));
  }

  /**
   * Validate that operation is read-only.
   */
  protected validateReadOnly(action: string): ExecutionResult | null {
    if (this.isWriteOperation(action)) {
      return {
        error: "OPERATION_FORBIDDEN: Write operations are not allowed in read-only tools",
      };
    }
    return null;
  }

  /**
   * Execute an API call and sanitize the response (or error).
   */
  protected async executeApiCall<T>(
    apiCall: () => Promise<T>,
    context: ExecutionContext
  ): Promise<ExecutionResult> {
    try {
      const rawData = await apiCall();
      return { data: sanitizeToolPayload(rawData) };
    } catch (error: any) {
      const sanitizedLogDetails = sanitizeToolPayload({
        tool: this.metadata.name,
        error: error.message,
        stack: error.stack,
      });
      logger.error("Pi-hole API call failed", sanitizedLogDetails);

      const errorMessage = error.message || "Unknown error";
      const sanitizedError =
        typeof errorMessage === "string"
          ? sanitizeToolPayload(errorMessage)
          : sanitizeToolPayload(JSON.stringify(errorMessage));

      return { error: `Pi-hole API error: ${sanitizedError}` };
    }
  }
}
