import { Redactor } from "../pce/redaction/redactor";
import { ALL_REDACTION_PATTERNS } from "../pce/redaction/patterns";

// Use all redaction patterns including Proxmox-specific patterns
const toolRedactor = new Redactor(ALL_REDACTION_PATTERNS);

/**
 * Sanitize tool payload before sending to LLM.
 * 
 * REDACTION PHILOSOPHY:
 * - Redact truly sensitive data: API keys, passwords, tokens, SSH keys, credit cards
 * - DO NOT redact infrastructure identifiers: IP addresses, MAC addresses, hostnames, emails
 * - The LLM only sees summaries (not raw configs), and IPs/MACs are the PRIMARY data
 * - Sensitive credentials never leave the network anyway (local brain, local graph, local data)
 */
export function sanitizeToolPayload<T>(payload: T): T {
  if (payload === null || payload === undefined) {
    return payload;
  }

  if (typeof payload === "string") {
    return toolRedactor.redact(payload).redactedText as T;
  }

  if (typeof payload === "object") {
    try {
      const serialized = JSON.stringify(payload, (_key, value) =>
        typeof value === "string"
          ? toolRedactor.redact(value).redactedText
          : value
      );
      return JSON.parse(serialized);
    } catch {
      return payload;
    }
  }

  return payload;
}
