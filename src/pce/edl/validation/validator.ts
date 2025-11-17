/**
 * Entity Disambiguation Layer - Entity Type Validation
 * Task 6.2: Entity Type Validation Layer
 */

import type { NodeType } from "../../kg/schema";
import { pceLogger } from "../../utils/logger";

/**
 * IP Address validation regex
 */
const IP_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;
const CIDR_REGEX = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

/**
 * Hostname validation regex
 */
const HOSTNAME_REGEX = /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$/;

/**
 * Port number validation
 */
const PORT_REGEX = /^\d{1,5}$/;
const VALID_PORT_RANGE = { min: 1, max: 65535 };

/**
 * Email validation regex
 */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate entity type based on text patterns
 */
export function validateEntityType(text: string, suggestedType: NodeType): {
  valid: boolean;
  correctedType?: NodeType;
  confidence: number;
  reason?: string;
} {
  const normalizedText = text.trim().toLowerCase();

  // IP Address patterns
  if (IP_REGEX.test(text) || CIDR_REGEX.test(text)) {
    if (suggestedType === "Host" || suggestedType === "Network") {
      return { valid: true, confidence: 0.9, correctedType: CIDR_REGEX.test(text) ? "Network" : "Host" };
    }
    return {
      valid: false,
      correctedType: CIDR_REGEX.test(text) ? "Network" : "Host",
      confidence: 0.9,
      reason: `IP/CIDR pattern suggests ${CIDR_REGEX.test(text) ? "Network" : "Host"} type`,
    };
  }

  // Hostname patterns
  if (HOSTNAME_REGEX.test(text)) {
    if (suggestedType === "Host") {
      return { valid: true, confidence: 0.85 };
    }
    return {
      valid: false,
      correctedType: "Host",
      confidence: 0.85,
      reason: "Hostname pattern suggests Host type",
    };
  }

  // Port number patterns
  if (PORT_REGEX.test(text)) {
    const port = parseInt(text, 10);
    if (port >= VALID_PORT_RANGE.min && port <= VALID_PORT_RANGE.max) {
      if (suggestedType === "Service") {
        return { valid: true, confidence: 0.7 };
      }
      return {
        valid: false,
        correctedType: "Service",
        confidence: 0.7,
        reason: "Port number suggests Service type",
      };
    }
  }

  // Email patterns
  if (EMAIL_REGEX.test(text)) {
    if (suggestedType === "User") {
      return { valid: true, confidence: 0.8 };
    }
    return {
      valid: false,
      correctedType: "User",
      confidence: 0.8,
      reason: "Email pattern suggests User type",
    };
  }

  // VLAN ID patterns (numeric, typically 1-4094)
  if (/^\d+$/.test(text)) {
    const num = parseInt(text, 10);
    if (num >= 1 && num <= 4094) {
      if (suggestedType === "VLAN") {
        return { valid: true, confidence: 0.75 };
      }
      // Could be VLAN, but not definitive
    }
  }

  // Alert keywords
  if (/(alert|warning|error|critical|severity)/i.test(text)) {
    if (suggestedType === "Alert") {
      return { valid: true, confidence: 0.7 };
    }
  }

  // Service keywords
  if (/(http|https|ssh|ftp|smtp|dns|service|port)/i.test(text)) {
    if (suggestedType === "Service") {
      return { valid: true, confidence: 0.7 };
    }
  }

  // Default: accept if no strong contradiction
  return { valid: true, confidence: 0.5 };
}

/**
 * Validate and correct entity types in extraction results
 */
export function validateExtractionResults(
  entities: Array<{ text: string; type: NodeType; confidence: number }>
): Array<{ text: string; type: NodeType; confidence: number; corrected: boolean }> {
  return entities.map((entity) => {
    const validation = validateEntityType(entity.text, entity.type);

    if (!validation.valid && validation.correctedType) {
      pceLogger.debug(`Corrected entity type: "${entity.text}" from ${entity.type} to ${validation.correctedType}`, {
        reason: validation.reason,
      });
      return {
        ...entity,
        type: validation.correctedType,
        confidence: Math.min(entity.confidence, validation.confidence),
        corrected: true,
      };
    }

    return {
      ...entity,
      confidence: Math.max(entity.confidence, validation.confidence),
      corrected: false,
    };
  });
}

