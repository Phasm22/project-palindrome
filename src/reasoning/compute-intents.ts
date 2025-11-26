export type ComputeIntent =
  | { type: "describe_cluster" }
  | { type: "vms_by_node"; nodeName: string }
  | { type: "vms_without_agent" }
  | { type: "stopped_vms_on_node"; nodeName: string };

function extractNodeName(text: string): string | null {
  const nodeMatch = text.match(/\bnode\s+([a-z0-9\-_]+)/i);
  if (nodeMatch) {
    return nodeMatch[1];
  }

  const relationMatch = text.match(/\bbetween\s+([a-z0-9\-_]+)/i);
  if (relationMatch) {
    return relationMatch[1];
  }

  const onMatch = text.match(/\bon\s+([a-z0-9\-_]+)/i);
  if (onMatch) {
    return onMatch[1];
  }

  return null;
}

export function detectComputeIntent(userInput: string): ComputeIntent | null {
  const normalized = userInput.toLowerCase();

  if (normalized.includes("describe") && normalized.includes("cluster")) {
    return { type: "describe_cluster" };
  }

  if (normalized.includes("guest agent")) {
    return { type: "vms_without_agent" };
  }

  if (normalized.includes("relationship") && normalized.includes("hosted")) {
    const nodeName = extractNodeName(userInput);
    if (nodeName) {
      return { type: "vms_by_node", nodeName };
    }
  }

  if (normalized.includes("stopped")) {
    const nodeName = extractNodeName(userInput);
    if (nodeName) {
      return { type: "stopped_vms_on_node", nodeName };
    }
  }

  if (normalized.includes("which vms") || normalized.includes("list vms")) {
    const nodeName = extractNodeName(userInput);
    if (nodeName) {
      return { type: "vms_by_node", nodeName };
    }
  }

  return null;
}

