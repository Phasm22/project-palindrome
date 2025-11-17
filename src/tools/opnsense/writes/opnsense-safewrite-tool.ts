import { OpnsenseWriteBase } from "./base";
import { z } from "zod";
import type { ToolSchema } from "../../tool-schema";
import { createToolSchema } from "../../tool-helpers";
import type { ExecutionResult, ExecutionContext } from "../../../types/execution";
import type { AxiosInstance } from "axios";

/**
 * Schema for OPNsense safe write tool parameters
 * Supports 3-5 low-risk write actions
 */
export const OpnsenseSafeWriteParams = z.object({
  action: z.enum([
    "create_disabled_alias",
    "enable_rule_with_confirmation",
    "update_description_field",
    "toggle_rule_enabled",
    "update_alias_description",
  ]).describe("The safe write operation to perform"),

  // Common parameters
  dryRun: z.boolean().optional().default(false).describe("If true, return diff preview without executing"),

  // create_disabled_alias parameters
  alias_name: z.string().optional().describe("Alias name (required for create_disabled_alias)"),
  alias_type: z.enum(["host", "network", "port"]).optional().describe("Alias type (required for create_disabled_alias)"),
  alias_content: z.string().optional().describe("Alias content (required for create_disabled_alias)"),
  alias_description: z.string().optional().describe("Alias description"),

  // enable_rule_with_confirmation parameters
  rule_uuid: z.string().optional().describe("Rule UUID (required for enable_rule_with_confirmation)"),

  // update_description_field parameters
  target_type: z.enum(["rule", "alias"]).optional().describe("Target type (required for update_description_field)"),
  target_uuid: z.string().optional().describe("Target UUID (required for update_description_field)"),
  description: z.string().optional().describe("New description (required for update_description_field)"),

  // toggle_rule_enabled parameters
  enabled: z.boolean().optional().describe("Enable/disable state (required for toggle_rule_enabled)"),
});

export type OpnsenseSafeWriteParams = z.infer<typeof OpnsenseSafeWriteParams>;

/**
 * Unified OPNsense Safe Write Tool
 * Provides controlled, low-risk write operations with mandatory HIL safety
 */
export class OpnsenseSafeWriteTool extends OpnsenseWriteBase {
  constructor() {
    super({
      name: "opnsense_safewrite",
      description: "Controlled, low-risk write operations for OPNsense with mandatory human-in-the-loop safety. All operations support dry-run mode and require confirmation.",
      categories: ["opnsense", "networking", "firewall", "write"],
      allowedAcls: ["admin", "ops"], // Only admin and ops can write
      risk: "medium", // Medium risk - requires confirmation
      requiresConfirmation: true, // All write operations require confirmation
    });
  }

  getSchema(): ToolSchema {
    return createToolSchema(this, OpnsenseSafeWriteParams, {
      examples: [
        {
          description: "Create a disabled alias (dry-run)",
          parameters: {
            action: "create_disabled_alias",
            alias_name: "test-alias",
            alias_type: "host",
            alias_content: "192.168.1.100",
            alias_description: "Test alias",
            dryRun: true,
          },
        },
        {
          description: "Enable a firewall rule",
          parameters: {
            action: "enable_rule_with_confirmation",
            rule_uuid: "abc-123-def",
            dryRun: false,
          },
        },
        {
          description: "Update rule description",
          parameters: {
            action: "update_description_field",
            target_type: "rule",
            target_uuid: "abc-123-def",
            description: "Updated description",
            dryRun: true,
          },
        },
      ],
      notes: [
        "All write operations require human confirmation before execution.",
        "Use dryRun: true to preview changes without executing.",
        "Only admin and ops ACL groups can execute write operations.",
        "Pre-write state is automatically captured for rollback capability.",
      ],
    });
  }

  getParameterSchema() {
    return OpnsenseSafeWriteParams;
  }

  async execute(
    params: Record<string, any>,
    context: ExecutionContext
  ): Promise<ExecutionResult> {
    const parsed = OpnsenseSafeWriteParams.safeParse(params);
    if (!parsed.success) {
      return { error: `Invalid parameters: ${parsed.error.message}` };
    }

    const { action, dryRun = false, ...actionParams } = parsed.data;
    const client = this.getApiClient();

    // Route to appropriate handler based on action
    return this.executeApiCall(
      () => this.handleAction(action, actionParams, client, dryRun, context),
      context
    );
  }

