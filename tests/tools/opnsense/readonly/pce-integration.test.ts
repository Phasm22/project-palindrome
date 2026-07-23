import { describe, test, expect } from "bun:test";
import { queryPCE } from "../../../../src/agent/pce-client";

/**
 * TL-1A.5: End-to-End PCE Validation
 * 
 * This test verifies that:
 * 1. OPNsense read-only tool can be executed via PCE API
 * 2. Tool provenance tag appears in response sources
 * 3. Answer is returned successfully
 * 
 * Note: This test requires the PCE API server to be running.
 * Set PCE_API_URL environment variable if different from default.
 */
describe("TL-1A.5: End-to-End PCE Validation", () => {
  const PCE_API_URL = process.env.PCE_API_URL || "http://localhost:4000";
  const userId = process.env.PCE_USER_ID || "test-user";
  const liveEnabled = process.env.PCE_LIVE_TESTS === "true";

  test.skipIf(!liveEnabled)("should execute OPNsense tool via PCE and return provenance tag", async () => {
    const healthCheck = await fetch(`${PCE_API_URL}/health`);
    expect(healthCheck.ok).toBe(true);

    // Query that should trigger OPNsense tool usage
    // The LLM should recognize this as needing OPNsense system status
    const query = "What is the current system status of the OPNsense firewall?";

    const response = await queryPCE(userId, query);

    // Verify response structure
    expect(response).toBeDefined();
    expect(response.answer).toBeDefined();
    expect(typeof response.answer).toBe("string");

    // A successful gold path must prove that the OPNsense tool was reachable.
    const toolSource = response.sources.find((source) =>
      source.chunkId.startsWith("tool://opnsense_")
    );
    expect(toolSource).toBeDefined();
    expect(toolSource?.chunkId).toMatch(/^tool:\/\/opnsense_/);

    expect(response.answer.toLowerCase()).toMatch(/opnsense|firewall/);
  }, 30000); // 30 second timeout for LLM calls

  test.skipIf(!liveEnabled)("should handle OPNsense-specific queries", async () => {
    const healthCheck = await fetch(`${PCE_API_URL}/health`);
    expect(healthCheck.ok).toBe(true);

    // More specific query that should definitely trigger OPNsense tool
    const query = "List all firewall rules on the OPNsense firewall";

    const response = await queryPCE(userId, query);

    // Verify response
    expect(response).toBeDefined();
    expect(response.answer).toBeDefined();
    expect(typeof response.answer).toBe("string");

    const toolSource = response.sources.find((source) =>
      source.chunkId.startsWith("tool://opnsense_")
    );
    expect(toolSource).toBeDefined();
    expect(toolSource?.chunkId).toMatch(/^tool:\/\/opnsense_/);
    expect(response.answer.toLowerCase()).toContain("rule");
  }, 30000);
});
