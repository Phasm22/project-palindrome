/**
 * Zod schema for LLM-based intent classification (Phase 2 — Structured Outputs).
 *
 * The schema is intentionally flat so the LLM gets a clear, one-level contract.
 * `classifyAndRouteWithLLM()` maps the result back to `IntentClassification`.
 */

import { z } from "zod";
import type { IntentClassification, IntentType, RiskLevel } from "./intent-classifier";

export const IntentClassificationSchema = z.object({
  intent: z
    .enum(["QUERY", "ACTION", "CHAT_SOCIAL", "CHAT_REASONING", "CLARIFICATION"])
    .describe(
      "QUERY=read-only info request; ACTION=mutating op; CHAT_SOCIAL=greeting/thanks; CHAT_REASONING=explanation/analysis; CLARIFICATION=genuinely ambiguous"
    ),
  confidence: z.number().min(0).max(1).describe("Classification confidence 0–1"),
  risk: z
    .enum(["READ", "WRITE_LOW", "WRITE_HIGH", "DESTRUCTIVE"])
    .describe(
      "READ=no changes; WRITE_LOW=config edits; WRITE_HIGH=infra changes; DESTRUCTIVE=delete/destroy"
    ),
  domain: z
    .enum(["compute", "network", "firewall", "metrics", "general"])
    .optional()
    .describe("Infrastructure domain most relevant to the query"),
  actionType: z
    .enum(["create", "destroy", "start", "stop", "restart", "install", "configure"])
    .optional()
    .describe("Specific action verb for ACTION intents"),
  queryType: z
    .enum(["existence", "temperature", "status", "list", "describe", "metrics", "network"])
    .optional()
    .describe("Specific query subtype for QUERY intents (e.g. temperature, list, describe)"),
  missingSlots: z
    .array(z.string())
    .default([])
    .describe("Required parameters the user has not yet provided, e.g. ['target_node', 'vmid']. Use [] if none."),
  entities: z
    .object({
      hosts: z.array(z.string()).default([]).describe("Hostnames or IPs mentioned (use [] if none)"),
      services: z.array(z.string()).default([]).describe("Services or applications mentioned (use [] if none)"),
      resourceIds: z
        .array(z.string())
        .default([])
        .describe("Resource IDs (VMIDs, rule IDs, etc.) mentioned (use [] if none)"),
    })
    .default({ hosts: [], services: [], resourceIds: [] }),
  composite: z
    .boolean()
    .optional()
    .describe(
      "True if the query combines multiple dimensions (e.g. node + exposure, subnet + exposure level, nodes + temperature + no agent). Route to EXECUTE path so the LLM can coordinate multiple tools."
    ),
});

export type IntentClassificationLLM = z.infer<typeof IntentClassificationSchema>;

/**
 * Maps LLM generateObject result to the existing IntentClassification contract.
 * Ensures scope, operation.verbs, and metadata match what consumers expect.
 */
export function mapLLMResultToIntentClassification(llm: IntentClassificationLLM): IntentClassification {
  const intent = llm.intent as IntentType;
  const risk = llm.risk as RiskLevel;
  const verbs = llm.actionType ? [llm.actionType] : [];
  const operationType = llm.actionType ?? llm.queryType;
  return {
    type: intent,
    intent,
    confidence: llm.confidence,
    entities: {
      hosts: llm.entities.hosts ?? [],
      services: llm.entities.services ?? [],
      resourceIds: llm.entities.resourceIds ?? [],
    },
    scope: {},
    operation: {
      type: operationType,
      verbs,
    },
    risk,
    missing: llm.missingSlots ?? [],
    metadata:
      llm.domain || llm.actionType || llm.queryType || llm.composite
        ? {
            domain: llm.domain,
            actionType: llm.actionType,
            queryType: llm.queryType,
            composite: llm.composite,
          }
        : undefined,
  };
}

/**
 * System prompt used when calling generateObject with IntentClassificationSchema.
 */
export const CLASSIFICATION_SYSTEM_PROMPT = `You are an intent classifier for a homelab infrastructure assistant that manages Proxmox VMs and OPNsense firewalls.

Classify the user's query into one of:
- QUERY: read-only information requests ("list vms", "show firewall rules", "what is the temperature")
- ACTION: mutating operations ("create a vm", "install docker", "configure firewall")
- CHAT_SOCIAL: greetings, thanks, confirmations ("hello", "thanks", "ok")
- CHAT_REASONING: explanations, analysis, troubleshooting ("why is X slow", "explain the firewall config")
- CLARIFICATION: genuinely ambiguous, cannot determine intent without more info

For QUERY intents, set queryType when relevant: existence, temperature, status, list, describe, metrics, network.

Risk levels:
- READ: querying information, no changes
- WRITE_LOW: safe config changes (DNS record, DHCP sync)
- WRITE_HIGH: infrastructure modifications (VM creation, firewall rules, VLAN, static IP)
- DESTRUCTIVE: irreversible deletions (destroy VM, delete rules)

Respond with structured JSON only. Always include all keys required by the schema. For arrays, use [] when empty (including missingSlots and all entities arrays). Extract all entities (hosts, services, resource IDs) mentioned in the query. List in missingSlots any required parameters the user has not provided (e.g. target VM, node, vmid).
Set composite=true when the query combines multiple dimensions (e.g. "VMs on yang exposed to internet", "VMs in 172.16.0.0/22 and their exposure level", "nodes with VMs that have no agent and high temperature") so the system routes to multi-step execution.`;
