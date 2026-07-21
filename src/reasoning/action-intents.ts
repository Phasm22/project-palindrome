/**
 * Action Intent Detection
 * 
 * Detects user intents for infrastructure actions (create VM, configure network, etc.)
 */

export type ActionIntent =
  | { type: "create_vm"; name: string; node: string }
  | { type: "destroy_vm"; name?: string; vmId?: number; node?: string }
  | { type: "start_vm"; name: string }
  | { type: "stop_vm"; name: string }
  | { type: "restart_vm"; name: string }
  | { type: "sync_dhcp_to_dns" }
  | { type: "install_service"; service: string; vmName: string }
  | { type: "configure_firewall"; vmName: string }
  | { type: "set_static_ip"; vmName: string; ip?: string; gateway?: string };

export function extractCreateVmParameters(text: string): {
  cores?: number;
  memory?: number;
  diskSize?: string;
  sshUsername?: string;
} {
  const coreMatch = text.match(/\b(\d+)\s*(?:v?cpus?|cores?)\b/i);
  const memoryMatch = text.match(/\b(\d+)\s*(mb|gb)\s*(?:of\s+)?(?:ram|memory)\b/i);
  const diskMatch = text.match(/\b(\d+)\s*(g|gb)\s*(?:of\s+)?(?:disk|storage)\b/i);
  const sshUserMatch = text.match(/\bssh\s+(?:user|username)\s*(?:is|=|:)?\s*([a-z_][a-z0-9_-]*)\b/i);
  const memoryValue = memoryMatch
    ? Number(memoryMatch[1]) * (memoryMatch[2]?.toLowerCase() === "gb" ? 1024 : 1)
    : undefined;
  return {
    ...(coreMatch ? { cores: Number(coreMatch[1]) } : {}),
    ...(memoryValue ? { memory: memoryValue } : {}),
    ...(diskMatch ? { diskSize: `${diskMatch[1]}G` } : {}),
    ...(sshUserMatch ? { sshUsername: sshUserMatch[1] } : {}),
  };
}

function isLikelyQuestion(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (normalized.endsWith("?")) return true;
  return /^(what|which|who|where|when|why|how|is|are|do|does|can|could|would|will)\b/.test(normalized);
}

/** Real VM/hostnames are always short, single-token identifiers (see MIN_PLAUSIBLE_NAME_LENGTH usage below). */
const MIN_PLAUSIBLE_NAME_LENGTH = 3;

/**
 * Rejects candidates too short/implausible to be a real VM name. Adversarial
 * or garbled input (e.g. injected Cypher/SQL text) can coincidentally leave
 * a single stray character right after a verb like "delete", which would
 * otherwise be extracted as if it were a legitimate resolved target name.
 */
function isPlausibleNameCandidate(candidate: string | null): candidate is string {
  return !!candidate && candidate.trim().length >= MIN_PLAUSIBLE_NAME_LENGTH;
}

/**
 * Common, unambiguous imperative-command openers ("please destroy X", "can
 * you delete X", "I need to remove X"). Used to decide whether a leading
 * destroy/delete/remove verb is genuinely the user's command, not a verb
 * that merely occurs somewhere inside a longer sentence, a rhetorical/
 * hypothetical mention ("hypothetically, delete pihole..."), or a quoted /
 * injected payload (e.g. "find the vm named '... DETACH DELETE n //").
 */
const COMMAND_OPENER_WORDS = new Set([
  "please", "can", "could", "would", "will", "you", "i", "we", "want",
  "need", "have", "to", "go", "ahead", "and", "kindly", "just", "now",
  "let's", "let", "us", "should", "gonna",
]);
const DESTRUCTIVE_VERB_LEAD_WORDS = 6;

