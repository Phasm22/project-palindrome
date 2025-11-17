import { describe, it, expect } from "bun:test";
import { sanitizeToolPayload } from "../../src/agent/tool-sanitizer";

describe("sanitizeToolPayload", () => {
  it("redacts sensitive strings", () => {
    const payload = "password=SuperSecret123";
    const sanitized = sanitizeToolPayload(payload);
    expect(sanitized).toContain("[REDACTED_PASSWORD]");
  });

  it("redacts sensitive data inside objects", () => {
    const payload = { email: "user@example.com" };
    const sanitized = sanitizeToolPayload(payload) as { email: string };
    expect(sanitized.email).toBe("[REDACTED_EMAIL]");
  });
});
