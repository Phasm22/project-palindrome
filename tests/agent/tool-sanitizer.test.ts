import { describe, it, expect } from "bun:test";
import { sanitizeToolPayload } from "../../src/agent/tool-sanitizer";

describe("sanitizeToolPayload", () => {
  it("redacts sensitive strings", () => {
    const payload = "password=SuperSecret123";
    const sanitized = sanitizeToolPayload(payload);
    expect(sanitized).toContain("[REDACTED_PASSWORD]");
  });

  it("does not corrupt objects (infrastructure IDs like emails/IPs are not redacted)", () => {
    // Emails, IPs, MACs are infrastructure identifiers — not sensitive secrets.
    // Sanitization applies to strings via regex; objects are passed through without JSON-corruption.
    const payload = { email: "user@example.com", host: "10.0.0.1" };
    const sanitized = sanitizeToolPayload(payload) as { email: string; host: string };
    // Object itself should not be corrupted or become undefined
    expect(sanitized).toBeDefined();
    // Infrastructure IDs are preserved as-is
    expect(sanitized.email).toBe("user@example.com");
    expect(sanitized.host).toBe("10.0.0.1");
  });
});
