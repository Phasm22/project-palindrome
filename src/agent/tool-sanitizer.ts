import { Redactor } from "../pce/redaction/redactor";
import { ALL_REDACTION_PATTERNS } from "../pce/redaction/patterns";

// Use all redaction patterns including Proxmox-specific patterns
const toolRedactor = new Redactor(ALL_REDACTION_PATTERNS);

export function sanitizeToolPayload<T>(payload: T): T {
  if (payload === null || payload === undefined) {
    return payload;
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
