import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { pceLogger } from "../utils/logger";

export interface UserProfile {
  userId: string;
  displayName: string | null;
  sshUsername: string;
  publicKey: string | null;
  updatedAt: number;
}

const DEFAULT_SSH_USERNAME = "ops";

/** Basic validation: SSH public key line (ssh-ed25519, ssh-rsa, ecdsa-sha2-*, etc.) */
export function isValidPublicKeyLine(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return (
    trimmed.startsWith("ssh-ed25519 ") ||
    trimmed.startsWith("ssh-rsa ") ||
    trimmed.startsWith("ecdsa-sha2-")
  );
}

export class ProfileStore {
  private db: Database;
  private dbPath: string;

  constructor(dbPath: string = ".pce-dashboard/profiles.db") {
    this.dbPath = dbPath;
    try {
      mkdirSync(dirname(this.dbPath), { recursive: true });
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") {
        pceLogger.error("Failed to create profile store directory", { error: err.message });
      }
    }
    this.db = new Database(this.dbPath);
    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_profiles (
        user_id TEXT PRIMARY KEY,
        display_name TEXT,
        ssh_username TEXT NOT NULL DEFAULT '${DEFAULT_SSH_USERNAME}',
        public_key TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  get(userId: string): UserProfile | null {
    const row = this.db
      .prepare(
        `SELECT user_id, display_name, ssh_username, public_key, updated_at
         FROM user_profiles WHERE user_id = ?`
      )
      .get(userId) as
      | { user_id: string; display_name: string | null; ssh_username: string; public_key: string | null; updated_at: number }
      | undefined;
    if (!row) return null;
    return {
      userId: row.user_id,
      displayName: row.display_name,
      sshUsername: row.ssh_username || DEFAULT_SSH_USERNAME,
      publicKey: row.public_key,
      updatedAt: row.updated_at,
    };
  }

  list(): UserProfile[] {
    const rows = this.db
      .prepare(
        `SELECT user_id, display_name, ssh_username, public_key, updated_at
         FROM user_profiles ORDER BY updated_at DESC`
      )
      .all() as { user_id: string; display_name: string | null; ssh_username: string; public_key: string | null; updated_at: number }[];
    return rows.map(row => ({
      userId: row.user_id,
      displayName: row.display_name,
      sshUsername: row.ssh_username || DEFAULT_SSH_USERNAME,
      publicKey: row.public_key,
      updatedAt: row.updated_at,
    }));
  }

  delete(userId: string): void {
    this.db.prepare(`DELETE FROM user_profiles WHERE user_id = ?`).run(userId);
  }

  upsert(profile: {
    userId: string;
    displayName?: string | null;
    sshUsername?: string;
    publicKey?: string | null;
  }): UserProfile {
    const now = Date.now();
    const existing = this.get(profile.userId);
    const displayName = profile.displayName !== undefined ? profile.displayName : existing?.displayName ?? null;
    const sshUsername =
      profile.sshUsername !== undefined && profile.sshUsername.trim() !== ""
        ? profile.sshUsername.trim()
        : existing?.sshUsername ?? DEFAULT_SSH_USERNAME;
    const publicKey = profile.publicKey !== undefined ? profile.publicKey : existing?.publicKey ?? null;

    this.db
      .prepare(
        `INSERT INTO user_profiles (user_id, display_name, ssh_username, public_key, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           display_name = excluded.display_name,
           ssh_username = excluded.ssh_username,
           public_key = excluded.public_key,
           updated_at = excluded.updated_at`
      )
      .run(profile.userId, displayName, sshUsername, publicKey, now);

    const out = this.get(profile.userId);
    if (!out) throw new Error("Profile upsert failed");
    return out;
  }
}
