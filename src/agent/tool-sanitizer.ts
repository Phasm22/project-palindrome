import { Redactor } from "../pce/redaction/redactor";

const toolRedactor = new Redactor();

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