function stripWordPunctuation(word: string): string {
  return word.replace(/^[.,!?;:'"]+|[.,!?;:'"]+$/g, "");
}

/**
 * True only if destroy/delete/remove appears as the leading verb of an
 * imperative command — i.e. every word before it (within a short lead
 * window) is a recognized command-opener. Anything else preceding the verb
 * (a query verb like "find", a hedge like "hypothetically", injected text,
 * etc.) fails this check, so the caller falls through to the slower but
 * more accurate LLM-classification path instead of this regex fast path.
 */
function hasLeadingDestructiveVerb(text: string): boolean {
  const rawWords = text.trim().toLowerCase().split(/\s+/).slice(0, DESTRUCTIVE_VERB_LEAD_WORDS);
  for (const rawWord of rawWords) {
    const word = stripWordPunctuation(rawWord);
    if (word === "destroy" || word === "delete" || word === "remove") return true;
    if (!COMMAND_OPENER_WORDS.has(word)) return false;
  }
  return false;
}

function normalizeVmNameCandidate(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  const cleaned = candidate
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim()
    .replace(/[.,!?;:]+$/g, "");
  return cleaned.length > 0 ? cleaned : null;
}

function extractRegexCandidate(match: RegExpMatchArray | null): string | null {
  if (!match) return null;
  for (let i = 1; i < match.length; i++) {
    const candidate = normalizeVmNameCandidate(match[i]);
    if (candidate) return candidate;
  }
  return null;
}

function extractCreateVmName(text: string): string | null {
  const explicitNamePattern =
    /\b(?:vm|virtual machine)\b(?:[^\n]{0,80}?)\b(?:named|called|with\s+name|name(?:\s+is|=|:)?|hostname(?:\s+is|=|:)?)\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([a-z0-9][a-z0-9._-]*))/i;
  const explicitName = extractRegexCandidate(text.match(explicitNamePattern));
  if (explicitName) return explicitName;

  const trailingNamePattern =
    /\b(?:create|make|provision|spin up)\b(?:[^\n]{0,120}?)\b(?:named|called|with\s+name|name(?:\s+is|=|:)?|hostname(?:\s+is|=|:)?)\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([a-z0-9][a-z0-9._-]*))/i;
  const trailingName = extractRegexCandidate(text.match(trailingNamePattern));
  if (trailingName) return trailingName;

  const inlineNamePattern =
    /\b(?:create|make|provision|spin up)\s+(?:a|an|new)?\s*(?:vm|virtual machine)\s+(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([a-z0-9][a-z0-9._-]*))/i;
  const inlineName = extractRegexCandidate(text.match(inlineNamePattern));
  if (!inlineName) return null;

  const stopwords = new Set([
    "on",
    "in",
    "at",
    "with",
    "for",
    "to",
    "from",
    "using",
    "via",
    "named",
    "called",
    "name",
    "hostname",
    "node",
    "vm",
    "virtual",
    "machine",
    "the",
    "a",
    "an",
    "my",
    "your",
    "our",
  ]);
  if (stopwords.has(inlineName.toLowerCase())) return null;
  return inlineName;
}

function extractVmName(text: string): string | null {
  // Match patterns like "create VM named X", "create a VM called X", "VM named X"
  const namedMatch = text.match(/\b(?:vm|virtual machine)\s+(?:named|called|with name)\s+([a-z0-9\-_]+)/i);
  const namedCandidate = namedMatch?.[1] ?? null;
  if (isPlausibleNameCandidate(namedCandidate)) {
    return namedCandidate;
  }

  // Match patterns like "destroy X", "delete X", "remove X" where X is a VM name
  const destroyMatch = text.match(
    /\b(?:destroy|delete|remove)\s+(?:(?:the|a|an)\s+)?(?:(?:vm|virtual\s+machine|container|lxc)\s+)?([a-z0-9][a-z0-9._-]*)/i
  );
  const destroyCandidate = destroyMatch?.[1] ?? null;
  if (isPlausibleNameCandidate(destroyCandidate)) {
    return destroyCandidate;
  }

  // Match patterns like "restart X", "start X", "stop X", "reboot X" where X is a VM name
  // These are common patterns for VM lifecycle operations
  const lifecycleMatch = text.match(/\b(?:restart|start|stop|reboot|shutdown)\s+(?:vm\s+)?([a-z0-9\-_]+)/i);
  const lifecycleCandidate = lifecycleMatch?.[1] ?? null;
  if (isPlausibleNameCandidate(lifecycleCandidate)) {
    return lifecycleCandidate;
  }

  return null;
}

function extractVmId(text: string): number | null {
  // Match patterns like "vm 104", "vmid 104", "vm id 104", "virtual machine 104"
  const vmIdMatch = text.match(/\b(?:vm|vmid|vm\s+id|virtual\s+machine)\s+(\d+)/i);
  if (vmIdMatch?.[1]) {
    return parseInt(vmIdMatch[1], 10);
  }

  // Match standalone numbers after destroy/delete/remove
  const destroyIdMatch = text.match(
    /\b(?:destroy|delete|remove)\s+(?:(?:the|a|an)\s+)?(?:(?:vm|virtual\s+machine|container|lxc)\s+)?(\d+)/i
  );
  if (destroyIdMatch?.[1]) {
    return parseInt(destroyIdMatch[1], 10);
  }

  return null;
}

function extractNodeName(text: string): string | null {
  // Match patterns like "on node X", "on X", "in X", "node X"
  const onMatch = text.match(/\b(?:on|in)\s+(?:node\s+)?([a-z0-9\-_]+)/i);
  if (onMatch) {
    return onMatch[1] ?? null;
  }

  // Also try "node X" pattern
  const nodeMatch = text.match(/\bnode\s+([a-z0-9\-_]+)/i);
  if (nodeMatch) {
    return nodeMatch[1] ?? null;
  }

  return null;
}

/**
 * Detect action intent from user input
 */
