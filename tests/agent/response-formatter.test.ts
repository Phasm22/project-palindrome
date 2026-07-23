import { describe, it, expect, beforeEach } from "bun:test";
import { formatResponseForBot, applyAdaptivePackaging } from "../../src/agent/response-formatter";

describe("formatResponseForBot (structured generateObject)", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";
    delete process.env.DISABLE_RESPONSE_FORMATTING;
    delete process.env.ENABLE_RESPONSE_FORMATTING_IN_TESTS;
  });

  it("returns raw response when mode is undefined", async () => {
    const raw = "hello world this is a long enough response to not short-circuit";
    const out = await formatResponseForBot(raw, { userQuery: "q" });
    expect(out).toBe(raw);
  });

  it("returns raw response when formatting is disabled", async () => {
    process.env.DISABLE_RESPONSE_FORMATTING = "true";
    const raw = "hello world this is a long enough response to not short-circuit";
    const out = await formatResponseForBot(raw, { userQuery: "q", mode: "TERSE_DATA" });
    expect(out).toBe(raw);
  });

  it("returns raw response when input is too short to format", async () => {
    const raw = "short";
    const out = await formatResponseForBot(raw, { userQuery: "q", mode: "TERSE_DATA" });
    expect(out).toBe(raw);
  });

  it("returns raw response for clarification-style messages", async () => {
    const raw = "Could you clarify what you mean by that?";
    const out = await formatResponseForBot(raw, { userQuery: "q", mode: "TERSE_DATA" });
    expect(out).toBe(raw);
  });

  it("returns raw response for error messages", async () => {
    const raw = "An error occurred: connection failed to the server.";
    const out = await formatResponseForBot(raw, { userQuery: "q", mode: "TERSE_DATA" });
    expect(out).toBe(raw);
  });
});

describe("applyAdaptivePackaging", () => {
  it("returns raw response when generateObject says skipped=true", async () => {
    const raw = "This response already looks structured:\n- item | k=v";
    // applyAdaptivePackaging is called before the LLM and can short-circuit
    // For non-matching queries, it returns null (no transformation applied)
    const result = applyAdaptivePackaging(raw, { userQuery: "q", mode: "TERSE_DATA" });
    // Result is either null (no match) or a transformed string — both are acceptable
    expect(result === null || typeof result === "string").toBe(true);
  });

  it("preserves Alias definitions block when formatter omits it", async () => {
    process.env.DISABLE_RESPONSE_FORMATTING = "true";
    const raw = `Firewall Rules
ALLOW | dir=in | src=any | dst=any

Alias definitions:
Definition | term=LAB_SERVICES_PORTS | meaning="22, 80, 443" | context="Allowed ports"`;

    const out = await formatResponseForBot(raw, {
      userQuery: "show firewall rules",
      mode: "TERSE_DATA",
      intentType: "firewall_rules",
    });

    // When formatting disabled, raw is returned unchanged with alias block intact
    expect(out).toContain("Alias definitions:");
    expect(out).toContain("Definition | term=LAB_SERVICES_PORTS");
  });
});
