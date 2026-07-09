import { Database } from "bun:sqlite";
import { pceLogger } from "../utils/logger";
import { mkdirSync } from "fs";
import { dirname } from "path";

export interface ActionOutcome {
  id: string;
  sessionId: string;
  userId: string;
  aclGroup?: string;
  intentType: string;
  actionName?: string;
  domain?: string;
  success: boolean;
  errorCategory?: string;
  durationMs?: number;
  fallbackUsed: boolean;
  confirmationRequired: boolean;
  confirmationGiven: boolean;
  timestamp: number;
}

export interface UserBehavioralProfile {
  userId: string;
  intentType: string;
  actionName: string;
  totalRuns: number;
  successCount: number;
  avgDurationMs: number;
  lastSeen: number;
  confirmationRequiredCount: number;
  confirmationGivenCount: number;
}

export class OperatorMemoryStore {
  private db: Database;

  constructor(dbPath: string = ".pce-dashboard/operator-memory.db") {
    try {
      mkdirSync(dirname(dbPath), { recursive: true });
    } catch (error: any) {
      if (error.code !== "EEXIST") {
        pceLogger.error("Failed to create operator memory store directory", { error: error.message });
      }
    }
    this.db = new Database(dbPath);
    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS action_outcomes (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        acl_group TEXT,
        intent_type TEXT NOT NULL,
        action_name TEXT,
        domain TEXT,
        success INTEGER NOT NULL,
        error_category TEXT,
        duration_ms INTEGER,
        fallback_used INTEGER DEFAULT 0,
        confirmation_required INTEGER DEFAULT 0,
        confirmation_given INTEGER DEFAULT 0,
        timestamp INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_behavioral_profile (
        user_id TEXT NOT NULL,
        intent_type TEXT NOT NULL,
        action_name TEXT NOT NULL DEFAULT '',
        total_runs INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        avg_duration_ms REAL DEFAULT 0,
        last_seen INTEGER DEFAULT 0,
        confirmation_required_count INTEGER DEFAULT 0,
        confirmation_given_count INTEGER DEFAULT 0,
        PRIMARY KEY (user_id, intent_type, action_name)
      );

      CREATE INDEX IF NOT EXISTS idx_outcomes_user_id ON action_outcomes(user_id);
      CREATE INDEX IF NOT EXISTS idx_outcomes_timestamp ON action_outcomes(timestamp);
    `);
  }

  recordOutcome(outcome: ActionOutcome): void {
    const stmt = this.db.prepare(`
      INSERT INTO action_outcomes
        (id, session_id, user_id, acl_group, intent_type, action_name, domain, success,
         error_category, duration_ms, fallback_used, confirmation_required, confirmation_given, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    try {
      stmt.run(
        outcome.id,
        outcome.sessionId,
        outcome.userId,
        outcome.aclGroup ?? null,
        outcome.intentType,
        outcome.actionName ?? null,
        outcome.domain ?? null,
        outcome.success ? 1 : 0,
        outcome.errorCategory ?? null,
        outcome.durationMs ?? null,
        outcome.fallbackUsed ? 1 : 0,
        outcome.confirmationRequired ? 1 : 0,
        outcome.confirmationGiven ? 1 : 0,
        outcome.timestamp,
      );
    } catch (error: any) {
      pceLogger.error("Failed to record action outcome", { error: error.message });
      return;
    }

    // Upsert behavioral profile
    const actionName = outcome.actionName ?? "";
    const existing = this.db
      .prepare(
        "SELECT * FROM user_behavioral_profile WHERE user_id = ? AND intent_type = ? AND action_name = ?"
      )
      .get(outcome.userId, outcome.intentType, actionName) as UserBehavioralProfile | null;

    if (existing) {
      const newTotal = existing.totalRuns + 1;
      const newSuccessCount = existing.successCount + (outcome.success ? 1 : 0);
      const prevAvg = existing.avgDurationMs ?? 0;
      const newAvg = outcome.durationMs != null
        ? (prevAvg * existing.totalRuns + outcome.durationMs) / newTotal
        : prevAvg;
      const newConfirmRequired = existing.confirmationRequiredCount + (outcome.confirmationRequired ? 1 : 0);
      const newConfirmGiven = existing.confirmationGivenCount + (outcome.confirmationGiven ? 1 : 0);

      this.db
        .prepare(
          `UPDATE user_behavioral_profile
           SET total_runs = ?, success_count = ?, avg_duration_ms = ?, last_seen = ?,
               confirmation_required_count = ?, confirmation_given_count = ?
           WHERE user_id = ? AND intent_type = ? AND action_name = ?`
        )
        .run(
          newTotal, newSuccessCount, newAvg, outcome.timestamp,
          newConfirmRequired, newConfirmGiven,
          outcome.userId, outcome.intentType, actionName,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO user_behavioral_profile
             (user_id, intent_type, action_name, total_runs, success_count, avg_duration_ms,
              last_seen, confirmation_required_count, confirmation_given_count)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`
        )
        .run(
          outcome.userId,
          outcome.intentType,
          actionName,
          outcome.success ? 1 : 0,
          outcome.durationMs ?? 0,
          outcome.timestamp,
          outcome.confirmationRequired ? 1 : 0,
          outcome.confirmationGiven ? 1 : 0,
        );
    }
  }

  getUserProfile(userId: string, intentType: string, actionName?: string): UserBehavioralProfile | null {
    const name = actionName ?? "";
    const row = this.db
      .prepare(
        "SELECT * FROM user_behavioral_profile WHERE user_id = ? AND intent_type = ? AND action_name = ?"
      )
      .get(userId, intentType, name) as Record<string, unknown> | null;

    if (!row) return null;
    return {
      userId: row.user_id as string,
      intentType: row.intent_type as string,
      actionName: row.action_name as string,
      totalRuns: row.total_runs as number,
      successCount: row.success_count as number,
      avgDurationMs: row.avg_duration_ms as number,
      lastSeen: row.last_seen as number,
      confirmationRequiredCount: row.confirmation_required_count as number,
      confirmationGivenCount: row.confirmation_given_count as number,
    };
  }

  getRecentOutcomes(userId: string, limit: number = 20): ActionOutcome[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM action_outcomes WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?"
      )
      .all(userId, limit) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: row.id as string,
      sessionId: row.session_id as string,
      userId: row.user_id as string,
      aclGroup: (row.acl_group as string | null) ?? undefined,
      intentType: row.intent_type as string,
      actionName: (row.action_name as string | null) ?? undefined,
      domain: (row.domain as string | null) ?? undefined,
      success: (row.success as number) === 1,
      errorCategory: (row.error_category as string | null) ?? undefined,
      durationMs: (row.duration_ms as number | null) ?? undefined,
      fallbackUsed: (row.fallback_used as number) === 1,
      confirmationRequired: (row.confirmation_required as number) === 1,
      confirmationGiven: (row.confirmation_given as number) === 1,
      timestamp: row.timestamp as number,
    }));
  }

  close(): void {
    this.db.close();
  }
}

let storeInstance: OperatorMemoryStore | null = null;

export function getOperatorMemoryStore(): OperatorMemoryStore {
  if (!storeInstance) {
    storeInstance = new OperatorMemoryStore();
  }
  return storeInstance;
}
