import { BaseTool } from "../../BaseTool";
import type { ExecutionResult, ExecutionContext } from "../../../types/execution";
import { logger } from "../../../utils/logger";
import axios from "axios";
import type { AxiosInstance } from "axios";
import https from "https";
import { sanitizeToolPayload } from "../../../agent/tool-sanitizer";

/**
 * Base class for OPNsense read-only tools
 * Provides common functionality: API client, authentication, sanitization
 */
export abstract class OpnsenseReadOnlyBase extends BaseTool {
  protected apiClient: AxiosInstance | null = null;

  /**
   * Get API configuration from environment variables
   */
  protected getApiConfig() {
    const url = (process.env.OPNSENSE_URL || "").trim();
    const key = process.env.OPNSENSE_API_KEY;
    const secret = process.env.OPNSENSE_API_SECRET;
    const verifySsl = process.env.OPNSENSE_VERIFY_SSL !== "false";

    if (!url || !key || !secret) {
      throw new Error("OPNSENSE_URL, OPNSENSE_API_KEY, and OPNSENSE_API_SECRET must be set");
    }

    return { url, key, secret, verifySsl };
  }

  /**
   * Create authenticated axios instance
   */
  protected getApiClient(): AxiosInstance {
    if (this.apiClient) {
      return this.apiClient;
    }

    const { url, key, secret, verifySsl } = this.getApiConfig();
    const httpsAgent = new https.Agent({
      rejectUnauthorized: verifySsl,
    });

    this.apiClient = axios.create({
      baseURL: url,
      httpsAgent,
      auth: {
        username: key,
        password: secret,
      },
      headers: {
        "Content-Type": "application/json",
      },
    });

    return this.apiClient;
  }

  /**
   * Check if an action is a write operation
   * Write operations are forbidden in read-only tools
   */
  protected isWriteOperation(action: string): boolean {
    const writePatterns = [
      /^(add|create|set|update|delete|remove|apply|save|install|uninstall)/i,
      /_(add|create|set|update|delete|remove|apply|save|install|uninstall)$/i,
    ];

    return writePatterns.some(pattern => pattern.test(action));
  }

  /**
   * Execute API call and sanitize response
   */
  protected async executeApiCall<T>(
    apiCall: () => Promise<T>,
    context: ExecutionContext
  ): Promise<ExecutionResult> {
    try {
      const rawData = await apiCall();
      
      // Sanitize output before returning
      const sanitizedData = sanitizeToolPayload(rawData);

      return {
        data: sanitizedData,
      };
    } catch (error: any) {
      const sanitizedLogDetails = sanitizeToolPayload({
        tool: this.metadata.name,
        error: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText,
        url: error.config?.url || error.request?.url,
        method: error.config?.method,
        responseData: error.response?.data,
        stack: error.stack,
      });
      logger.error("OPNsense API call failed", sanitizedLogDetails);

      // Sanitize error messages too
      const errorMessage = error.response?.data?.message || error.message || "Unknown error";
      // Ensure error message is sanitized (handle both string and object cases)
      const sanitizedError = typeof errorMessage === "string" 
        ? sanitizeToolPayload(errorMessage)
        : sanitizeToolPayload(JSON.stringify(errorMessage));

      return {
        error: `OPNsense API error: ${sanitizedError}`,
      };
    }
  }

  /**
   * Validate that operation is read-only
   */
  protected validateReadOnly(action: string): ExecutionResult | null {
    if (this.isWriteOperation(action)) {
      return {
        error: "OPERATION_FORBIDDEN: Write operations are not allowed in read-only tools",
      };
    }
    return null;
  }
}
