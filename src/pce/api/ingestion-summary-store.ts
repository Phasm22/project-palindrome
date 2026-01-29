import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { pceLogger } from "../utils/logger";

export type ExposureSnapshotEntry = {
  vmId: string;
  vmName: string;
  subnet: string;
  subnetId: string;
  allowedBy: string[];
  blockedBy: string[];
};

export type ExposureSummary = {
  id: string;
  createdAt: Date;
  newlyExposed: ExposureSnapshotEntry[];
  newlyBlocked: ExposureSnapshotEntry[];
  snapshot: ExposureSnapshotEntry[];
};

export class IngestionSummaryStore {
  private db: Database;
  private dbPath: string;

  constructor(dbPath: string = ".pce-dashboard/ingestion-summaries.db") {
    this.dbPath = dbPath;
    try {
      mkdirSync(dirname(this.dbPath), { recursive: true });
    } catch (error: any) {
      if (error.code !== "EEXIST") {
        pceLogger.error("Failed to create ingestion summary store directory", { error: error.message });
      }
    }
    this.db = new Database(this.dbPath);
    this.initializeSchema();
  }

  private initializeSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ingestion_summaries (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        summary_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ingestion_summaries_created_at
        ON ingestion_summaries(created_at);
    `);
  }

  async saveSummary(summary: Omit<ExposureSummary, "id">): Promise<string> {
    const id = crypto.randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO ingestion_summaries (
        id,
        created_at,
        summary_json
      )
      VALUES (?, ?, ?)
    `);
    stmt.run(id, summary.createdAt.getTime(), JSON.stringify(summary));
    return id;
  }

  async getLatestSummary(): Promise<ExposureSummary | null> {
    const stmt = this.db.prepare(`
      SELECT summary_json
      FROM ingestion_summaries
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const row = stmt.get() as any;
    if (!row?.summary_json) return null;
    const parsed = JSON.parse(row.summary_json);
    return this.parseSummary(parsed);
  }

  async listSummaries(limit: number = 5): Promise<ExposureSummary[]> {
    const stmt = this.db.prepare(`
      SELECT summary_json
      FROM ingestion_summaries
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as any[];
    return rows
      .map((row) => {
        try {
          return this.parseSummary(JSON.parse(row.summary_json));
        } catch {
          return null;
        }
      })
      .filter((summary): summary is ExposureSummary => Boolean(summary));
  }

  close(): void {
    this.db.close();
  }

  private parseSummary(payload: any): ExposureSummary {
    return {
      id: payload.id ?? crypto.randomUUID(),
      createdAt: payload.createdAt ? new Date(payload.createdAt) : new Date(),
      newlyExposed: payload.newlyExposed ?? [],
      newlyBlocked: payload.newlyBlocked ?? [],
      snapshot: payload.snapshot ?? [],
    };
  }
}
