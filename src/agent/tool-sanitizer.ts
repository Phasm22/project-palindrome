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

  // Special handling for responses where MAC addresses or IP addresses are the primary data
  if (typeof payload === "object" && payload !== null) {
    const payloadAny = payload as any;
    
    // Check if this is a diagnostic command response (ping, traceroute, http_check)
    // IP addresses are the primary data being queried in these commands
    const diagnosticCommands = ["ping", "traceroute", "http_check"];
    const isDiagnosticCommand = 
      payloadAny.command && diagnosticCommands.includes(payloadAny.command) ||
      payloadAny.data?.command && diagnosticCommands.includes(payloadAny.data?.command);
    
    if (isDiagnosticCommand) {
      // For diagnostic commands, allow IP addresses to pass through
      // They are the primary data being queried (target IPs, hop IPs, etc.)
      try {
        const serialized = JSON.stringify(payload);
        // Create a temporary redactor that excludes IP patterns
        const ipPatterns = ALL_REDACTION_PATTERNS.filter(
          (p) => !p.name.toLowerCase().includes("ip") && !p.name.toLowerCase().includes("address")
        );
        const diagnosticRedactor = new Redactor(ipPatterns);
        const sanitized = diagnosticRedactor.redact(serialized).redactedText;
        return JSON.parse(sanitized);
      } catch {
        // If parsing fails, fall through to normal sanitization
      }
    }
    
    // Check if this is a DHCP lease response - allow IP addresses
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
    
    // Check if this is a response that includes MAC addresses as primary data
    // (e.g., get_vm_ip, get_lxc_config, get_vm_network responses with macs field)
    // Also check action names that typically return MAC addresses
    const macAddressActions = ["get_vm_ip", "get_lxc_config", "get_vm_network"];
    const isMacAddressAction = payloadAny.action && macAddressActions.includes(payloadAny.action);
    
    // Check both top-level and nested data structures
    const hasMacsField = 
      payloadAny.macs ||
      payloadAny.macAddresses ||
      payloadAny.data?.macs ||
      payloadAny.data?.macAddresses ||
      (Array.isArray(payloadAny) && payloadAny.some((item: any) => 
        item.macs || item.macAddresses || item.data?.macs || item.data?.macAddresses
      )) ||
      (Array.isArray(payloadAny.data) && payloadAny.data.some((item: any) => 
        item.macs || item.macAddresses
      ));
    
    if (isMacAddressAction || hasMacsField) {
      // For MAC address queries, allow MAC addresses to pass through
      // They are the primary data being queried
      try {
        const serialized = JSON.stringify(payload);
        // Create a temporary redactor that excludes MAC patterns
        const macPatterns = ALL_REDACTION_PATTERNS.filter(
          (p) => !p.name.toLowerCase().includes("mac") && !p.name.toLowerCase().includes("hardware")
        );
        const macRedactor = new Redactor(macPatterns);
        const sanitized = macRedactor.redact(serialized).redactedText;
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
