import { createHash } from "node:crypto";
import { TwinQueryService } from "../../twin/api/twin-query-service";
import { pceLogger } from "../utils/logger";
import type { PromptSuggestion, PromptSuggestionBatch } from "./prompt-suggestion-store";
import { PromptSuggestionStore } from "./prompt-suggestion-store";

type NodeSummary = {
  id: string;
  name: string;
  vmCount: number;
  status?: string;
  temperature?: { max?: number; average?: number; sensors?: number };
};

type VmSummary = {
  id: string;
  name: string;
  nodeName?: string;
  state?: string;
  agentAvailable?: boolean;
  vmKind?: "qemu" | "lxc";
};

export type TwinSuggestionContext = {
  nodeCount: number;
  vmCount: number;
  nodeNames: string[];
  vmNames: string[];
  nodesWithTemperature: number;
  nodesOffline: number;
  vmKinds: Array<"qemu" | "lxc">;
};

export function buildTwinPromptSuggestions(input: {
  nodes: NodeSummary[];
  vms: VmSummary[];
  maxSuggestions?: number;
}): PromptSuggestion[] {
  const maxSuggestions = input.maxSuggestions ?? 6;
  const suggestions: PromptSuggestion[] = [];
  const seenPrompts = new Set<string>();

  const addSuggestion = (title: string, prompt: string) => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    if (seenPrompts.has(trimmed)) return;
    if (suggestions.length >= maxSuggestions) return;
    const id = createHash("sha256").update(trimmed).digest("hex").slice(0, 10);
    suggestions.push({ id, title: title.trim(), prompt: trimmed });
    seenPrompts.add(trimmed);
  };

  const nodes = input.nodes;
  const vms = input.vms;

  addSuggestion("Cluster overview", "Describe the cluster status and VM counts.");

  const sortedNodes = [...nodes].sort((a, b) => (b.vmCount || 0) - (a.vmCount || 0));
  const primaryNode = sortedNodes[0];
  if (primaryNode?.name) {
    addSuggestion(
      `VMs on ${primaryNode.name}`,
      `List all VMs running on ${primaryNode.name}.`
    );
  }

  const nodesWithTemp = nodes.filter((node) => node.temperature && node.temperature.sensors);
  if (nodesWithTemp.length > 0) {
    addSuggestion("Node temperatures", "Show temperature readings for all nodes.");
  }

  const offlineNodes = nodes.filter((node) =>
    ["offline", "degraded"].includes((node.status ?? "").toLowerCase())
  );
  if (offlineNodes.length > 0) {
    addSuggestion("Node health", "Which nodes are offline or degraded?");
  }

  const vmWithoutAgent = vms.find((vm) => vm.agentAvailable === false);
  if (vmWithoutAgent?.name) {
    addSuggestion("Agent coverage", "Which VMs are missing the agent?");
  }

  const sampleVm = vms.find((vm) => vm.name) ?? vms[0];
  if (sampleVm?.name) {
    addSuggestion(
      `Status for ${sampleVm.name}`,
      `Is ${sampleVm.name} running and which node hosts it?`
    );
  }

  const hasLxc = vms.some((vm) => vm.vmKind === "lxc");
  if (hasLxc) {
    addSuggestion("LXC inventory", "List all LXC containers in the cluster.");
  }

  return suggestions.slice(0, maxSuggestions);
}

export class PromptSuggestionService {
  private store: PromptSuggestionStore;
  private maxSuggestions: number;
  private twinQuery: TwinQueryService;

  constructor(options?: {
    store?: PromptSuggestionStore;
    twinQuery?: TwinQueryService;
    maxSuggestions?: number;
  }) {
    this.store = options?.store ?? new PromptSuggestionStore();
    this.twinQuery = options?.twinQuery ?? new TwinQueryService();
    this.maxSuggestions = options?.maxSuggestions ?? 6;
  }

  async generateFromTwin(): Promise<Omit<PromptSuggestionBatch, "id">> {
    const { nodes, vms } = await this.twinQuery.describeCluster(null);
    const suggestions = buildTwinPromptSuggestions({
      nodes,
      vms,
      maxSuggestions: this.maxSuggestions,
    });

    const context: TwinSuggestionContext = {
      nodeCount: nodes.length,
      vmCount: vms.length,
      nodeNames: nodes.map((node) => node.name),
      vmNames: vms.map((vm) => vm.name),
      nodesWithTemperature: nodes.filter((node) => node.temperature?.sensors).length,
      nodesOffline: nodes.filter((node) =>
        ["offline", "degraded"].includes((node.status ?? "").toLowerCase())
      ).length,
      vmKinds: Array.from(new Set(vms.map((vm) => vm.vmKind).filter(Boolean))) as Array<
        "qemu" | "lxc"
      >,
    };

    return {
      generatedAt: new Date(),
      source: "twin_heuristic",
      suggestions,
      context,
    };
  }

  async generateAndStore(): Promise<PromptSuggestionBatch> {
    try {
      const batch = await this.generateFromTwin();
      const id = await this.store.saveBatch(batch);
      return { ...batch, id };
    } catch (error: any) {
      pceLogger.warn("Failed to generate prompt suggestions", { error: error.message });
      throw error;
    } finally {
      await this.twinQuery.close();
    }
  }
}
