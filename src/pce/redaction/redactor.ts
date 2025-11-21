/**
 * Redaction Pipeline - Core Redactor
 * Task 2.1: Pre-chunking scrubbing module
 */

import { DEFAULT_REDACTION_PATTERNS, type RedactionPattern } from "./patterns";
import { pceLogger } from "../utils/logger";

export interface RedactionResult {
  redactedText: string;
  redactions: Array<{
    pattern: string;
    originalLength: number;
    replacementLength: number;
    count: number;
  }>;
}

export class Redactor {
  private patterns: RedactionPattern[];

  constructor(patterns: RedactionPattern[] = DEFAULT_REDACTION_PATTERNS) {
    this.patterns = patterns;
  }

  /**
   * Add a custom redaction pattern
   */
  addPattern(pattern: RedactionPattern): void {
    this.patterns.push(pattern);
  }

  /**
   * Redact sensitive data from text
   */
  redact(text: string): RedactionResult {
    let redactedText = text;
    const redactions: RedactionResult["redactions"] = [];

    for (const pattern of this.patterns) {
      const matches = text.match(pattern.pattern);
      if (matches) {
        const originalLength = matches.reduce((sum, m) => sum + m.length, 0);
        
        // Support both string and function replacements
        const replacement = typeof pattern.replacement === "function"
          ? pattern.replacement
          : pattern.replacement;
        
        redactedText = redactedText.replace(pattern.pattern, replacement);
        
        // Calculate replacement length (approximate for function replacements)
        const replacementLength = typeof pattern.replacement === "function"
          ? matches.length * "[REDACTED]".length // Approximate
          : matches.length * pattern.replacement.length;
        
        redactions.push({
          pattern: pattern.name,
          originalLength,
          replacementLength,
          count: matches.length,
        });

        pceLogger.debug(`Redacted ${matches.length} matches of pattern: ${pattern.name}`);
      }
    }

    if (redactions.length > 0) {
      pceLogger.debug(`Redacted ${redactions.length} pattern types`, {
        totalRedactions: redactions.reduce((sum, r) => sum + r.count, 0),
      });
    }

    return {
      redactedText,
      redactions,
    };
  }

  /**
   * Check if text contains any sensitive patterns (without redacting)
   */
  containsSensitiveData(text: string): boolean {
    return this.patterns.some((pattern) => pattern.pattern.test(text));
  }
}

