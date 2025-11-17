/**
 * Entity Disambiguation Layer - Entity Normalization
 * Task 6.3: Entity Normalization Function
 */

import { pceLogger } from "../../utils/logger";

/**
 * Normalize entity text to canonical form
 * - Lowercase
 * - Remove domain suffixes (.local, .example.com)
 * - Standardize delimiters (hyphenate, remove spaces)
 * - Remove special characters (keep alphanumeric, hyphens, dots for IPs)
 */
export function normalizeEntityText(text: string): string {
  let normalized = text.trim();

  // Lowercase
  normalized = normalized.toLowerCase();

  // Remove common domain suffixes
  normalized = normalized.replace(/\.(local|lan|internal|example\.com)$/i, "");

  // Standardize delimiters: replace underscores and spaces with hyphens
  normalized = normalized.replace(/[_\s]+/g, "-");

  // Remove multiple consecutive hyphens
  normalized = normalized.replace(/-+/g, "-");

  // Remove leading/trailing hyphens (but preserve for IP addresses)
  if (!/^\d+\./.test(normalized)) {
    normalized = normalized.replace(/^-+|-+$/g, "");
  }

  // Remove special characters except alphanumeric, hyphens, dots, and slashes (for CIDR)
  normalized = normalized.replace(/[^a-z0-9.\-\/]/g, "");

  return normalized;
}

/**
 * Generate canonical ID from normalized text and type
 */
export function generateCanonicalId(normalizedText: string, type: string): string {
  return `${type.toLowerCase()}:${normalizedText}`;
}

/**
 * Normalize and create canonical entity
 */
export function normalizeEntity(
  text: string,
  type: string
): { canonicalId: string; normalizedText: string; originalText: string } {
  const normalizedText = normalizeEntityText(text);
  const canonicalId = generateCanonicalId(normalizedText, type);

  return {
    canonicalId,
    normalizedText,
    originalText: text,
  };
}

