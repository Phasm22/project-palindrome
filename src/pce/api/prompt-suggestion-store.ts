import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { pceLogger } from "../utils/logger";

export interface PromptSuggestion {
  id: string;
  title: string;
  prompt: string;
}

export interface PromptSuggestionBatch {
  id: string;
  generatedAt: Date;
  source: string;
  suggestions: PromptSuggestion[];
  context?: Record<string, unknown>;
}

export class PromptSuggestionStore {
  private db: Database;
  private dbPath: string;

  constructor(dbPath: string = ".pce-dashboard/prompt-suggestions.db") {
    this.dbPath = dbPath;
    try {
      mkdirSync(dirname(this.dbPath), { recursive: true });
    } catch (error: any) {
      if (error.code !== "EEXIST") {
        pceLogger.error("Failed to create prompt suggestion store directory", { error: error.message });
      }
    }
    this.db = new Database(this.dbPath);
    this.initializeSchema();
  }

  private initializeSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS prompt_suggestion_batches (
        id TEXT PRIMARY KEY,
        generated_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        suggestions_json TEXT NOT NULL,
        context_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_prompt_suggestions_generated_at
        ON prompt_suggestion_batches(generated_at);
    `);
  }

  async saveBatch(batch: Omit<PromptSuggestionBatch, "id">): Promise<string> {
    const id = crypto.randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO prompt_suggestion_batches (
        id,
        generated_at,
        source,
        suggestions_json,
        context_json
      )
      VALUES (?, ?, ?, ?, ?)
    `);

    try {
      stmt.run(
        id,
        batch.generatedAt.getTime(),
        batch.source,
        JSON.stringify(batch.suggestions),
        batch.context ? JSON.stringify(batch.context) : null
      );
      return id;
    } catch (error: any) {
      pceLogger.error("Failed to save prompt suggestions", { error: error.message });
      throw error;
    }
  }

  async getLatestBatch(): Promise<PromptSuggestionBatch | null> {
    const stmt = this.db.prepare(`
      SELECT *
      FROM prompt_suggestion_batches
      ORDER BY generated_at DESC
      LIMIT 1
    `);
    const row = stmt.get() as any;
    if (!row) return null;

    return {
      id: row.id,
      generatedAt: new Date(row.generated_at),
      source: row.source,
      suggestions: JSON.parse(row.suggestions_json),
      context: row.context_json ? JSON.parse(row.context_json) : undefined,
    };
  }

  close(): void {
    this.db.close();
  }
}
