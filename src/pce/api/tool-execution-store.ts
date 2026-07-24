import { Database } from "bun:sqlite";
import type { ExecutionResult, ACLGroup } from "../../types";
import { pceLogger } from "../utils/logger";
import { mkdirSync } from "fs";
import { dirname } from "path";

export interface ToolExecution {
  id: string;
  toolName: string;
  parameters: Record<string, any>;
  result: ExecutionResult;
  userId: string;
  aclGroup: ACLGroup;
  durationMs: number;
  timestamp: Date;
  error?: string;
  node?: string; // For Proxmox operations
  vmid?: number; // For VM operations
  traceId?: string; // Links back to the parent reasoning_traces row
}

export interface ToolExecutionFilters {
  toolName?: string;
  userId?: string;
  aclGroup?: ACLGroup;
  since?: Date;
  limit?: number;
  offset?: number;
  traceId?: string;
}

export interface ToolExecutionStats {
  total: number;
  byTool: Record<string, number>;
  byUser: Record<string, number>;
  /** Total failed executions in the window (not capped). */
  errorCount: number;
  errorRate: number;
  avgDurationMs: number;
  /** Most recent failures only (capped for UI preview). */
  recentErrors: ToolExecution[];
}

export class ToolExecutionStore {
  private db: Database;
  private dbPath: string;

  constructor(dbPath: string = ".pce-dashboard/tool-executions.db") {
    this.dbPath = dbPath;
    // Ensure directory exists before opening database
    try {
      mkdirSync(dirname(this.dbPath), { recursive: true });
    } catch (error: any) {
      if (error.code !== "EEXIST") {
        pceLogger.error("Failed to create tool execution store directory", { error: error.message });
      }
    }
    this.db = new Database(dbPath);
    this.initializeSchema();
  }

