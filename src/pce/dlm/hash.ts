/**
 * Document Lifecycle Management - Hashing Module
 * Task 1.1: Implement SHA-256 Hashing
 */

import { createHash } from "crypto";
import { pceLogger } from "../utils/logger";

/**
 * Generate a consistent SHA-256 hash for any input document byte stream
 */
export function generateSHA256Hash(data: Buffer | string): string {
  const hash = createHash("sha256");
  
  if (typeof data === "string") {
    hash.update(data, "utf8");
  } else {
    hash.update(data);
  }
  
  return hash.digest("hex");
}

/**
 * Generate hash from file path (reads file and hashes contents)
 */
export async function hashFile(filePath: string): Promise<string> {
  try {
    const fs = await import("fs/promises");
    const fileContent = await fs.readFile(filePath);
    const hash = generateSHA256Hash(fileContent);
    
    pceLogger.debug(`Generated hash for file: ${filePath}`, { hash });
    return hash;
  } catch (error: any) {
    pceLogger.error(`Failed to hash file: ${filePath}`, { error: error.message });
    throw error;
  }
}

/**
 * Generate hash from string content
 */
export function hashString(content: string): string {
  return generateSHA256Hash(content);
}

