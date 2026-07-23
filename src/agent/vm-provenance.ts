import type { ResolvedVmEntity } from "./handlers/tool-argument-hydration";

export interface VmProvenanceIntent {
  vmName: string;
}

export function detectVmProvenanceIntent(query: string): VmProvenanceIntent | null {
  if (
    !/\bprovenance\b/i.test(query) ||
    !/\b(?:recent\s+changes?|change\s+history|recent\s+tasks?|task\s+history)\b/i.test(query)
  ) {
    return null;
  }

  const match = query.match(/\b(?:for|of)\s+[`"']?(.+?)[`"']?\s*[.?!]*$/i);
  const vmName = match?.[1]
    ?.trim()
    .replace(/^(?:vm|container|lxc)\s+/i, "")
    .trim();
  return vmName ? { vmName } : null;
}

function inlineCode(value: unknown): string {
  return `\`${String(value).replace(/`/g, "\\`")}\``;
}

function formatTimestamp(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  return "Not available";
}

export function formatVmProvenanceAnswer(input: {
  resolution: ResolvedVmEntity;
  configData?: Record<string, any>;
  configError?: string;
  tasksData?: Record<string, any>;
  tasksError?: string;
}): string {
  const { resolution, configData, configError, tasksData, tasksError } = input;
  const configProvenance = configData?._provenance;
  const taskProvenance = tasksData?._provenance;
  const tasks = Array.isArray(tasksData?.tasks) ? tasksData.tasks.slice(0, 10) : [];
  const lines = [
    `${resolution.name ?? `VM ${resolution.vmid}`} provenance`,
    `- VMID: ${resolution.vmid}`,
    `- Node: ${resolution.node}`,
    `- Type: ${resolution.type ?? "unknown"}`,
    "",
    "Configuration evidence",
  ];

  if (configError) {
    lines.push(`- Unavailable: ${configError}`);
  } else {
    lines.push("- Source: Live Proxmox API");
    lines.push(
      `- Provenance ID: ${
        configProvenance?.provenanceId
          ? inlineCode(configProvenance.provenanceId)
          : "Not available"
      }`
    );
    lines.push(`- Observed: ${formatTimestamp(configProvenance?.timestamp)}`);
    if (configData?.hostname) lines.push(`- Hostname: ${configData.hostname}`);
    if (configData?.onboot !== undefined) {
      lines.push(`- Start at boot: ${configData.onboot ? "yes" : "no"}`);
    }
  }

  lines.push("", "Recent Proxmox changes");
  if (tasksError) {
    lines.push(`- Unavailable: ${tasksError}`);
  } else if (tasks.length === 0) {
    lines.push(`- No matching Proxmox tasks were returned for VMID ${resolution.vmid}.`);
  } else {
    for (const task of tasks) {
      const timestamp = formatTimestamp(task.starttime_iso8601 ?? task.starttime);
      const type = task.type ?? "unknown";
      const status = task.status_normalized ?? task.status ?? "unknown";
      const user = task.user ? ` | User=${task.user}` : "";
      lines.push(`- ${timestamp} | Action=${type} | Status=${status}${user}`);
    }
  }
  if (!tasksError && taskProvenance?.provenanceId) {
    lines.push(`- Task-query provenance: ${inlineCode(taskProvenance.provenanceId)}`);
  }

  return lines.join("\n");
}
