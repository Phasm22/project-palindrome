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
  ragContextId?: string;
  graphContextId?: string;
  fusionContextId?: string;
  decisions: Array<{
    type:
      | "duplicate_detected"
      | "limit_reached"
      | "fallback"
      | "tool_choice"
      | "rag_used"
      | "graph_used"
      | "fusion_used"
      | "retrieval_skipped"
      | "retrieval_executed"
      | "retrieval_injected"
      | "retrieval_not_injected"
      | "clarification_requested"
      | "validation_failed"
      | "failure_limit_reached"
      | "failure_reclassification";
    description: string;
    metadata?: Record<string, any>;
  }>;
}

export type ReasoningTraceArtifactKind = "rag_context" | "graph_context" | "fusion_context";

export interface ReasoningTraceArtifactInput {
  id: string;
  kind: ReasoningTraceArtifactKind;
  payload: Record<string, any>;
}

export interface ReasoningTraceArtifact extends ReasoningTraceArtifactInput {
  traceId: string;
  createdAt: Date;
}

export interface ReasoningTraceProvenance {
  agentVersion?: string;
  promptVersion?: string;
  promptHash?: string;
  modelId?: string;
  toolRegistryVersion?: string;
  policyMode?: string;
  selectedMode?: string;
}

export interface ReasoningTrace {
  id: string;
  userId: string;
  aclGroup: string;
  userInput: string;
  finalResponse?: string;
  steps: ReasoningStep[];
  provenance?: ReasoningTraceProvenance;
  totalSteps: number;
  totalToolCalls: number;
  maxStepsReached: boolean;
  timestamp: Date;
  durationMs: number;
  artifacts?: ReasoningTraceArtifact[];
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
        provenance_json TEXT,
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

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reasoning_trace_artifacts (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (trace_id) REFERENCES reasoning_traces(id) ON DELETE CASCADE
      );
      
      CREATE INDEX IF NOT EXISTS idx_reasoning_trace_artifacts_trace_id
        ON reasoning_trace_artifacts(trace_id);
      CREATE INDEX IF NOT EXISTS idx_reasoning_trace_artifacts_kind
        ON reasoning_trace_artifacts(kind);
    `);

    try {
      const tableInfo = this.db.prepare("PRAGMA table_info(reasoning_traces)").all() as any[];
      const hasProvenance = tableInfo.some((col) => col.name === "provenance_json");
      if (!hasProvenance) {
        this.db.exec("ALTER TABLE reasoning_traces ADD COLUMN provenance_json TEXT;");
      }
    } catch (error: any) {
      if (!error.message.includes("duplicate column")) {
        pceLogger.error("Failed to migrate reasoning_traces schema", { error: error.message });
      }
    }
  }

  async recordTrace(
    trace: Omit<ReasoningTrace, "id" | "artifacts"> & { artifacts?: ReasoningTraceArtifactInput[] }
  ): Promise<string> {
    const id = crypto.randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO reasoning_traces 
      (id, user_id, acl_group, user_input, final_response, steps_json, provenance_json, total_steps, total_tool_calls, max_steps_reached, timestamp, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    try {
      stmt.run(
        id,
        trace.userId,
        trace.aclGroup,
        trace.userInput,
        trace.finalResponse || null,
        JSON.stringify(trace.steps),
        trace.provenance ? JSON.stringify(trace.provenance) : null,
        trace.totalSteps,
        trace.totalToolCalls,
        trace.maxStepsReached ? 1 : 0,
        trace.timestamp.getTime(),
        trace.durationMs
      );

      if (trace.artifacts && trace.artifacts.length > 0) {
        const artifactStmt = this.db.prepare(`
          INSERT INTO reasoning_trace_artifacts (id, trace_id, kind, payload_json, created_at)
          VALUES (?, ?, ?, ?, ?)
        `);
        const now = Date.now();
        for (const artifact of trace.artifacts) {
          artifactStmt.run(
            artifact.id,
            id,
            artifact.kind,
            JSON.stringify(artifact.payload),
            now
          );
        }
      }
      
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
      provenance: row.provenance_json ? JSON.parse(row.provenance_json) : undefined,
      totalSteps: row.total_steps,
      totalToolCalls: row.total_tool_calls,
      maxStepsReached: row.max_steps_reached === 1,
      timestamp: new Date(row.timestamp),
      durationMs: row.duration_ms,
    }));

    return { traces, total };
  }

  async getTrace(id: string, options: { includeArtifacts?: boolean } = {}): Promise<ReasoningTrace | null> {
    const stmt = this.db.prepare("SELECT * FROM reasoning_traces WHERE id = ?");
    const row = stmt.get(id) as any;
    
    if (!row) return null;

    let artifacts: ReasoningTraceArtifact[] | undefined;
    if (options.includeArtifacts) {
      const artStmt = this.db.prepare(
        "SELECT * FROM reasoning_trace_artifacts WHERE trace_id = ? ORDER BY created_at ASC"
      );
      const artRows = artStmt.all(id) as any[];
      artifacts = artRows.map((art) => ({
        id: art.id,
        traceId: art.trace_id,
        kind: art.kind as ReasoningTraceArtifactKind,
        payload: JSON.parse(art.payload_json),
        createdAt: new Date(art.created_at),
      }));
    }

    return {
      id: row.id,
      userId: row.user_id,
      aclGroup: row.acl_group,
      userInput: row.user_input,
      finalResponse: row.final_response || undefined,
      steps: JSON.parse(row.steps_json),
      provenance: row.provenance_json ? JSON.parse(row.provenance_json) : undefined,
      totalSteps: row.total_steps,
      totalToolCalls: row.total_tool_calls,
      maxStepsReached: row.max_steps_reached === 1,
      timestamp: new Date(row.timestamp),
      durationMs: row.duration_ms,
      artifacts,
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

