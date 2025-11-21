import { Redactor } from "../pce/redaction/redactor";
import { ALL_REDACTION_PATTERNS } from "../pce/redaction/patterns";

// Use all redaction patterns including Proxmox-specific patterns
const toolRedactor = new Redactor(ALL_REDACTION_PATTERNS);

/**
 * Sanitize tool payload, but allow IP addresses in DHCP lease responses
 * since IP addresses are the primary data being queried
 */
export function sanitizeToolPayload<T>(payload: T): T {
  if (payload === null || payload === undefined) {
    return payload;
  }

  // Special handling for DHCP lease responses - allow IP addresses
  if (typeof payload === "object" && payload !== null) {
    const payloadAny = payload as any;
    
    // Check if this is a DHCP lease response
    if (
      payloadAny.action === "dhcp_leases_list" ||
      (Array.isArray(payloadAny.leases) && payloadAny.leases.length > 0)
    ) {
      // For DHCP leases, only redact MAC addresses, not IP addresses
      // IP addresses are the primary data being queried
      try {
        const serialized = JSON.stringify(payload);
        // Create a temporary redactor that excludes IP patterns
        const ipPatterns = ALL_REDACTION_PATTERNS.filter(
          (p) => !p.name.toLowerCase().includes("ip") && !p.name.toLowerCase().includes("address")
        );
        const dhcpRedactor = new Redactor(ipPatterns);
        const sanitized = dhcpRedactor.redact(serialized).redactedText;
        return JSON.parse(sanitized);
      } catch {
        // If parsing fails, fall through to normal sanitization
      }
    }
  }

  if (typeof payload === "string") {
    return toolRedactor.redact(payload).redactedText as T;
  }

  if (typeof payload === "object") {
    try {
      const serialized = JSON.stringify(payload);
      const sanitized = toolRedactor.redact(serialized).redactedText;
      return JSON.parse(sanitized);
    } catch {
      return payload;
    }
  }

  return payload;
}
