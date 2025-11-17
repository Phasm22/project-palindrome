/**
 * Document Lifecycle Management - Raw Document Storage
 * Task 1.4: Raw Document Storage
 */

import { promises as fs } from "fs";
import { join, dirname, basename } from "path";
import { pceLogger } from "../utils/logger";
import { generateSHA256Hash } from "./hash";

const RAW_STORAGE_PATH = process.env.PCE_RAW_STORAGE_PATH || "./.pce/raw-documents";

export class RawDocumentStorage {
  private storagePath: string;

  constructor(storagePath: string = RAW_STORAGE_PATH) {
    this.storagePath = storagePath;
  }

  /**
   * Initialize storage directory
   */
  async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.storagePath, { recursive: true });
      pceLogger.info(`Initialized raw document storage at: ${this.storagePath}`);
    } catch (error: any) {
      pceLogger.error("Failed to initialize raw document storage", { error: error.message });
      throw error;
    }
  }

  /**
   * Store original, unredacted document
   * Uses hash-based naming to avoid duplicates
   */
  async storeDocument(filePath: string, content: Buffer | string): Promise<string> {
    try {
      await this.initialize();
      
      const hash = typeof content === "string" 
        ? generateSHA256Hash(content) 
        : generateSHA256Hash(content);
      
      // Store with hash as filename, preserve extension if possible
      const ext = filePath.includes(".") ? filePath.split(".").pop() : "txt";
      const storageFileName = `${hash}.${ext}`;
      const storagePath = join(this.storagePath, storageFileName);

      // Only write if file doesn't exist (deduplication)
      try {
        await fs.access(storagePath);
        pceLogger.debug(`Document already stored: ${storageFileName}`);
      } catch {
        // File doesn't exist, write it
        if (typeof content === "string") {
          await fs.writeFile(storagePath, content, "utf-8");
        } else {
          await fs.writeFile(storagePath, content);
        }
        pceLogger.info(`Stored raw document: ${storageFileName}`, { originalPath: filePath });
      }

      return storagePath;
    } catch (error: any) {
      pceLogger.error(`Failed to store document: ${filePath}`, { error: error.message });
      throw error;
    }
  }

  /**
   * Store document from file path
   */
  async storeDocumentFromFile(filePath: string): Promise<string> {
    try {
      const content = await fs.readFile(filePath);
      return await this.storeDocument(filePath, content);
    } catch (error: any) {
      pceLogger.error(`Failed to store document from file: ${filePath}`, { error: error.message });
      throw error;
    }
  }

  /**
   * Retrieve stored document by hash
   */
  async retrieveDocument(hash: string, extension: string = "txt"): Promise<Buffer> {
    try {
      const storagePath = join(this.storagePath, `${hash}.${extension}`);
      return await fs.readFile(storagePath);
    } catch (error: any) {
      pceLogger.error(`Failed to retrieve document: ${hash}`, { error: error.message });
      throw error;
    }
  }

  /**
   * Check if document exists in storage
   */
  async documentExists(hash: string, extension: string = "txt"): Promise<boolean> {
    try {
      const storagePath = join(this.storagePath, `${hash}.${extension}`);
      await fs.access(storagePath);
      return true;
    } catch {
      return false;
    }
  }
}

