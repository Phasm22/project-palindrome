import { BaseTool } from "../BaseTool";
import { createToolSchema } from "../tool-helpers";
import {
  ApplicationLifecycleActionSchema,
  executeApplicationLifecycle,
} from "../../actions/applications/application-lifecycle-action";
import type { ToolSchema } from "../tool-schema";
import type {
  ExecutionContext,
  ExecutionResult,
} from "../../types/execution";

export class ApplicationLifecycleTool extends BaseTool {
  constructor() {
    super({
      name: "application_lifecycle",
      description:
        "Plan or execute complete applications from one strict manifest. " +
        "Use this for compound prompts involving multiple VMs, generated images, services, source-restricted firewalls, DNS, Traefik, or Authentik. " +
        "A single call owns rollback and teardown across every resource.",
      categories: [
        "action",
        "application",
        "terraform",
        "ansible",
        "authentik",
        "traefik",
      ],
      allowedAcls: ["admin", "ops"],
      risk: "high",
      requiresConfirmation: true,
    });
  }

  override getSchema(): ToolSchema {
    return createToolSchema(this, ApplicationLifecycleActionSchema, {
      notes: [
        "Fill every field; use null for templateId or vlanId when unspecified",
        "Use operation=deploy to create and operation=destroy to tear down the complete application",
        "Use dryRun=true to preview without changing infrastructure",
        "Generated images use source=generate, a non-null prompt, and an absolute VM destination",
        "For IDP-protected sites use provider=ops-authentik and expose backend HTTP only to the opsbox IP",
      ],
    });
  }

  override getParameterSchema() {
    return ApplicationLifecycleActionSchema;
  }

  async execute(
    params: Record<string, unknown>,
    _context: ExecutionContext
  ): Promise<ExecutionResult> {
    const started = Date.now();
    const parsed = ApplicationLifecycleActionSchema.safeParse(params);
    if (!parsed.success) {
      return {
        error: `Invalid application manifest: ${parsed.error.message}`,
        durationMs: Date.now() - started,
      };
    }

    try {
      const result = await executeApplicationLifecycle(parsed.data);
      if (!result.success) {
        return {
          error:
            result.execution?.error ||
            "Application lifecycle execution failed",
          data: result,
          durationMs: Date.now() - started,
        };
      }
      return { data: result, durationMs: Date.now() - started };
    } catch (error: unknown) {
      return {
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      };
    }
  }
}
