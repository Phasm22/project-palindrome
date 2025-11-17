import { BaseTool } from "./BaseTool";
import { GlancesParams, GlancesJSONSchema } from "./schemas/glances";
import type { ExecutionResult, ExecutionContext } from "../types/execution";
import type { ToolSchema } from "./tool-schema";
import { createToolSchema } from "./tool-helpers";
import axios from "axios";

export class GlancesTool extends BaseTool {
  constructor() {
    super({
      name: "glances",
      description: "Fetches system metrics from the Glances API",
      categories: ["system"],
      parameters: GlancesJSONSchema,
      allowedAcls: ["admin", "ops", "sre"],
      risk: "low",
    });
  }

  getSchema(): ToolSchema {
    return createToolSchema(this, GlancesParams, {
      examples: [
        {
          description: "Get all metrics",
          parameters: { section: "all" }
        },
        {
          description: "Get CPU metrics only",
          parameters: { section: "cpu" }
        }
      ]
    });
  }

  getParameterSchema() {
    return GlancesParams;
  }

  async execute(
    params: Record<string, any>,
    context: ExecutionContext
  ): Promise<ExecutionResult> {
    const parsed = GlancesParams.safeParse(params);
    if (!parsed.success) {
      return { error: parsed.error.message };
    }

    const started = context.startedAt ?? Date.now();
    const section = parsed.data.section;
    
    try {
      const url =
        section === "all"
          ? "http://127.0.0.1:61208/api/3/all"
          : `http://127.0.0.1:61208/api/3/${section}`;
      const res = await axios.get(url);
      return { data: res.data, durationMs: Date.now() - started };
    } catch (err: any) {
      return {
        error: err.message ?? "Glances request failed",
        durationMs: Date.now() - started,
      };
    }
  }
}

