/**
 * Document Lifecycle Management - Versioned Snapshot Log
 * Task 1.2: Versioned Snapshot Log Setup
 * Task 1.3: Change Detection Module
 */

import type { DocumentSnapshot, DocumentStatus, DocumentType, ACLGroup } from "../types";
import { hashFile } from "./hash";
import { pceLogger } from "../utils/logger";
import { promises as fs } from "fs";
import { join } from "path";

const SNAPSHOT_LOG_PATH = process.env.PCE_SNAPSHOT_LOG_PATH || "./.pce/snapshots.json";

export class SnapshotLog {
  private snapshots: Map<string, DocumentSnapshot> = new Map();
  private logPath: string;

  constructor(logPath: string = SNAPSHOT_LOG_PATH) {
    this.logPath = logPath;
  }

  /**
   * Initialize snapshot log from disk
   */
  async initialize(): Promise<void> {
    try {
      const dir = join(this.logPath, "..");
      await fs.mkdir(dir, { recursive: true });
      
      try {
        const data = await fs.readFile(this.logPath, "utf-8");
        const snapshots = JSON.parse(data) as DocumentSnapshot[];
        
        for (const snapshot of snapshots) {
          // Convert timestamp string back to Date
          snapshot.timestamp = new Date(snapshot.timestamp);
          this.snapshots.set(snapshot.filePath, snapshot);
        }
        
        pceLogger.info(`Loaded ${snapshots.length} snapshots from log`);
      } catch (error: any) {
        if (error.code === "ENOENT") {
          pceLogger.info("Snapshot log not found, starting fresh");
        } else {
          throw error;
        }
      }
    } catch (error: any) {
      pceLogger.error("Failed to initialize snapshot log", { error: error.message });
      throw error;
    }
  }

  /**
   * Save snapshot log to disk
   */
  async persist(): Promise<void> {
    try {
      const snapshots = Array.from(this.snapshots.values());
      await fs.writeFile(this.logPath, JSON.stringify(snapshots, null, 2), "utf-8");
      pceLogger.debug(`Persisted ${snapshots.length} snapshots to log`);
    } catch (error: any) {
      pceLogger.error("Failed to persist snapshot log", { error: error.message });
      throw error;
    }
  }

  /**
   * Get snapshot for a file path
   */
  getSnapshot(filePath: string): DocumentSnapshot | null {
    return this.snapshots.get(filePath) || null;
  }

  /**
   * Add or update a snapshot
   */
  async addSnapshot(snapshot: DocumentSnapshot): Promise<void> {
    const existing = this.snapshots.get(snapshot.filePath);
    this.snapshots.set(snapshot.filePath, snapshot);
    
    if (existing) {
      pceLogger.logDocumentStatusChange(snapshot.filePath, existing.sha256Hash, snapshot.sha256Hash);
    } else {
      pceLogger.logDocumentStatusChange(snapshot.filePath, null, snapshot.sha256Hash);
    }
    
    await this.persist();
  }

  /**
   * Task 1.3: Change Detection Module
   * Compare source file's current hash against Versioned Snapshot Log hash
   * Returns: NEW, MODIFIED, or UNCHANGED
   */
  async detectChange(
    filePath: string,
    documentType: DocumentType,
    aclGroup: ACLGroup
  ): Promise<{ status: DocumentStatus; snapshot: DocumentSnapshot | null; currentHash: string }> {
    try {
      const currentHash = await hashFile(filePath);
      const existingSnapshot = this.getSnapshot(filePath);

      let status: DocumentStatus;
      
      if (!existingSnapshot) {
        status = "NEW";
        pceLogger.logHashComparison(filePath, null, currentHash, status);
      } else if (existingSnapshot.sha256Hash === currentHash) {
        status = "UNCHANGED";
        pceLogger.logHashComparison(filePath, existingSnapshot.sha256Hash, currentHash, status);
      } else {
        status = "MODIFIED";
        pceLogger.logHashComparison(filePath, existingSnapshot.sha256Hash, currentHash, status);
      }

      // Get file stats for size
      const stats = await fs.stat(filePath);

      // Create/update snapshot
      const snapshot: DocumentSnapshot = {
        filePath,
        sha256Hash: currentHash,
        timestamp: new Date(),
        aclGroup,
        documentType,
        size: stats.size,
      };

      if (status !== "UNCHANGED") {
        await this.addSnapshot(snapshot);
      }

      return { status, snapshot: existingSnapshot, currentHash };
    } catch (error: any) {
      pceLogger.error(`Failed to detect change for ${filePath}`, { error: error.message });
      throw error;
    }
  }

  /**
   * Get all snapshots
   */
  getAllSnapshots(): DocumentSnapshot[] {
    return Array.from(this.snapshots.values());
  }
}

