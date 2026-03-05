/**
 * PCE Redaction Tests
 */

import { describe, it, expect } from "bun:test";
import { Redactor, runRedactionTests } from "../../src/pce/redaction";

describe("Redaction Pipeline", () => {
  it("should redact API keys", () => {
    const redactor = new Redactor();
    const text = 'const apiKey = "sk_live_1234567890abcdefghijklmnopqrstuvwxyz";';
    
    const result = redactor.redact(text);
    
    expect(result.redactedText).not.toContain("sk_live_");
    expect(result.redactedText).toContain("[REDACTED_API_KEY]");
    expect(result.redactions.length).toBeGreaterThan(0);
  });

  it("should preserve email addresses used as infrastructure identifiers", () => {
    const redactor = new Redactor();
    const text = "Contact support@example.com for help.";
    
    const result = redactor.redact(text);
    
    expect(result.redactedText).toBe(text);
    expect(result.redactions).toHaveLength(0);
  });

  it("should redact passwords", () => {
    const redactor = new Redactor();
    const text = 'password: "MySecretPassword123!"';
    
    const result = redactor.redact(text);
    
    expect(result.redactedText).not.toContain("MySecretPassword123!");
    expect(result.redactedText).toContain("[REDACTED_PASSWORD]");
  });

  it("should not redact clean text", () => {
    const redactor = new Redactor();
    const text = "This is a normal document with no sensitive information.";
    
    const result = redactor.redact(text);
    
    expect(result.redactedText).toBe(text);
    expect(result.redactions.length).toBe(0);
  });

  it("should pass redaction test harness", () => {
    const redactor = new Redactor();
    const results = runRedactionTests(redactor);
    
    expect(results.failed).toBe(0);
    expect(results.passed).toBeGreaterThan(0);
  });
});

describe("Chunking", () => {
  it("should chunk generic text", async () => {
    const { chunkDocument } = await import("../../src/pce/redaction/chunker");
    
    const text = "This is a test document. ".repeat(100); // ~2800 chars
    const chunks = chunkDocument(
      text,
      "generic_text",
      {
        versionHash: "test-hash",
        aclGroup: "admin",
        sourceType: "generic_text",
        sourcePath: "test.txt",
        timestamp: new Date(),
      },
      { maxChunkSize: 500, overlapSize: 100 }
    );
    
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].text.length).toBeLessThanOrEqual(500);
  });

  it("should chunk markdown by headers", async () => {
    const { chunkDocument } = await import("../../src/pce/redaction/chunker");
    
    const text = `# Title

## Section 1
Content for section 1.

## Section 2
Content for section 2.
`;
    
    const chunks = chunkDocument(
      text,
      "markdown_runbook",
      {
        versionHash: "test-hash",
        aclGroup: "admin",
        sourceType: "markdown_runbook",
        sourcePath: "test.md",
        timestamp: new Date(),
      }
    );
    
    expect(chunks.length).toBeGreaterThan(1);
  });
});
