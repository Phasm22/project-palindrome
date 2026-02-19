import { BaseTool } from "../../BaseTool";
import type { ExecutionResult, ExecutionContext } from "../../../types/execution";
import { logger } from "../../../utils/logger";
import axios from "axios";
import type { AxiosInstance } from "axios";
import https from "https";
import { sanitizeToolPayload } from "../../../agent/tool-sanitizer";
import { generateSHA256Hash } from "../../../pce/dlm/hash";

/**
 * Diff preview structure for dry-run operations
 */
export interface DiffPreview {
  operation: string;
  target: string;
  before: any;
  after: any;
  changes: Array<{
    field: string;
    oldValue: any;
    newValue: any;
  }>;
  dryRun: true;
}

/**
 * Provenance snapshot for pre-write state
 */
export interface ProvenanceSnapshot {
  snapshotId: string;
  versionHash: string;
  timestamp: string;
  targetType: string;
  targetId: string;
  state: any;
}

/**
 * Base class for OPNsense write tools
 * Provides common functionality: API client, authentication, dry-run, provenance capture
 */
export abstract class OpnsenseWriteBase extends BaseTool {
  protected apiClient: AxiosInstance | null = null;

  /**
   * Get API configuration from environment variables
   */
  protected getApiConfig() {
    const url = process.env.OPNSENSE_URL;
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
   * Capture pre-write state for provenance
   * Must be called BEFORE executing the write operation
   */
  protected async capturePreWriteState(
    targetType: string,
    targetId: string,
    getCurrentState: () => Promise<any>
  ): Promise<ProvenanceSnapshot> {
    try {
      const state = await getCurrentState();
      const stateJson = JSON.stringify(state, null, 2);
      const versionHash = generateSHA256Hash(stateJson);
      const snapshotId = `snapshot-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      const snapshot: ProvenanceSnapshot = {
        snapshotId,
        versionHash,
        timestamp: new Date().toISOString(),
        targetType,
        targetId,
        state,
      };

      logger.info("Pre-write state captured", {
        snapshotId,
        versionHash,
        targetType,
        targetId,
      });

      return snapshot;
    } catch (error: any) {
      logger.error("Failed to capture pre-write state", {
        targetType,
        targetId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Generate diff preview for dry-run mode
   */
  protected generateDiffPreview(
    operation: string,
    target: string,
    before: any,
    after: any
  ): DiffPreview {
    const changes: Array<{ field: string; oldValue: any; newValue: any }> = [];

    // Compare objects recursively
    const compareObjects = (oldObj: any, newObj: any, prefix = "") => {
      const allKeys = new Set([...Object.keys(oldObj || {}), ...Object.keys(newObj || {})]);

      for (const key of allKeys) {
        const oldVal = oldObj?.[key];
        const newVal = newObj?.[key];
        const fieldPath = prefix ? `${prefix}.${key}` : key;

        if (oldVal === undefined && newVal !== undefined) {
          changes.push({ field: fieldPath, oldValue: null, newValue: newVal });
        } else if (oldVal !== undefined && newVal === undefined) {
          changes.push({ field: fieldPath, oldValue: oldVal, newValue: null });
        } else if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
          if (typeof oldVal === "object" && typeof newVal === "object" && oldVal !== null && newVal !== null) {
            compareObjects(oldVal, newVal, fieldPath);
          } else {
            changes.push({ field: fieldPath, oldValue: oldVal, newValue: newVal });
          }
        }
      }
    };

    compareObjects(before, after);

    return {
      operation,
      target,
      before,
      after,
      changes,
      dryRun: true,
    };
  }

  /**
   * Execute API call with error handling and sanitization
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
      logger.error("OPNsense API call failed", {
        tool: this.metadata.name,
        error: error.message,
        status: error.response?.status,
      });

      // Sanitize error messages too
      const errorMessage = error.response?.data?.message || error.message || "Unknown error";
      const sanitizedError = typeof errorMessage === "string"
        ? sanitizeToolPayload(errorMessage)
        : sanitizeToolPayload(JSON.stringify(errorMessage));

      return {
        error: `OPNsense API error: ${sanitizedError}`,
      };
    }
  }

  /**
   * Validate that operation is authorized (should be checked by tool-policy, but double-check here)
   */
  protected validateWriteOperation(context: ExecutionContext): ExecutionResult | null {
    // This is a safety check - the real ACL enforcement happens in tool-policy
    // But we can add additional validation here if needed
    return null;
  }
}
