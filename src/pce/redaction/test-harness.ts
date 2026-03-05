/**
 * Redaction Pipeline - Unit Test Harness
 * Task 2.4: Redaction Unit-Test Harness
 */

import { Redactor } from "./redactor";
import { pceLogger } from "../utils/logger";

export interface TestCase {
  name: string;
  input: string;
  expectedRedactions: string[]; // Pattern names that should be detected
  shouldContainSensitive: boolean;
}

export const TEST_CASES: TestCase[] = [
  {
    name: "API Key Detection",
    input: 'const apiKey = "sk_live_1234567890abcdefghijklmnopqrstuvwxyz";',
    expectedRedactions: ["api_key_generic"],
    shouldContainSensitive: true,
  },
  {
    name: "AWS Credentials",
    input: 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    expectedRedactions: ["aws_access_key", "aws_secret_key"],
    shouldContainSensitive: true,
  },
  {
    name: "Email Address Preserved",
    input: "Contact us at support@example.com for help.",
    expectedRedactions: [],
    shouldContainSensitive: false,
  },
  {
    name: "Private IP Preserved",
    input: "Server is at 192.168.1.100",
    expectedRedactions: [],
    shouldContainSensitive: false,
  },
  {
    name: "Password Field",
    input: 'password: "MySecretPassword123!"',
    expectedRedactions: ["password"],
    shouldContainSensitive: true,
  },
  {
    name: "JWT Token",
    input: "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    expectedRedactions: ["jwt_token"],
    shouldContainSensitive: true,
  },
  {
    name: "Clean Text",
    input: "This is a normal document with no sensitive information.",
    expectedRedactions: [],
    shouldContainSensitive: false,
  },
];

/**
 * Run redaction test harness
 * Verifies no sensitive patterns leak before production indexing
 */
export function runRedactionTests(redactor: Redactor = new Redactor()): {
  passed: number;
  failed: number;
  results: Array<{
    testCase: string;
    passed: boolean;
    issues: string[];
  }>;
} {
  const results: Array<{
    testCase: string;
    passed: boolean;
    issues: string[];
  }> = [];

  let passed = 0;
  let failed = 0;

  for (const testCase of TEST_CASES) {
    const issues: string[] = [];

    // Check if sensitive data is detected
    const containsSensitive = redactor.containsSensitiveData(testCase.input);
    if (containsSensitive !== testCase.shouldContainSensitive) {
      issues.push(
        `Sensitive data detection mismatch: expected ${testCase.shouldContainSensitive}, got ${containsSensitive}`
      );
    }

    // Redact and verify patterns
    const result = redactor.redact(testCase.input);
    const redactedPatterns = result.redactions.map((r) => r.pattern);

    // Check if all expected patterns were redacted
    for (const expectedPattern of testCase.expectedRedactions) {
      if (!redactedPatterns.includes(expectedPattern)) {
        issues.push(`Expected pattern '${expectedPattern}' was not redacted`);
      }
    }

    // Verify no sensitive data remains
    if (redactor.containsSensitiveData(result.redactedText)) {
      issues.push("Redacted text still contains sensitive data!");
    }

    // Verify original sensitive patterns are not in redacted text
    const originalLower = testCase.input.toLowerCase();
    const redactedLower = result.redactedText.toLowerCase();
    
    // Check for common sensitive indicators that shouldn't be in redacted text
    if (testCase.shouldContainSensitive) {
      // The redacted text should not contain the original sensitive values
      // This is a basic check - in production, you'd want more sophisticated verification
      if (originalLower === redactedLower && testCase.expectedRedactions.length > 0) {
        issues.push("Redacted text is identical to input - redaction may have failed");
      }
    }

    const testPassed = issues.length === 0;
    if (testPassed) {
      passed++;
    } else {
      failed++;
    }

    results.push({
      testCase: testCase.name,
      passed: testPassed,
      issues,
    });

    pceLogger.info(`Test: ${testCase.name} - ${testPassed ? "PASSED" : "FAILED"}`, {
      issues: issues.length > 0 ? issues : undefined,
    });
  }

  pceLogger.info(`Redaction test harness completed: ${passed} passed, ${failed} failed`);

  return { passed, failed, results };
}
