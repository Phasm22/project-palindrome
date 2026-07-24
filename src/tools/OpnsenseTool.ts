import { BaseTool } from "./BaseTool";
import { OpnsenseParams } from "./schemas/opnsense";
import type { ExecutionResult, ExecutionContext } from "../types/execution";
import type { ToolSchema } from "./tool-schema";
import { createToolSchema } from "./tool-helpers";
import { logger } from "../utils/logger";
import axios from "axios";
import https from "https";

export class OpnsenseTool extends BaseTool {
  constructor() {
    super({
      name: "opnsense_manage",
      description: "Read-only access to OPNsense system status and firewall aliases in LAB ONLY.",
      categories: ["networking", "firewall"]
    });
  }

  override getSchema(): ToolSchema {
    return createToolSchema(this, OpnsenseParams, {
      examples: [
        {
          description: "Get system status",
          parameters: { action: "system_status" }
        },
        {
          description: "List all aliases",
          parameters: { action: "list_aliases" }
        },
        {
          description: "Search aliases",
          parameters: { action: "search_aliases", search_term: "example" }
        }
      ],
      notes: [
        "system_status includes disk usage, system health, and subsystem status information.",
        "Write operations are disabled in this environment."
      ]
    });
  }

  override getParameterSchema() {
    return OpnsenseParams;
  }

  private getApiConfig() {
    const url = process.env.OPNSENSE_URL;
    const key = process.env.OPNSENSE_API_KEY;
    const secret = process.env.OPNSENSE_API_SECRET;
    const verifySsl = process.env.OPNSENSE_VERIFY_SSL !== "false";

    if (!url || !key || !secret) {
      throw new Error("OPNSENSE_URL, OPNSENSE_API_KEY, and OPNSENSE_API_SECRET must be set");
    }

    return { url, key, secret, verifySsl };
  }

  private createAxiosInstance(verifySsl: boolean) {
    const httpsAgent = new https.Agent({
      rejectUnauthorized: verifySsl,
    });

    return axios.create({
      httpsAgent,
      auth: {
        username: this.getApiConfig().key,
        password: this.getApiConfig().secret,
      },
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  async execute(
    params: Record<string, any>,
    context: ExecutionContext
  ): Promise<ExecutionResult> {
    const parsed = OpnsenseParams.safeParse(params);
    if (!parsed.success) {
      return { error: parsed.error.message };
    }

    // Enforce read-only behavior
    const allowedActions = ["system_status", "list_aliases", "search_aliases"];
    if (!allowedActions.includes(parsed.data.action)) {
      return {
        error: "Write operations are disabled in this environment.",
      };
    }

    const started = context.startedAt ?? Date.now();

    try {
      const { url, verifySsl } = this.getApiConfig();
      const client = this.createAxiosInstance(verifySsl);
      let result: any;

      switch (parsed.data.action) {
        case "system_status": {
          // OPNsense API: POST /api/core/system/status
          const endpoint = `${url}/api/core/system/status`;
          logger.info(`OPNsense API call: POST ${endpoint}`);
          const response = await client.post(endpoint, {});
          result = response.data;
          break;
        }

        case "list_aliases": {
          // OPNsense API: POST /api/firewall/alias/searchItem
          const endpoint = `${url}/api/firewall/alias/searchItem`;
          logger.info(`OPNsense API call: POST ${endpoint}`);
          const response = await client.post(endpoint, {});
          result = response.data;
          break;
        }

        case "search_aliases": {
          // OPNsense API: POST /api/firewall/alias/searchItem with search
          const searchTerm = parsed.data.search_term || "";
          const endpoint = `${url}/api/firewall/alias/searchItem`;
          logger.info(`OPNsense API call: POST ${endpoint} with search: ${searchTerm}`);
          const response = await client.post(endpoint, {
            search: searchTerm,
          });
          result = response.data;
          break;
        }

        default:
          return {
            error: `Unknown action: ${parsed.data.action}`,
            durationMs: Date.now() - started,
          };
      }

      return {
        data: result,
        durationMs: Date.now() - started,
      };
    } catch (err: any) {
      // Better error logging for debugging
      let errorMessage = "OPNsense API request failed";
      
      if (err.response) {
        // HTTP error response
        const status = err.response.status;
        const statusText = err.response.statusText;
        const responseData = err.response.data;
        
        // Try to extract meaningful error message
        if (typeof responseData === 'string') {
          // If response is a string (HTML, plain text, etc.)
          errorMessage = responseData.length > 200 
            ? `${statusText} (${status}): ${responseData.substring(0, 200)}...`
            : `${statusText} (${status}): ${responseData}`;
          logger.error(`OPNsense API error (${status}): ${responseData.substring(0, 500)}`);
        } else if (responseData?.message) {
          errorMessage = responseData.message;
          logger.error(`OPNsense API error: ${JSON.stringify(responseData)}`);
        } else {
          errorMessage = statusText || `HTTP ${status}`;
          logger.error(`OPNsense API error (${status}): ${JSON.stringify(responseData)}`);
        }
      } else if (err.request) {
        // Request made but no response
        errorMessage = "No response from OPNsense API";
      } else {
        // Error setting up request
        errorMessage = err.message || errorMessage;
      }
      
      return {
        error: errorMessage,
        durationMs: Date.now() - started,
      };
    }
  }
}
