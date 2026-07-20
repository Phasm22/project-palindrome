import { Database } from "bun:sqlite";
import type { ACLGroup } from "../types";
import type {
  ConversationContext,
  ConversationState,
  UserPreferences,
  VerbosityPreference,
  MemoryUpdateSource,
} from "../../types";
import type { ApiHistoryEntry, ApiQueryResponse } from "./types";
import { pceLogger } from "../utils/logger";
import { mkdirSync } from "fs";
import { dirname } from "path";
import type { AgentResponse } from "../../agent/schemas/agent-response";

export interface ChatMessage {
  id: string;
  conversationId: string;
  userId: string;
  aclGroup: ACLGroup;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  response?: ApiQueryResponse; // For assistant messages
  structuredResponse?: AgentResponse;
  reasoningTraceId?: string; // Link to reasoning trace for assistant messages
}

export interface ClarificationResponse {
  id: string;
  conversationId: string;
  userId: string;
  clarificationId: string;
  optionId?: string;
  optionText: string;
  clarificationText?: string;
  createdAt: Date;
}

export interface Conversation {
  id: string;
  userId: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
  state?: ConversationState;
}

export interface ChatHistoryFilters {
  conversationId?: string;
  userId?: string;
  aclGroup?: ACLGroup;
  since?: Date;
  limit?: number;
  offset?: number;
}

export class ChatHistoryStore {
  private db: Database;
  private dbPath: string;

  constructor(dbPath: string = ".pce-dashboard/chat-history.db") {
    this.dbPath = dbPath;
    // Ensure directory exists before opening database
    try {
      mkdirSync(dirname(this.dbPath), { recursive: true });
    } catch (error: any) {
      if (error.code !== "EEXIST") {
        pceLogger.error("Failed to create chat history store directory", { error: error.message });
      }
    }
    this.db = new Database(dbPath);
    this.initializeSchema();
  }

  private initializeSchema() {
    // Create conversations table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        state TEXT
      );
      
      CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at);
    `);

    // Create chat_messages table (may already exist with old schema)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        acl_group TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        response_data TEXT,
        timestamp INTEGER NOT NULL
      );
    `);

    // Check if conversation_id column exists and add it if missing
    try {
      const tableInfo = this.db.prepare("PRAGMA table_info(chat_messages)").all() as any[];
      const hasConversationId = tableInfo.some(col => col.name === "conversation_id");
      const hasReasoningTraceId = tableInfo.some(col => col.name === "reasoning_trace_id");
      
      if (!hasConversationId) {
        pceLogger.info("Migrating chat_messages table: adding conversation_id column");
        // Add conversation_id column (SQLite doesn't support NOT NULL on ALTER TABLE for existing tables)
        this.db.exec(`
          ALTER TABLE chat_messages ADD COLUMN conversation_id TEXT;
          CREATE INDEX IF NOT EXISTS idx_conversation_id ON chat_messages(conversation_id);
        `);
        
        // Migrate existing messages to a default conversation
        this.migrateExistingMessagesLegacy();
      }
      
      if (!hasReasoningTraceId) {
        pceLogger.info("Migrating chat_messages table: adding reasoning_trace_id column");
        this.db.exec(`
          ALTER TABLE chat_messages ADD COLUMN reasoning_trace_id TEXT;
          CREATE INDEX IF NOT EXISTS idx_reasoning_trace_id ON chat_messages(reasoning_trace_id);
        `);
      }

      const hasStructuredResponse = tableInfo.some(col => col.name === "structured_response");
      if (!hasStructuredResponse) {
        pceLogger.info("Migrating chat_messages table: adding structured_response column");
        this.db.exec("ALTER TABLE chat_messages ADD COLUMN structured_response TEXT;");
      }
    } catch (error: any) {
      // If column already exists, that's fine
      if (!error.message.includes("duplicate column")) {
        pceLogger.error("Failed to add columns to chat_messages", { error: error.message });
      }
    }

    // Ensure conversation state column exists
    try {
      const convTableInfo = this.db.prepare("PRAGMA table_info(conversations)").all() as any[];
      const hasState = convTableInfo.some(col => col.name === "state");
      if (!hasState) {
        pceLogger.info("Migrating conversations table: adding state column");
        this.db.exec(`
          ALTER TABLE conversations ADD COLUMN state TEXT;
        `);
      }
    } catch (error: any) {
      if (!error.message.includes("duplicate column")) {
        pceLogger.error("Failed to add state column to conversations", { error: error.message });
      }
    }

    // Create remaining indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_conversation_id ON chat_messages(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_user_id ON chat_messages(user_id);
      CREATE INDEX IF NOT EXISTS idx_timestamp ON chat_messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_acl_group ON chat_messages(acl_group);
      CREATE INDEX IF NOT EXISTS idx_user_timestamp ON chat_messages(user_id, timestamp);
    `);

    // Create user preferences table for storing last active conversation and prefs
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_preferences (
        user_id TEXT PRIMARY KEY,
        last_active_conversation_id TEXT,
        safe_mode INTEGER,
        default_env TEXT,
        preferred_time_range TEXT,
        verbosity TEXT,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (last_active_conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
      );
      
      CREATE INDEX IF NOT EXISTS idx_user_preferences_user_id ON user_preferences(user_id);
    `);

    // Ensure user preferences columns exist
    try {
      const prefInfo = this.db.prepare("PRAGMA table_info(user_preferences)").all() as any[];
      const hasSafeMode = prefInfo.some(col => col.name === "safe_mode");
      const hasDefaultEnv = prefInfo.some(col => col.name === "default_env");
      const hasPreferredTimeRange = prefInfo.some(col => col.name === "preferred_time_range");
      const hasVerbosity = prefInfo.some(col => col.name === "verbosity");
      const hasUpdatedAt = prefInfo.some(col => col.name === "updated_at");

      if (!hasSafeMode || !hasDefaultEnv || !hasPreferredTimeRange || !hasVerbosity || !hasUpdatedAt) {
        pceLogger.info("Migrating user_preferences table: adding preference columns");
        if (!hasSafeMode) this.db.exec("ALTER TABLE user_preferences ADD COLUMN safe_mode INTEGER;");
        if (!hasDefaultEnv) this.db.exec("ALTER TABLE user_preferences ADD COLUMN default_env TEXT;");
        if (!hasPreferredTimeRange) this.db.exec("ALTER TABLE user_preferences ADD COLUMN preferred_time_range TEXT;");
        if (!hasVerbosity) this.db.exec("ALTER TABLE user_preferences ADD COLUMN verbosity TEXT;");
        // Older databases may not have updated_at; add it if missing.
        // We don't enforce NOT NULL here to avoid migration failures; application code always writes a value.
        if (!hasUpdatedAt) this.db.exec("ALTER TABLE user_preferences ADD COLUMN updated_at INTEGER;");
      }
    } catch (error: any) {
      if (!error.message.includes("duplicate column")) {
        pceLogger.error("Failed to add preference columns to user_preferences", { error: error.message });
      }
    }

    // Create conversation context table for per-conversation memory
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_context (
        conversation_id TEXT PRIMARY KEY,
        active_host TEXT,
        active_service TEXT,
        last_incident_signature TEXT,
        user_name TEXT,
        pending_action TEXT,
        pending_action_id TEXT,
        pending_action_digest TEXT,
        pending_action_created_at INTEGER,
        pending_action_summary TEXT,
        pending_action_type TEXT,
        pending_action_preview TEXT,
        pending_action_execute_input TEXT,
        pending_action_expires_at INTEGER,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
      
      CREATE INDEX IF NOT EXISTS idx_conversation_context_conversation_id ON conversation_context(conversation_id);
    `);

    // Create clarification response table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS clarification_responses (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        clarification_id TEXT NOT NULL,
        option_id TEXT,
        option_text TEXT NOT NULL,
        clarification_text TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_clarification_conversation_id
        ON clarification_responses(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_clarification_id
        ON clarification_responses(clarification_id);
      CREATE INDEX IF NOT EXISTS idx_clarification_user_id
        ON clarification_responses(user_id);
    `);

    // Ensure conversation_context columns exist (for backward compatibility)
    try {
      const ctxInfo = this.db.prepare("PRAGMA table_info(conversation_context)").all() as any[];
      const columnExists = (name: string) => ctxInfo.some(col => col.name === name);
      if (!columnExists("user_name")) {
        this.db.exec("ALTER TABLE conversation_context ADD COLUMN user_name TEXT;");
      }
      if (!columnExists("pending_action_id")) {
        this.db.exec("ALTER TABLE conversation_context ADD COLUMN pending_action_id TEXT;");
      }
      if (!columnExists("pending_action_digest")) {
        this.db.exec("ALTER TABLE conversation_context ADD COLUMN pending_action_digest TEXT;");
      }
      if (!columnExists("pending_action_created_at")) {
        this.db.exec("ALTER TABLE conversation_context ADD COLUMN pending_action_created_at INTEGER;");
      }
      if (!columnExists("pending_action_summary")) {
        this.db.exec("ALTER TABLE conversation_context ADD COLUMN pending_action_summary TEXT;");
      }
      if (!columnExists("pending_action_type")) {
        this.db.exec("ALTER TABLE conversation_context ADD COLUMN pending_action_type TEXT;");
      }
      if (!columnExists("pending_action_preview")) {
        this.db.exec("ALTER TABLE conversation_context ADD COLUMN pending_action_preview TEXT;");
      }
      if (!columnExists("pending_action_execute_input")) {
        this.db.exec("ALTER TABLE conversation_context ADD COLUMN pending_action_execute_input TEXT;");
      }
      if (!columnExists("pending_action_expires_at")) {
        this.db.exec("ALTER TABLE conversation_context ADD COLUMN pending_action_expires_at INTEGER;");
      }
    } catch (error: any) {
      if (!error.message.includes("duplicate column")) {
        pceLogger.error("Failed to migrate conversation_context columns", { error: error.message });
      }
    }

    // Create memory events table for provenance
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_events (
        id TEXT PRIMARY KEY,
        conversation_id TEXT,
        user_id TEXT,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence REAL,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_events_conversation_id ON memory_events(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_memory_events_user_id ON memory_events(user_id);
      CREATE INDEX IF NOT EXISTS idx_memory_events_timestamp ON memory_events(timestamp);
    `);
  }

  /**
   * Migrate existing messages without conversation_id to a default conversation
   */
  private migrateExistingMessagesLegacy() {
    try {
      // Get all unique user_ids that have messages without conversation_id
      const usersStmt = this.db.prepare(`
        SELECT DISTINCT user_id FROM chat_messages 
        WHERE conversation_id IS NULL OR conversation_id = ''
      `);
      const users = usersStmt.all() as { user_id: string }[];
      
      for (const user of users) {
        // Create a default conversation for this user
        const defaultConvId = crypto.randomUUID();
        const now = Date.now();
        const convStmt = this.db.prepare(`
          INSERT INTO conversations (id, user_id, title, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `);
        convStmt.run(defaultConvId, user.user_id, "Previous Chat", now, now);
        
        // Update all messages for this user
        const updateStmt = this.db.prepare(`
          UPDATE chat_messages 
          SET conversation_id = ? 
          WHERE user_id = ? AND (conversation_id IS NULL OR conversation_id = '')
        `);
        const result = updateStmt.run(defaultConvId, user.user_id);
        
        pceLogger.info("Migrated existing messages to default conversation", { 
          userId: user.user_id, 
          messageCount: result.changes || 0 
        });
      }
    } catch (error: any) {
      pceLogger.error("Failed to migrate existing messages", { error: error.message });
    }
  }

  /**
   * Create a new conversation
   */
  async createConversation(userId: string, title?: string, state: ConversationState = "IDLE"): Promise<string> {
    const id = crypto.randomUUID();
    const now = Date.now();
    const conversationTitle = title || `Chat ${new Date(now).toLocaleString()}`;
    
    const stmt = this.db.prepare(`
      INSERT INTO conversations (id, user_id, title, created_at, updated_at, state)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    try {
      stmt.run(id, userId, conversationTitle, now, now, state);
      return id;
    } catch (error: any) {
      pceLogger.error("Failed to create conversation", { error: error.message, userId });
      throw error;
    }
  }

  /**
   * Get all conversations for a user
   */
  async getConversations(userId: string, limit: number = 50): Promise<Conversation[]> {
    try {
      const stmt = this.db.prepare(`
        SELECT 
          c.id,
          c.user_id,
          c.title,
          c.created_at,
          c.updated_at,
          c.state,
          COALESCE(COUNT(m.id), 0) as message_count
        FROM conversations c
        LEFT JOIN chat_messages m ON c.id = m.conversation_id
        WHERE c.user_id = ?
        GROUP BY c.id, c.user_id, c.title, c.created_at, c.updated_at
        ORDER BY c.updated_at DESC
        LIMIT ?
      `);
      
      const rows = stmt.all(userId, limit) as any[];
      
      return rows.map(row => ({
        id: row.id,
        userId: row.user_id,
        title: row.title,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
        messageCount: Number(row.message_count) || 0,
        state: (row.state as ConversationState) || "IDLE",
      }));
    } catch (error: any) {
      pceLogger.error("Failed to get conversations", { error: error.message, userId });
      return [];
    }
  }

  /**
   * Get a conversation by ID
   */
  async getConversation(conversationId: string, userId?: string): Promise<Conversation | null> {
    try {
      let query = `
        SELECT 
          c.id,
          c.user_id,
          c.title,
          c.created_at,
          c.updated_at,
          c.state,
          COUNT(m.id) as message_count
        FROM conversations c
        LEFT JOIN chat_messages m ON c.id = m.conversation_id
        WHERE c.id = ?
      `;
      const params: any[] = [conversationId];
      
      if (userId) {
        query += " AND c.user_id = ?";
        params.push(userId);
      }
      
      query += " GROUP BY c.id";
      
      const stmt = this.db.prepare(query);
      const row = stmt.get(...params) as any;
      
      if (!row) return null;
      
      return {
        id: row.id,
        userId: row.user_id,
        title: row.title,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
        messageCount: row.message_count || 0,
        state: (row.state as ConversationState) || "IDLE",
      };
    } catch (error: any) {
      pceLogger.error("Failed to get conversation", { error: error.message, conversationId });
      return null;
    }
  }

  /**
   * Update conversation title
   */
  async updateConversationTitle(conversationId: string, title: string, userId?: string): Promise<boolean> {
    try {
      let query = "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?";
      const params: any[] = [title, Date.now(), conversationId];
      
      if (userId) {
        query += " AND user_id = ?";
        params.push(userId);
      }
      
      const stmt = this.db.prepare(query);
      const result = stmt.run(...params);
      return (result.changes || 0) > 0;
    } catch (error: any) {
      pceLogger.error("Failed to update conversation title", { error: error.message, conversationId });
      return false;
    }
  }

  /**
   * Update conversation state
   */
  async updateConversationState(conversationId: string, state: ConversationState, userId?: string): Promise<boolean> {
    try {
      let query = "UPDATE conversations SET state = ?, updated_at = ? WHERE id = ?";
      const params: any[] = [state, Date.now(), conversationId];

      if (userId) {
        query += " AND user_id = ?";
        params.push(userId);
      }

      const stmt = this.db.prepare(query);
      const result = stmt.run(...params);
      return (result.changes || 0) > 0;
    } catch (error: any) {
      pceLogger.error("Failed to update conversation state", { error: error.message, conversationId, state });
      return false;
    }
  }

  /**
   * Delete a conversation (cascades to messages)
   */
  async deleteConversation(conversationId: string, userId?: string): Promise<boolean> {
    try {
      let query = "DELETE FROM conversations WHERE id = ?";
      const params: any[] = [conversationId];
      
      if (userId) {
        query += " AND user_id = ?";
        params.push(userId);
      }
      
      const stmt = this.db.prepare(query);
      const result = stmt.run(...params);
      return (result.changes || 0) > 0;
    } catch (error: any) {
      pceLogger.error("Failed to delete conversation", { error: error.message, conversationId });
      return false;
    }
  }

  /**
   * Save a chat message (requires conversationId)
   */
  async saveMessage(message: Omit<ChatMessage, "id">): Promise<string> {
    const id = crypto.randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO chat_messages 
      (id, conversation_id, user_id, acl_group, role, content, response_data, structured_response, timestamp, reasoning_trace_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    try {
      // Update conversation's updated_at timestamp
      const updateConvStmt = this.db.prepare(`
        UPDATE conversations SET updated_at = ? WHERE id = ?
      `);
      updateConvStmt.run(Date.now(), message.conversationId);
      
      stmt.run(
        id,
        message.conversationId,
        message.userId,
        message.aclGroup,
        message.role,
        message.content,
        message.response ? JSON.stringify(message.response) : null,
        message.structuredResponse ? JSON.stringify(message.structuredResponse) : null,
        message.timestamp.getTime(),
        message.reasoningTraceId || null
      );
      return id;
    } catch (error: any) {
      pceLogger.error("Failed to save chat message", { error: error.message, userId: message.userId });
      throw error;
    }
  }

  /**
   * Get chat history (optionally filtered by conversation)
   */
  async getHistory(filters: ChatHistoryFilters = {}): Promise<ChatMessage[]> {
    const { conversationId, userId, aclGroup, since, limit = 100, offset = 0 } = filters;
    
    let query = "SELECT * FROM chat_messages WHERE 1=1";
    const params: any[] = [];

    if (conversationId) {
      query += " AND conversation_id = ?";
      params.push(conversationId);
    }

    if (userId) {
      query += " AND user_id = ?";
      params.push(userId);
    }

    if (aclGroup) {
      query += " AND acl_group = ?";
      params.push(aclGroup);
    }

    if (since) {
      query += " AND timestamp >= ?";
      params.push(since.getTime());
    }

    query += " ORDER BY timestamp ASC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    try {
      const stmt = this.db.prepare(query);
      const rows = stmt.all(...params) as any[];
      
      return rows.map(row => ({
        id: row.id,
        conversationId: row.conversation_id,
        userId: row.user_id,
        aclGroup: row.acl_group as ACLGroup,
        role: row.role as "user" | "assistant",
        content: row.content,
        timestamp: new Date(row.timestamp),
        response: row.response_data ? JSON.parse(row.response_data) : undefined,
        structuredResponse: row.structured_response ? JSON.parse(row.structured_response) : undefined,
        reasoningTraceId: row.reasoning_trace_id || undefined,
      }));
    } catch (error: any) {
      pceLogger.error("Failed to get chat history", { error: error.message, filters });
      return [];
    }
  }

  /**
   * Delete a chat message by ID
   */
  async deleteMessage(messageId: string, userId?: string): Promise<boolean> {
    try {
      let query = "DELETE FROM chat_messages WHERE id = ?";
      const params: any[] = [messageId];

      // If userId provided, ensure user can only delete their own messages
      if (userId) {
        query += " AND user_id = ?";
        params.push(userId);
      }

      const stmt = this.db.prepare(query);
      const result = stmt.run(...params);
      return (result.changes || 0) > 0;
    } catch (error: any) {
      pceLogger.error("Failed to delete chat message", { error: error.message, messageId });
      return false;
    }
  }

  /**
   * Delete all chat history for a user
   */
  async deleteUserHistory(userId: string): Promise<number> {
    try {
      const stmt = this.db.prepare("DELETE FROM chat_messages WHERE user_id = ?");
      const result = stmt.run(userId);
      return result.changes || 0;
    } catch (error: any) {
      pceLogger.error("Failed to delete user chat history", { error: error.message, userId });
      return 0;
    }
  }

  /**
   * Delete all conversations and chat history for a user.
   * This is used by the dashboard "Delete all chats" action.
   */
  async deleteAllUserConversations(userId: string): Promise<{
    deletedConversations: number;
    deletedMessages: number;
  }> {
    try {
      // Delete all messages for this user
      const deleteMessagesStmt = this.db.prepare(
        "DELETE FROM chat_messages WHERE user_id = ?"
      );
      const messagesResult = deleteMessagesStmt.run(userId);

      // Delete all conversations for this user
      const deleteConversationsStmt = this.db.prepare(
        "DELETE FROM conversations WHERE user_id = ?"
      );
      const conversationsResult = deleteConversationsStmt.run(userId);

      // Clear last active conversation preference
      const clearPrefsStmt = this.db.prepare(
        "UPDATE user_preferences SET last_active_conversation_id = NULL WHERE user_id = ?"
      );
      clearPrefsStmt.run(userId);

      return {
        deletedConversations: conversationsResult.changes || 0,
        deletedMessages: messagesResult.changes || 0,
      };
    } catch (error: any) {
      pceLogger.error("Failed to delete all user conversations", {
        error: error.message,
        userId,
      });
      return {
        deletedConversations: 0,
        deletedMessages: 0,
      };
    }
  }

  /**
   * Get conversation count for a user
   */
  async getConversationCount(userId: string): Promise<number> {
    try {
      const stmt = this.db.prepare("SELECT COUNT(*) as count FROM conversations WHERE user_id = ?");
      const result = stmt.get(userId) as { count: number };
      return result?.count || 0;
    } catch (error: any) {
      pceLogger.error("Failed to get conversation count", { error: error.message, userId });
      return 0;
    }
  }

  /**
   * Migrate existing messages to a default conversation (for backward compatibility)
   * This handles the case where the database was created before conversations were added
   */
  async migrateExistingMessages(userId: string): Promise<void> {
    try {
      // Check if conversation_id column exists
      const tableInfo = this.db.prepare("PRAGMA table_info(chat_messages)").all() as any[];
      const hasConversationId = tableInfo.some(col => col.name === "conversation_id");
      
      if (!hasConversationId) {
        // Add conversation_id column if it doesn't exist
        this.db.exec(`
          ALTER TABLE chat_messages ADD COLUMN conversation_id TEXT;
          CREATE INDEX IF NOT EXISTS idx_conversation_id ON chat_messages(conversation_id);
        `);
      }

      // Check if there are messages without conversation_id
      const checkStmt = this.db.prepare(`
        SELECT COUNT(*) as count FROM chat_messages 
        WHERE user_id = ? AND (conversation_id IS NULL OR conversation_id = '')
      `);
      const result = checkStmt.get(userId) as { count: number };
      
      if (result.count === 0) {
        return; // No migration needed
      }

      // Create a default conversation for existing messages
      const defaultConvId = await this.createConversation(userId, "Previous Chat");
      
      // Update all messages without conversation_id
      const updateStmt = this.db.prepare(`
        UPDATE chat_messages 
        SET conversation_id = ? 
        WHERE user_id = ? AND (conversation_id IS NULL OR conversation_id = '')
      `);
      updateStmt.run(defaultConvId, userId);
      
      pceLogger.info("Migrated existing messages to default conversation", { userId, messageCount: result.count });
    } catch (error: any) {
      // If error is about column already existing, that's fine
      if (!error.message.includes("duplicate column")) {
        pceLogger.error("Failed to migrate existing messages", { error: error.message, userId });
      }
    }
  }

  /**
   * Get the last active conversation ID for a user
   */
  async getLastActiveConversation(userId: string): Promise<string | null> {
    try {
      const stmt = this.db.prepare(`
        SELECT last_active_conversation_id 
        FROM user_preferences 
        WHERE user_id = ?
      `);
      const row = stmt.get(userId) as { last_active_conversation_id: string | null } | undefined;
      return row?.last_active_conversation_id || null;
    } catch (error: any) {
      pceLogger.error("Failed to get last active conversation", { error: error.message, userId });
      return null;
    }
  }

  /**
   * Set the last active conversation ID for a user
   */
  async setLastActiveConversation(userId: string, conversationId: string | null): Promise<boolean> {
    try {
      const now = Date.now();
      const stmt = this.db.prepare(`
        INSERT INTO user_preferences (user_id, last_active_conversation_id, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          last_active_conversation_id = excluded.last_active_conversation_id,
          updated_at = excluded.updated_at
      `);
      stmt.run(userId, conversationId, now);
      return true;
    } catch (error: any) {
      pceLogger.error("Failed to set last active conversation", { error: error.message, userId, conversationId });
      return false;
    }
  }

  /**
   * Get structured user preferences
   */
  async getUserPreferences(userId: string): Promise<UserPreferences> {
    try {
      const stmt = this.db.prepare(`
        SELECT safe_mode, default_env, preferred_time_range, verbosity
        FROM user_preferences
        WHERE user_id = ?
      `);
      const row = stmt.get(userId) as {
        safe_mode?: number | null;
        default_env?: string | null;
        preferred_time_range?: string | null;
        verbosity?: VerbosityPreference | null;
      } | undefined;

      if (!row) return {};

      return {
        safeMode: row.safe_mode === null || row.safe_mode === undefined ? undefined : row.safe_mode === 1,
        defaultEnv: row.default_env || undefined,
        preferredTimeRange: row.preferred_time_range || undefined,
        verbosity: row.verbosity || undefined,
      };
    } catch (error: any) {
      pceLogger.error("Failed to get user preferences", { error: error.message, userId });
      return {};
    }
  }

  /**
   * Upsert user preferences (partial updates supported)
   */
  async setUserPreferences(userId: string, prefs: UserPreferences): Promise<boolean> {
    try {
      const now = Date.now();
      const stmt = this.db.prepare(`
        INSERT INTO user_preferences (
          user_id,
          safe_mode,
          default_env,
          preferred_time_range,
          verbosity,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          safe_mode = COALESCE(excluded.safe_mode, user_preferences.safe_mode),
          default_env = COALESCE(excluded.default_env, user_preferences.default_env),
          preferred_time_range = COALESCE(excluded.preferred_time_range, user_preferences.preferred_time_range),
          verbosity = COALESCE(excluded.verbosity, user_preferences.verbosity),
          updated_at = excluded.updated_at
      `);

      const safeModeValue = prefs.safeMode === undefined ? null : prefs.safeMode ? 1 : 0;
      stmt.run(
        userId,
        safeModeValue,
        prefs.defaultEnv ?? null,
        prefs.preferredTimeRange ?? null,
        prefs.verbosity ?? null,
        now
      );
      return true;
    } catch (error: any) {
      pceLogger.error("Failed to set user preferences", { error: error.message, userId });
      return false;
    }
  }

  /**
   * Get conversation context memory
   */
  async getConversationContext(conversationId: string): Promise<ConversationContext> {
    try {
      const stmt = this.db.prepare(`
        SELECT active_host, active_service, last_incident_signature, user_name, pending_action,
               pending_action_id, pending_action_digest, pending_action_created_at, pending_action_summary,
               pending_action_type, pending_action_preview, pending_action_execute_input, pending_action_expires_at
        FROM conversation_context
        WHERE conversation_id = ?
      `);
      const row = stmt.get(conversationId) as {
        active_host?: string | null;
        active_service?: string | null;
        last_incident_signature?: string | null;
        user_name?: string | null;
        pending_action?: string | null;
        pending_action_id?: string | null;
        pending_action_digest?: string | null;
        pending_action_created_at?: number | null;
        pending_action_summary?: string | null;
        pending_action_type?: string | null;
        pending_action_preview?: string | null;
        pending_action_execute_input?: string | null;
        pending_action_expires_at?: number | null;
      } | undefined;

      if (!row) return {};

      return {
        activeHost: row.active_host || undefined,
        activeService: row.active_service || undefined,
        lastIncidentSignature: row.last_incident_signature || undefined,
        userName: row.user_name || undefined,
        pendingAction: row.pending_action || undefined,
        pendingActionId: row.pending_action_id || undefined,
        pendingActionDigest: row.pending_action_digest || undefined,
        pendingActionCreatedAt: row.pending_action_created_at || undefined,
        pendingActionSummary: row.pending_action_summary || undefined,
        pendingActionType: row.pending_action_type || undefined,
        pendingActionPreview: row.pending_action_preview || undefined,
        pendingActionExecuteInput: row.pending_action_execute_input || undefined,
        pendingActionExpiresAt: row.pending_action_expires_at || undefined,
      };
    } catch (error: any) {
      pceLogger.error("Failed to get conversation context", { error: error.message, conversationId });
      return {};
    }
  }

  /**
   * Upsert conversation context memory (partial updates supported)
   * Applies allowlist + provenance logging.
   */
  async setConversationContext(
    conversationId: string,
    context: ConversationContext,
    source: MemoryUpdateSource,
    confidence: number,
    userId?: string
  ): Promise<boolean> {
    const allowedSources: MemoryUpdateSource[] = ["user_explicit", "policy_inference", "tool_verified"];
    if (!allowedSources.includes(source)) {
      pceLogger.warn("Memory update blocked due to unknown source", { source, conversationId });
      return false;
    }

    const allowedKeys: Array<keyof ConversationContext> = [
      "activeHost",
      "activeService",
      "lastIncidentSignature",
      "userName",
      "pendingAction",
      "pendingActionId",
      "pendingActionDigest",
      "pendingActionCreatedAt",
      "pendingActionSummary",
      "pendingActionType",
      "pendingActionPreview",
      "pendingActionExecuteInput",
      "pendingActionExpiresAt",
    ];

    const filtered: ConversationContext = {};
    for (const key of allowedKeys) {
      const value = context[key];
      if (value !== undefined) {
        (filtered as Record<string, ConversationContext[keyof ConversationContext]>)[key] = value;
      }
    }

    if (Object.keys(filtered).length === 0) {
      return true;
    }

    try {
      const now = Date.now();
      const stmt = this.db.prepare(`
        INSERT INTO conversation_context (
          conversation_id,
          active_host,
          active_service,
          last_incident_signature,
          user_name,
          pending_action,
          pending_action_id,
          pending_action_digest,
          pending_action_created_at,
          pending_action_summary,
          pending_action_type,
          pending_action_preview,
          pending_action_execute_input,
          pending_action_expires_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET
          active_host = COALESCE(excluded.active_host, conversation_context.active_host),
          active_service = COALESCE(excluded.active_service, conversation_context.active_service),
          last_incident_signature = COALESCE(excluded.last_incident_signature, conversation_context.last_incident_signature),
          user_name = COALESCE(excluded.user_name, conversation_context.user_name),
          pending_action = COALESCE(excluded.pending_action, conversation_context.pending_action),
          pending_action_id = COALESCE(excluded.pending_action_id, conversation_context.pending_action_id),
          pending_action_digest = COALESCE(excluded.pending_action_digest, conversation_context.pending_action_digest),
          pending_action_created_at = COALESCE(excluded.pending_action_created_at, conversation_context.pending_action_created_at),
          pending_action_summary = COALESCE(excluded.pending_action_summary, conversation_context.pending_action_summary),
          pending_action_type = COALESCE(excluded.pending_action_type, conversation_context.pending_action_type),
          pending_action_preview = COALESCE(excluded.pending_action_preview, conversation_context.pending_action_preview),
          pending_action_execute_input = COALESCE(excluded.pending_action_execute_input, conversation_context.pending_action_execute_input),
          pending_action_expires_at = COALESCE(excluded.pending_action_expires_at, conversation_context.pending_action_expires_at),
          updated_at = excluded.updated_at
      `);

      stmt.run(
        conversationId,
        filtered.activeHost ?? null,
        filtered.activeService ?? null,
        filtered.lastIncidentSignature ?? null,
        filtered.userName ?? null,
        filtered.pendingAction ?? null,
        filtered.pendingActionId ?? null,
        filtered.pendingActionDigest ?? null,
        filtered.pendingActionCreatedAt ?? null,
        filtered.pendingActionSummary ?? null,
        filtered.pendingActionType ?? null,
        filtered.pendingActionPreview ?? null,
        filtered.pendingActionExecuteInput ?? null,
        filtered.pendingActionExpiresAt ?? null,
        now
      );

      for (const [key, value] of Object.entries(filtered)) {
        await this.recordMemoryEvent({
          conversationId,
          userId,
          key,
          value,
          source,
          confidence,
        });
      }

      return true;
    } catch (error: any) {
      pceLogger.error("Failed to set conversation context", { error: error.message, conversationId });
      return false;
    }
  }

  async recordClarificationResponse(input: {
    conversationId: string;
    userId: string;
    clarificationId: string;
    optionId?: string;
    optionText: string;
    clarificationText?: string;
  }): Promise<string | null> {
    try {
      const id = crypto.randomUUID();
      const stmt = this.db.prepare(`
        INSERT INTO clarification_responses (
          id,
          conversation_id,
          user_id,
          clarification_id,
          option_id,
          option_text,
          clarification_text,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        id,
        input.conversationId,
        input.userId,
        input.clarificationId,
        input.optionId ?? null,
        input.optionText,
        input.clarificationText ?? null,
        Date.now()
      );
      return id;
    } catch (error: any) {
      pceLogger.warn("Failed to record clarification response", { error: error.message });
      return null;
    }
  }

  async getClarificationResponses(
    conversationId: string,
    limit: number = 50
  ): Promise<ClarificationResponse[]> {
    const stmt = this.db.prepare(`
      SELECT *
      FROM clarification_responses
      WHERE conversation_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(conversationId, limit) as any[];
    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      userId: row.user_id,
      clarificationId: row.clarification_id,
      optionId: row.option_id ?? undefined,
      optionText: row.option_text,
      clarificationText: row.clarification_text ?? undefined,
      createdAt: new Date(row.created_at),
    }));
  }

  private async recordMemoryEvent(event: {
    conversationId?: string;
    userId?: string;
    key: string;
    value: any;
    source: MemoryUpdateSource;
    confidence: number;
  }): Promise<void> {
    try {
      const id = crypto.randomUUID();
      const stmt = this.db.prepare(`
        INSERT INTO memory_events (id, conversation_id, user_id, key, value, source, confidence, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        id,
        event.conversationId ?? null,
        event.userId ?? null,
        event.key,
        typeof event.value === "string" ? event.value : JSON.stringify(event.value),
        event.source,
        event.confidence,
        Date.now()
      );
    } catch (error: any) {
      pceLogger.warn("Failed to record memory event", { error: error.message });
    }
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}
