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
  refreshSeed?: string;
};

export function buildTwinPromptSuggestions(input: {
  nodes: NodeSummary[];
  vms: VmSummary[];
  maxSuggestions?: number;
  seed?: string;
}): PromptSuggestion[] {
  const maxSuggestions = input.maxSuggestions ?? 6;
  const seed = (input.seed || "").trim() || String(Date.now());
  const suggestions: PromptSuggestion[] = [];
  const seenPrompts = new Set<string>();

  const hashSeed = (value: string): number => {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) || 1;
  };

  const createSeededRng = (seedValue: string) => {
    let state = hashSeed(seedValue);
    return () => {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >> 17;
      state >>>= 0;
      state ^= state << 5;
      state >>>= 0;
      return (state >>> 0) / 4294967296;
    };
  };

  const shuffleWithSeed = <T,>(items: T[], seedValue: string): T[] => {
    const rng = createSeededRng(seedValue);
    const shuffled = [...items];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const current = shuffled[i]!;
      shuffled[i] = shuffled[j]!;
      shuffled[j] = current;
    }
    return shuffled;
  };

  const addSuggestion = (title: string, prompt: string) => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    if (seenPrompts.has(trimmed)) return;
    const id = createHash("sha256").update(trimmed).digest("hex").slice(0, 10);
    suggestions.push({ id, title: title.trim(), prompt: trimmed });
    seenPrompts.add(trimmed);
  };

  const nodes = input.nodes;
  const vms = input.vms;

  const sortedNodes = [...nodes].sort((a, b) => (b.vmCount || 0) - (a.vmCount || 0));
  const sortedVms = [...vms].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const runningVms = sortedVms.filter((vm) => (vm.state || "").toLowerCase() === "running");
  const stoppedVms = sortedVms.filter((vm) => (vm.state || "").toLowerCase() !== "running");
  const qemuVms = sortedVms.filter((vm) => vm.vmKind === "qemu");
  const lxcVms = sortedVms.filter((vm) => vm.vmKind === "lxc");

  addSuggestion("Cluster overview", "Describe the cluster status and VM counts.");
  addSuggestion("Running VMs", "List all running VMs across the cluster.");
  addSuggestion("Stopped VMs", "List all stopped VMs and the nodes they are on.");
  addSuggestion("Node VM distribution", "Show VM counts per node.");
  addSuggestion("Cluster health", "Summarize node health and any degraded nodes.");

  const primaryNode = sortedNodes[0];
  if (primaryNode?.name) {
    addSuggestion(
      `VMs on ${primaryNode.name}`,
      `List all VMs running on ${primaryNode.name}.`
    );
    addSuggestion(
      `Node detail for ${primaryNode.name}`,
      `Show health, VM count, and storage summary for ${primaryNode.name}.`
    );
  }

  const secondaryNode = sortedNodes[1];
  if (secondaryNode?.name) {
    addSuggestion(
      `VMs on ${secondaryNode.name}`,
      `List all VMs currently on ${secondaryNode.name}.`
    );
  }

  const nodesWithTemp = nodes.filter((node) => node.temperature && node.temperature.sensors);
  if (nodesWithTemp.length > 0) {
    addSuggestion("Node temperatures", "Show temperature readings for all nodes.");
    const hottestNode = [...nodesWithTemp].sort(
      (a, b) => (b.temperature?.max || 0) - (a.temperature?.max || 0)
    )[0];
    if (hottestNode?.name) {
      addSuggestion(
        `Temperature focus: ${hottestNode.name}`,
        `Show detailed temperature sensors for ${hottestNode.name}.`
      );
    }
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

  const sampleVm =
    shuffleWithSeed(sortedVms.filter((vm) => vm.name), `${seed}:sample-vm`)[0] ??
    vms.find((vm) => vm.name) ??
    vms[0];
  if (sampleVm?.name) {
    addSuggestion(
      `Status for ${sampleVm.name}`,
      `Is ${sampleVm.name} running and which node hosts it?`
    );
    addSuggestion(
      `Networking for ${sampleVm.name}`,
      `Show IP and network interfaces for ${sampleVm.name}.`
    );
    addSuggestion(
      `Trace ${sampleVm.name}`,
      `Show provenance and recent changes for ${sampleVm.name}.`
    );
  }

  if (runningVms.length > 0) {
    const sampleRunning = shuffleWithSeed(runningVms, `${seed}:running-vm`)[0];
    if (sampleRunning?.name) {
      addSuggestion(
        `Capacity check on ${sampleRunning.name}`,
        `Show CPU and memory status for ${sampleRunning.name}.`
      );
    }
  }

  if (stoppedVms.length > 0) {
    addSuggestion("Recover stopped workloads", "Which stopped VMs should be restarted?");
  }

  if (qemuVms.length > 0) {
    addSuggestion("QEMU inventory", "List all QEMU VMs and their current state.");
  }

  if (lxcVms.length > 0) {
    addSuggestion("LXC inventory", "List all LXC containers in the cluster.");
  }

  if (suggestions.length <= maxSuggestions) {
    return suggestions;
  }

  const [anchor, ...rest] = suggestions;
  const rotated = shuffleWithSeed(rest, `${seed}:rotation`);
  if (!anchor) {
    return rotated.slice(0, maxSuggestions);
  }
  return [anchor, ...rotated.slice(0, Math.max(0, maxSuggestions - 1))];
}

export class PromptSuggestionService {
  private store: PromptSuggestionStore;
  private maxSuggestions: number;
  private twinQuery: TwinQueryService;
  private refreshSeed?: string;

  constructor(options?: {
    store?: PromptSuggestionStore;
    twinQuery?: TwinQueryService;
    maxSuggestions?: number;
    refreshSeed?: string;
  }) {
    this.store = options?.store ?? new PromptSuggestionStore();
    this.twinQuery = options?.twinQuery ?? new TwinQueryService();
    this.maxSuggestions = options?.maxSuggestions ?? 6;
    this.refreshSeed = options?.refreshSeed;
  }

  async generateFromTwin(): Promise<Omit<PromptSuggestionBatch, "id">> {
    const { nodes, vms } = await this.twinQuery.describeCluster(null);
    const suggestions = buildTwinPromptSuggestions({
      nodes,
      vms,
      maxSuggestions: this.maxSuggestions,
      seed: this.refreshSeed,
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
      refreshSeed: this.refreshSeed,
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
