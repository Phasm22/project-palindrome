export interface CompoundApplicationRequest {
  vmName?: string;
  node?: "proxBig" | "yin" | "YANG";
  requestedPorts: number[];
  services: string[];
  assetDescription?: string;
  domain?: string;
}

const CREATE_VM_PATTERN = /\b(?:create|make|provision|spin up)\b[\s\S]*?\b(?:vm|virtual machine)\b/i;

function extractVmName(input: string): string | undefined {
  return input.match(
    /\b(?:vm|virtual machine)\b[\s\S]{0,80}?\b(?:named|called)\s+(?:["'`]([^"'`]+)["'`]|([a-z0-9][a-z0-9._-]*))/i
  )?.slice(1).find(Boolean)?.trim();
}

function extractNode(input: string): CompoundApplicationRequest["node"] {
  const match = input.match(/\b(?:on|in)\s+(?:node\s+)?(proxbig|yin|yang)\b/i);
  if (!match?.[1]) return undefined;
  const normalized = match[1].toLowerCase();
  if (normalized === "proxbig") return "proxBig";
  return normalized === "yang" ? "YANG" : "yin";
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

function parsePortSegment(segment: string): number | undefined {
  const normalized = segment.trim().toLowerCase().replace(/-/g, " ");
  if (/^\d{1,5}$/.test(normalized)) return Number(normalized);
  const values = normalized.split(/\s+/).map((word) => NUMBER_WORDS[word]);
  if (values.some((value) => value === undefined)) return undefined;
  if (values.length === 1) return values[0];
  if (values[0]! >= 20 && values[0]! % 10 === 0 && values[1]! < 10 && values.length === 2) {
    return values[0]! + values[1]!;
  }
  if (values.every((value) => value! >= 0 && value! <= 9)) {
    return Number(values.join(""));
  }
  return undefined;
}

function extractRequestedPorts(input: string): number[] {
  const phrase = input.match(
    /\bopen\s+ports?\s+(.+?)(?=\s+and\s+(?:put|install|configure|serve|host|publish)\b|[.;]|$)/i
  )?.[1]?.trim();
  if (!phrase) return [];
  return phrase
    .split(/\s*(?:,|\band\b)\s*/i)
    .map(parsePortSegment)
    .filter((port): port is number => port !== undefined && port >= 1 && port <= 65535);
}

function extractAssetDescription(input: string): string | undefined {
  return input.match(
    /\b(?:picture|image|photo)\s+of\s+(?:of\s+)?(.+?)(?=[.;]|\s+also\b|\s+and\s+(?:put|publish|open|install)\b|$)/i
  )?.[1]?.trim();
}

export function parseCompoundApplicationRequest(input: string): CompoundApplicationRequest | null {
  if (!CREATE_VM_PATTERN.test(input)) return null;

  const services = /\bnginx\b/i.test(input) ? ["Nginx"] : [];
  const requestedPorts = extractRequestedPorts(input);
  const assetDescription = extractAssetDescription(input);
  const usesOpsDomain = /\bops\s+domain\b/i.test(input);
  const concernCount = [
    services.length > 0,
    requestedPorts.length > 0,
    assetDescription !== undefined,
    usesOpsDomain,
  ].filter(Boolean).length;
  if (concernCount < 2) return null;

  const vmName = extractVmName(input);
  const domainLabel = vmName?.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  return {
    vmName,
    node: extractNode(input),
    requestedPorts,
    services,
    assetDescription,
    domain: usesOpsDomain && domainLabel ? `${domainLabel}.ops.prox` : undefined,
  };
}

export function summarizeCompoundApplicationRequest(request: CompoundApplicationRequest): string {
  const target = request.vmName ?? "unnamed VM";
  const lines = [`deploy application ${target}`];
  lines.push(`- VM: ${target}${request.node ? ` on ${request.node}` : ""}`);
  if (request.services.length > 0) lines.push(`- Services: ${request.services.join(", ")}`);
  if (request.requestedPorts.length > 0) {
    lines.push(`- Firewall ports: ${request.requestedPorts.join(", ")}`);
  }
  if (request.assetDescription) lines.push(`- Generated image: ${request.assetDescription}`);
  if (request.domain) lines.push(`- Domain: ${request.domain}`);
  return lines.join("\n");
}