  private initializeSchema() {

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_executions (
        id TEXT PRIMARY KEY,
        tool_name TEXT NOT NULL,
        parameters TEXT NOT NULL,
        result_data TEXT,
        result_error TEXT,
        user_id TEXT NOT NULL,
        acl_group TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        node TEXT,
        vmid INTEGER
      );
      
      CREATE INDEX IF NOT EXISTS idx_tool_name ON tool_executions(tool_name);
      CREATE INDEX IF NOT EXISTS idx_user_id ON tool_executions(user_id);
      CREATE INDEX IF NOT EXISTS idx_timestamp ON tool_executions(timestamp);
      CREATE INDEX IF NOT EXISTS idx_acl_group ON tool_executions(acl_group);
      CREATE INDEX IF NOT EXISTS idx_node ON tool_executions(node);
      CREATE INDEX IF NOT EXISTS idx_vmid ON tool_executions(vmid);
    `);

    try {
      const tableInfo = this.db.prepare("PRAGMA table_info(tool_executions)").all() as any[];
      const hasTraceId = tableInfo.some((col) => col.name === "trace_id");
      if (!hasTraceId) {
        this.db.exec("ALTER TABLE tool_executions ADD COLUMN trace_id TEXT;");
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_trace_id ON tool_executions(trace_id);");
      }
    } catch (error: any) {
      if (!error.message.includes("duplicate column")) {
        pceLogger.error("Failed to migrate tool_executions schema", { error: error.message });
      }
    }
  }

  async recordExecution(execution: Omit<ToolExecution, "id">): Promise<void> {
    const id = crypto.randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO tool_executions
      (id, tool_name, parameters, result_data, result_error, user_id, acl_group, duration_ms, timestamp, node, vmid, trace_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    try {
      stmt.run(
        id,
        execution.toolName,
        JSON.stringify(execution.parameters),
        execution.result.data ? JSON.stringify(execution.result.data) : null,
        execution.result.error || null,
        execution.userId,
        execution.aclGroup,
        execution.durationMs,
        execution.timestamp.getTime(),
        execution.node || null,
        execution.vmid || null,
        execution.traceId || null
      );
      
      pceLogger.debug("Recorded tool execution", {
        id,
        toolName: execution.toolName,
        userId: execution.userId,
        durationMs: execution.durationMs,
      });
    } catch (error: any) {
      pceLogger.error("Failed to record tool execution", {
        error: error.message,
        toolName: execution.toolName,
      });
      throw error;
    }
  }

  async getExecutions(filters: ToolExecutionFilters = {}): Promise<{ executions: ToolExecution[]; total: number }> {
    let query = "SELECT * FROM tool_executions WHERE 1=1";
    let countQuery = "SELECT COUNT(*) as total FROM tool_executions WHERE 1=1";
    const countParams: any[] = [];
    const queryParams: any[] = [];

    if (filters.toolName) {
      query += " AND tool_name = ?";
      countQuery += " AND tool_name = ?";
      countParams.push(filters.toolName);
      queryParams.push(filters.toolName);
    }

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

    if (filters.traceId) {
      query += " AND trace_id = ?";
      countQuery += " AND trace_id = ?";
      countParams.push(filters.traceId);
      queryParams.push(filters.traceId);
    }

    // Get total count (without pagination params)
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

    const executions = rows.map(row => ({
      id: row.id,
      toolName: row.tool_name,
      parameters: JSON.parse(row.parameters),
      result: {
        data: row.result_data ? JSON.parse(row.result_data) : undefined,
        error: row.result_error || undefined,
        durationMs: row.duration_ms,
      },
      userId: row.user_id,
      aclGroup: row.acl_group as ACLGroup,
      durationMs: row.duration_ms,
      timestamp: new Date(row.timestamp),
      node: row.node || undefined,
      vmid: row.vmid || undefined,
      error: row.result_error || undefined,
      traceId: row.trace_id || undefined,
    }));

    return { executions, total };
  }

  async getExecutionStats(since?: Date): Promise<ToolExecutionStats> {
    let query = "SELECT * FROM tool_executions";
    const params: any[] = [];

    if (since) {
      query += " WHERE timestamp >= ?";
      params.push(since.getTime());
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];

    const total = rows.length;
    const byTool: Record<string, number> = {};
    const byUser: Record<string, number> = {};
    let errorCount = 0;
    let totalDuration = 0;
    const recentErrors: ToolExecution[] = [];

    for (const row of rows) {
      // Count by tool
      byTool[row.tool_name] = (byTool[row.tool_name] || 0) + 1;
      
      // Count by user
      byUser[row.user_id] = (byUser[row.user_id] || 0) + 1;
      
      // Track errors
      if (row.result_error) {
        errorCount++;
        if (recentErrors.length < 10) {
          recentErrors.push({
            id: row.id,
            toolName: row.tool_name,
            parameters: JSON.parse(row.parameters),
            result: {
              error: row.result_error,
            },
            userId: row.user_id,
            aclGroup: row.acl_group as ACLGroup,
            durationMs: row.duration_ms,
            timestamp: new Date(row.timestamp),
            error: row.result_error,
          });
        }
      }
      
      totalDuration += row.duration_ms;
    }

    return {
      total,
      byTool,
      byUser,
      errorCount,
      errorRate: total > 0 ? errorCount / total : 0,
      avgDurationMs: total > 0 ? totalDuration / total : 0,
      recentErrors: recentErrors.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime()),
    };
  }

  async getRecentExecutions(limit: number = 50): Promise<ToolExecution[]> {
    const result = await this.getExecutions({ limit });
    return result.executions;
  }

  close(): void {
    this.db.close();
  }
}

// Singleton instance for easy access
let storeInstance: ToolExecutionStore | null = null;

export function getToolExecutionStore(): ToolExecutionStore {
  if (!storeInstance) {
    storeInstance = new ToolExecutionStore();
  }
  return storeInstance;
}

export function setToolExecutionStoreForTests(store: ToolExecutionStore | null): void {
  if (storeInstance && storeInstance !== store) {
    storeInstance.close();
  }
  storeInstance = store;
}

export function resetToolExecutionStoreForTests(): void {
  if (storeInstance) {
    storeInstance.close();
    storeInstance = null;
  }
}