  /**
   * Route action to appropriate handler
   */
  private async handleAction(
    action: string,
    params: Record<string, any>,
    client: AxiosInstance,
    dryRun: boolean,
    context: ExecutionContext
  ): Promise<any> {
    switch (action) {
      case "create_disabled_alias":
        return this.handleCreateDisabledAlias(params, client, dryRun, context);

      case "enable_rule_with_confirmation":
        return this.handleEnableRule(params, client, dryRun, context);

      case "update_description_field":
        return this.handleUpdateDescription(params, client, dryRun, context);

      case "toggle_rule_enabled":
        return this.handleToggleRuleEnabled(params, client, dryRun, context);

      case "update_alias_description":
        return this.handleUpdateAliasDescription(params, client, dryRun, context);

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  /**
   * Create a disabled firewall alias
   */
  private async handleCreateDisabledAlias(
    params: Record<string, any>,
    client: AxiosInstance,
    dryRun: boolean,
    context: ExecutionContext
  ): Promise<any> {
    const { alias_name, alias_type, alias_content, alias_description } = params;

    if (!alias_name || !alias_type || !alias_content) {
      throw new Error("alias_name, alias_type, and alias_content are required");
    }

    // Check if alias already exists
    let existingAlias = null;
    try {
      const response = await client.get(`/api/firewall/alias/getItem/${alias_name}`);
      existingAlias = response.data?.item || null;
    } catch (error: any) {
      // Alias doesn't exist, which is fine
      if (error.response?.status !== 404) {
        throw error;
      }
    }

    const newAlias = {
      name: alias_name,
      type: alias_type,
      content: alias_content,
      description: alias_description || "",
      enabled: false, // Always create disabled
    };

    if (dryRun) {
      // Return diff preview
      return this.generateDiffPreview(
        "create_disabled_alias",
        `alias:${alias_name}`,
        existingAlias || null,
        newAlias
      );
    }

    // Capture pre-write state if alias exists
    let provenance: any = null;
    if (existingAlias) {
      provenance = await this.capturePreWriteState(
        "alias",
        alias_name,
        async () => existingAlias
      );
    }

    // Create the alias (disabled)
    const response = await client.post("/api/firewall/alias/addItem", {
      item: newAlias,
    });

    return {
      action: "create_disabled_alias",
      alias_name,
      result: response.data || {},
      provenance,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Enable a disabled firewall rule
   */
  private async handleEnableRule(
    params: Record<string, any>,
    client: AxiosInstance,
    dryRun: boolean,
    context: ExecutionContext
  ): Promise<any> {
    const { rule_uuid } = params;

    if (!rule_uuid) {
      throw new Error("rule_uuid is required");
    }

    // Get current rule state
    const getRuleResponse = await client.get(`/api/firewall/rule/getRule/${rule_uuid}`);
    const currentRule = getRuleResponse.data?.rule || null;

    if (!currentRule) {
      throw new Error(`Rule ${rule_uuid} not found`);
    }

    const updatedRule = {
      ...currentRule,
      enabled: true,
    };

    if (dryRun) {
      // Return diff preview
      return this.generateDiffPreview(
        "enable_rule_with_confirmation",
        `rule:${rule_uuid}`,
        currentRule,
        updatedRule
      );
    }

    // Capture pre-write state
    const provenance = await this.capturePreWriteState(
      "rule",
      rule_uuid,
      async () => currentRule
    );

    // Update the rule
    const response = await client.post(`/api/firewall/rule/setRule/${rule_uuid}`, {
      rule: updatedRule,
    });

    return {
      action: "enable_rule_with_confirmation",
      rule_uuid,
      result: response.data || {},
      provenance,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Update description field of a rule or alias
   */
  private async handleUpdateDescription(
    params: Record<string, any>,
    client: AxiosInstance,
    dryRun: boolean,
    context: ExecutionContext
  ): Promise<any> {
    const { target_type, target_uuid, description } = params;

    if (!target_type || !target_uuid || description === undefined) {
      throw new Error("target_type, target_uuid, and description are required");
    }

    let currentItem: any;
    let updateEndpoint: string;
    let itemKey: string;

    if (target_type === "rule") {
      const response = await client.get(`/api/firewall/rule/getRule/${target_uuid}`);
      currentItem = response.data?.rule || null;
      updateEndpoint = `/api/firewall/rule/setRule/${target_uuid}`;
      itemKey = "rule";
    } else if (target_type === "alias") {
      const response = await client.get(`/api/firewall/alias/getItem/${target_uuid}`);
      currentItem = response.data?.item || null;
      updateEndpoint = `/api/firewall/alias/setItem/${target_uuid}`;
      itemKey = "item";
    } else {
      throw new Error(`Invalid target_type: ${target_type}`);
    }

    if (!currentItem) {
      throw new Error(`${target_type} ${target_uuid} not found`);
    }

    const updatedItem = {
      ...currentItem,
      description: description,
    };

    if (dryRun) {
      // Return diff preview
      return this.generateDiffPreview(
        "update_description_field",
        `${target_type}:${target_uuid}`,
        currentItem,
        updatedItem
      );
    }

    // Capture pre-write state
    const provenance = await this.capturePreWriteState(
      target_type,
      target_uuid,
      async () => currentItem
    );

    // Update the item
    const response = await client.post(updateEndpoint, {
      [itemKey]: updatedItem,
    });

    return {
      action: "update_description_field",
      target_type,
      target_uuid,
      result: response.data || {},
      provenance,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Toggle rule enabled/disabled state
   */
  private async handleToggleRuleEnabled(
    params: Record<string, any>,
    client: AxiosInstance,
    dryRun: boolean,
    context: ExecutionContext
  ): Promise<any> {
    const { rule_uuid, enabled } = params;

    if (!rule_uuid || enabled === undefined) {
      throw new Error("rule_uuid and enabled are required");
    }

    // Get current rule state
    const getRuleResponse = await client.get(`/api/firewall/rule/getRule/${rule_uuid}`);
    const currentRule = getRuleResponse.data?.rule || null;

    if (!currentRule) {
      throw new Error(`Rule ${rule_uuid} not found`);
    }

    const updatedRule = {
      ...currentRule,
      enabled: enabled,
    };

    if (dryRun) {
      // Return diff preview
      return this.generateDiffPreview(
        "toggle_rule_enabled",
        `rule:${rule_uuid}`,
        currentRule,
        updatedRule
      );
    }

    // Capture pre-write state
    const provenance = await this.capturePreWriteState(
      "rule",
      rule_uuid,
      async () => currentRule
    );

    // Update the rule
    const response = await client.post(`/api/firewall/rule/setRule/${rule_uuid}`, {
      rule: updatedRule,
    });

    return {
      action: "toggle_rule_enabled",
      rule_uuid,
      enabled,
      result: response.data || {},
      provenance,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Update alias description
   */
  private async handleUpdateAliasDescription(
    params: Record<string, any>,
    client: AxiosInstance,
    dryRun: boolean,
    context: ExecutionContext
  ): Promise<any> {
    const { alias_name, description } = params;

    if (!alias_name || description === undefined) {
      throw new Error("alias_name and description are required");
    }

    // Get current alias state
    const getAliasResponse = await client.get(`/api/firewall/alias/getItem/${alias_name}`);
    const currentAlias = getAliasResponse.data?.item || null;

    if (!currentAlias) {
      throw new Error(`Alias ${alias_name} not found`);
    }

    const updatedAlias = {
      ...currentAlias,
      description: description,
    };

    if (dryRun) {
      // Return diff preview
      return this.generateDiffPreview(
        "update_alias_description",
        `alias:${alias_name}`,
        currentAlias,
        updatedAlias
      );
    }

    // Capture pre-write state
    const provenance = await this.capturePreWriteState(
      "alias",
      alias_name,
      async () => currentAlias
    );

    // Update the alias
    const response = await client.post(`/api/firewall/alias/setItem/${alias_name}`, {
      item: updatedAlias,
    });

    return {
      action: "update_alias_description",
      alias_name,
      result: response.data || {},
      provenance,
      timestamp: new Date().toISOString(),
    };
  }
}