export function detectActionIntent(userInput: string): ActionIntent | null {
  const normalized = userInput.toLowerCase();
  const isQuestion = isLikelyQuestion(userInput);

  // Create VM
  if (
    (
      normalized.includes("create") ||
      normalized.includes("creation") ||
      normalized.includes("make") ||
      normalized.includes("spin up") ||
      normalized.includes("provision")
    ) &&
    (normalized.includes("vm") || normalized.includes("virtual machine"))
  ) {
    const vmName = extractCreateVmName(userInput) || extractVmName(userInput);
    const nodeName = extractNodeName(userInput);

    // Node name is required, VM name is optional (will be auto-generated)
    if (nodeName) {
      return { type: "create_vm", name: vmName || "", node: nodeName };
    }
  }

  // Destroy/Delete VM
  if (!isQuestion && hasLeadingDestructiveVerb(userInput)) {
    const nodeName = extractNodeName(userInput) || undefined;
    // Try to extract VM ID first (more specific)
    const vmId = extractVmId(userInput);
    if (vmId) {
      return { type: "destroy_vm", vmId, node: nodeName };
    }
    
    // Fall back to VM name extraction
    const vmName = extractVmName(userInput);
    if (vmName) {
      return { type: "destroy_vm", name: vmName, node: nodeName };
    }
  }

  // Start VM
  if (
    (normalized.includes("start") || normalized.includes("boot")) &&
    (normalized.includes("vm") || normalized.includes("virtual machine"))
  ) {
    const vmName = extractVmName(userInput);
    if (vmName) {
      return { type: "start_vm", name: vmName };
    }
  }

  // Stop VM
  if (
    (normalized.includes("stop") || normalized.includes("shutdown")) &&
    (normalized.includes("vm") || normalized.includes("virtual machine"))
  ) {
    const vmName = extractVmName(userInput);
    if (vmName) {
      return { type: "stop_vm", name: vmName };
    }
  }

  // Restart/Reboot VM
  if (
    (normalized.includes("restart") || normalized.includes("reboot")) &&
    (normalized.includes("vm") || normalized.includes("virtual machine") || normalized.match(/\b\w+\b/))
  ) {
    const vmName = extractVmName(userInput);
    if (vmName) {
      return { type: "restart_vm", name: vmName };
    }
  }

  // Sync DHCP to DNS
  if (
    (normalized.includes("sync") || normalized.includes("update") || normalized.includes("register")) &&
    (normalized.includes("dhcp") || normalized.includes("lease")) &&
    (normalized.includes("dns") || normalized.includes("domain"))
  ) {
    return { type: "sync_dhcp_to_dns" };
  }

  // Install service (nginx, docker, etc.)
  if (
    (normalized.includes("install") || normalized.includes("setup") || normalized.includes("add")) &&
    (normalized.includes("nginx") || normalized.includes("docker") || normalized.includes("service"))
  ) {
    const vmName = extractVmName(userInput) || extractVmNameFromContext(userInput);
    if (vmName) {
      let service = "unknown";
      if (normalized.includes("nginx")) service = "nginx";
      else if (normalized.includes("docker")) service = "docker";
      
      return { type: "install_service", service, vmName };
    }
  }

  // Configure firewall (action, not query)
  // Match patterns like "configure firewall", "setup firewall", "allow port", "open port"
  // Priority: Check for action keywords first (configure/setup/allow/open) before query keywords
  const hasActionKeyword = 
    normalized.includes("configure") || 
    normalized.includes("setup") || 
    normalized.includes("set") ||
    normalized.includes("allow") ||
    normalized.includes("open");
  
  const hasFirewallKeyword = 
    normalized.includes("firewall") || 
    normalized.includes("ufw") ||
    normalized.includes("port");
  
  // Question-style requests like "what ports are allowed..." are informational queries.
  if (!isQuestion && hasActionKeyword && hasFirewallKeyword) {
    const vmName = extractVmName(userInput) || extractVmNameFromContext(userInput);
    if (vmName) {
      return { type: "configure_firewall", vmName };
    }
  }

  // Set static IP
  if (
    (normalized.includes("set") || normalized.includes("configure") || normalized.includes("assign")) &&
    (normalized.includes("static") || normalized.includes("ip") || normalized.includes("address"))
  ) {
    const vmName = extractVmName(userInput) || extractVmNameFromContext(userInput);
    if (vmName) {
      // Try to extract IP and gateway if provided
      const ipMatch = userInput.match(/\b(\d+\.\d+\.\d+\.\d+\/\d+)\b/);
      const gatewayMatch = userInput.match(/\bgateway\s+(\d+\.\d+\.\d+\.\d+)\b/i);
      
      return {
        type: "set_static_ip",
        vmName,
        ip: ipMatch ? ipMatch[1] : undefined,
        gateway: gatewayMatch ? gatewayMatch[1] : undefined,
      };
    }
  }

  return null;
}

/**
 * Extract VM name from context (e.g., "install nginx on aha")
 */
function extractVmNameFromContext(text: string): string | null {
  // Match patterns like "on X", "for X", "to X" where X is a VM name
  const onMatch = text.match(/\b(?:on|for|to)\s+(?:vm\s+)?([a-z0-9\-_]+)/i);
  if (onMatch) {
    const candidate = onMatch[1]?.toLowerCase();
    if (!candidate) return null;
    const stopwords = new Set(["the", "a", "an", "my", "your", "our", "this", "that"]);
    if (stopwords.has(candidate)) return null;
    return candidate;
  }
  return null;
}
