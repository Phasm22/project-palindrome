import { Database } from "bun:sqlite";
import { pceLogger } from "../utils/logger";
import { mkdirSync } from "fs";
import { dirname } from "path";

export interface ReasoningStep {
  step: number;
  llmResponse?: string;
  toolCalls: Array<{
    toolName: string;
    parameters: Record<string, any>;
    result?: { 
      success: boolean; 
      error?: string; 
      dataPreview?: string;
      dataSize?: number;
      resultType?: string;
    };
    durationMs?: number;
  }>;
  ragContext?: {
    queryType: string;
    sTotalScore: number | null;
    sourcesCount: number;
    topChunks?: Array<{
      sourcePath: string;
      score: number;
      textPreview: string;
      chunkId?: string;
    }>;
    structuralPaths?: number;
    fusionMetrics?: {
      vectorResults: number;
      graphResults: number;
      fusedResults: number;
      prunedResults: number;
    };
  };
  graphContext?: {
    entitiesFound: number;
    relationshipsFound: number;
    queryType?: string;
    topEntities?: Array<{
      name: string;
      type: string;
      score?: number;
    }>;
  };
  decisions: Array<{
    type: "duplicate_detected" | "limit_reached" | "fallback" | "tool_choice" | "rag_used" | "graph_used" | "fusion_used";
    description: string;
    metadata?: Record<string, any>;
  }>;
}

export interface ReasoningTrace {
  id: string;
  userId: string;
  aclGroup: string;
  userInput: string;
  finalResponse?: string;
  steps: ReasoningStep[];
  totalSteps: number;
  totalToolCalls: number;
  maxStepsReached: boolean;
  timestamp: Date;
  durationMs: number;
}

export class ReasoningTraceStore {
  private db: Database;
  private dbPath: string;

  constructor(dbPath: string = ".pce-dashboard/reasoning-traces.db") {
    this.dbPath = dbPath;
    // Ensure directory exists
    try {
      mkdirSync(dirname(this.dbPath), { recursive: true });
    } catch (error: any) {
      if (error.code !== "EEXIST") {
        pceLogger.error("Failed to create reasoning trace store directory", { error: error.message });
      }
    }
    this.db = new Database(dbPath);
    this.initializeSchema();
  }

  private initializeSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reasoning_traces (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        acl_group TEXT NOT NULL,
        user_input TEXT NOT NULL,
        final_response TEXT,
        steps_json TEXT NOT NULL,
        total_steps INTEGER NOT NULL,
        total_tool_calls INTEGER NOT NULL,
        max_steps_reached INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL
      );
      
      CREATE INDEX IF NOT EXISTS idx_user_id ON reasoning_traces(user_id);
      CREATE INDEX IF NOT EXISTS idx_timestamp ON reasoning_traces(timestamp);
      CREATE INDEX IF NOT EXISTS idx_acl_group ON reasoning_traces(acl_group);
    `);
  }

  async recordTrace(trace: Omit<ReasoningTrace, "id">): Promise<string> {
    const id = crypto.randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO reasoning_traces 
      (id, user_id, acl_group, user_input, final_response, steps_json, total_steps, total_tool_calls, max_steps_reached, timestamp, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    try {
      stmt.run(
        id,
        trace.userId,
        trace.aclGroup,
        trace.userInput,
        trace.finalResponse || null,
        JSON.stringify(trace.steps),
        trace.totalSteps,
        trace.totalToolCalls,
        trace.maxStepsReached ? 1 : 0,
        trace.timestamp.getTime(),
        trace.durationMs
      );
      
      pceLogger.debug("Recorded reasoning trace", {
        id,
        userId: trace.userId,
        totalSteps: trace.totalSteps,
        totalToolCalls: trace.totalToolCalls,
      });
      
      return id;
    } catch (error: any) {
      pceLogger.error("Failed to record reasoning trace", {
        error: error.message,
        userId: trace.userId,
      });
      throw error;
    }
  }

  async getTraces(filters: {
    userId?: string;
    aclGroup?: string;
    since?: Date;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ traces: ReasoningTrace[]; total: number }> {
    let query = "SELECT * FROM reasoning_traces WHERE 1=1";
    let countQuery = "SELECT COUNT(*) as total FROM reasoning_traces WHERE 1=1";
    const countParams: any[] = [];
    const queryParams: any[] = [];

    if (filters.userId) {
      query += " AND user_id = ?";
      countQuery += " AND user_id = ?";
      countParams.push(filters.userId);
      queryParams.push(filters.userId);
    }

    if (filters.aclGroup) {
      query += " AND acl_group = ?";
      countQuery += " AND acl_group = ?";
      countParams.push(filters.aclGroup);
      queryParams.push(filters.aclGroup);
    }

    if (filters.since) {
      query += " AND timestamp >= ?";
      countQuery += " AND timestamp >= ?";
      countParams.push(filters.since.getTime());
      queryParams.push(filters.since.getTime());
    }

    // Get total count
    const countStmt = this.db.prepare(countQuery);
    const countResult = countStmt.get(...countParams) as { total: number };
    const total = countResult.total;

    // Get paginated results
    query += " ORDER BY timestamp DESC";
    if (filters.limit) {
      query += " LIMIT ?";
      queryParams.push(filters.limit);
    }
    if (filters.offset) {
      query += " OFFSET ?";
      queryParams.push(filters.offset);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...queryParams) as any[];

    const traces = rows.map(row => ({
      id: row.id,
      userId: row.user_id,
      aclGroup: row.acl_group,
      userInput: row.user_input,
      finalResponse: row.final_response || undefined,
      steps: JSON.parse(row.steps_json),
      totalSteps: row.total_steps,
      totalToolCalls: row.total_tool_calls,
      maxStepsReached: row.max_steps_reached === 1,
      timestamp: new Date(row.timestamp),
      durationMs: row.duration_ms,
    }));

    return { traces, total };
  }

  async getTrace(id: string): Promise<ReasoningTrace | null> {
    const stmt = this.db.prepare("SELECT * FROM reasoning_traces WHERE id = ?");
    const row = stmt.get(id) as any;
    
    if (!row) return null;

    return {
      id: row.id,
      userId: row.user_id,
      aclGroup: row.acl_group,
      userInput: row.user_input,
      finalResponse: row.final_response || undefined,
      steps: JSON.parse(row.steps_json),
      totalSteps: row.total_steps,
      totalToolCalls: row.total_tool_calls,
      maxStepsReached: row.max_steps_reached === 1,
      timestamp: new Date(row.timestamp),
      durationMs: row.duration_ms,
    };
  }

  close(): void {
    this.db.close();
  }
}

// Singleton instance
let storeInstance: ReasoningTraceStore | null = null;

export function getReasoningTraceStore(): ReasoningTraceStore {
  if (!storeInstance) {
    storeInstance = new ReasoningTraceStore();
  }
  return storeInstance;
}

