import { Database } from "bun:sqlite";
import type { ACLGroup } from "../types";
import type { ApiHistoryEntry, ApiQueryResponse } from "./types";
import { pceLogger } from "../utils/logger";
import { mkdirSync } from "fs";
import { dirname } from "path";

export interface ChatMessage {
  id: string;
  conversationId: string;
  userId: string;
  aclGroup: ACLGroup;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  response?: ApiQueryResponse; // For assistant messages
  reasoningTraceId?: string; // Link to reasoning trace for assistant messages
}

export interface Conversation {
  id: string;
  userId: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
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
        updated_at INTEGER NOT NULL
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
        this.migrateExistingMessages();
      }
      
      if (!hasReasoningTraceId) {
        pceLogger.info("Migrating chat_messages table: adding reasoning_trace_id column");
        this.db.exec(`
          ALTER TABLE chat_messages ADD COLUMN reasoning_trace_id TEXT;
          CREATE INDEX IF NOT EXISTS idx_reasoning_trace_id ON chat_messages(reasoning_trace_id);
        `);
      }
    } catch (error: any) {
      // If column already exists, that's fine
      if (!error.message.includes("duplicate column")) {
        pceLogger.error("Failed to add columns to chat_messages", { error: error.message });
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
  }

  /**
   * Migrate existing messages without conversation_id to a default conversation
   */
  private migrateExistingMessages() {
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
  async createConversation(userId: string, title?: string): Promise<string> {
    const id = crypto.randomUUID();
    const now = Date.now();
    const conversationTitle = title || `Chat ${new Date(now).toLocaleString()}`;
    
    const stmt = this.db.prepare(`
      INSERT INTO conversations (id, user_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    try {
      stmt.run(id, userId, conversationTitle, now, now);
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
      (id, conversation_id, user_id, acl_group, role, content, response_data, timestamp, reasoning_trace_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}

