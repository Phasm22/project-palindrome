import { EventEmitter } from "events";
import type { AgentEventData, ToolProgressPayload } from "./event-payloads";

/**
 * Agent Event Types
 */
export type AgentEventType =
  | "tool:start"
  | "tool:progress"
  | "tool:complete"
  | "llm:token"
  | "llm:thinking"
  | "agent:step"
  | "agent:final"
  | "agent:plan";

/**
 * Tool Progress Status
 */
export type ToolProgressStatus =
  | "starting"
  | "running"
  | "waiting"
  | "verifying"
  | "completed"
  | "failed";

export interface ToolProgressData {
  toolName: string;
  action?: string;
  status: ToolProgressStatus;
  message: string;
  progress?: number; // 0-1
  details?: Record<string, any>;
}

export interface AgentEvent {
  type: AgentEventType;
  sessionId?: string;
  timestamp: number;
  data: AgentEventData;
}

/**
 * Single Event Bus for Agent Events
 * 
 * All agent events flow through this single pipeline:
 * runner.ts emits → event-bus broadcasts → SSE/WebSocket pushes → CLI & dashboard receive
 */
export class AgentEventBus extends EventEmitter {
  private static instance: AgentEventBus | null = null;

  static getInstance(): AgentEventBus {
    if (!AgentEventBus.instance) {
      AgentEventBus.instance = new AgentEventBus();
    }
    return AgentEventBus.instance;
  }

  /**
   * Emit an agent event
   */
  override emit(eventName: string | symbol, ...args: any[]): boolean;
  override emit(event: AgentEvent): boolean;
  override emit(eventOrName: string | symbol | AgentEvent, ...args: any[]): boolean {
    if (typeof eventOrName === "object" && eventOrName !== null && "type" in eventOrName) {
      return super.emit("agent-event", eventOrName as AgentEvent);
    }
    return super.emit(eventOrName as string | symbol, ...args);
  }

  /**
   * Subscribe to all agent events
   */
  onEvent(handler: (event: AgentEvent) => void): () => void {
    this.on("agent-event", handler);
    return () => this.off("agent-event", handler);
  }

  /**
   * Subscribe to specific event types
   */
  onType(type: AgentEventType | AgentEventType[], handler: (event: AgentEvent) => void): () => void {
    const types = Array.isArray(type) ? type : [type];
    const wrappedHandler = (event: AgentEvent) => {
      if (types.includes(event.type)) {
        handler(event);
      }
    };
    this.on("agent-event", wrappedHandler);
    return () => this.off("agent-event", wrappedHandler);
  }

  /**
   * Emit a tool progress event
   * Helper for tools to report progress during long-running operations
   */
  emitProgress(progress: ToolProgressData, sessionId?: string): void {
    const payload: ToolProgressPayload = {
      type: "tool:progress",
      ...progress,
    };
    this.emit({
      type: "tool:progress",
      sessionId,
      timestamp: Date.now(),
      data: payload,
    });
  }
}

/**
 * Helper function for tools to emit progress events
 * Can be called from anywhere without needing the session context
 * Note: Without sessionId, events will be broadcast to ALL SSE clients
 */
export function emitToolProgress(progress: ToolProgressData, sessionId?: string): void {
  AgentEventBus.getInstance().emitProgress(progress, sessionId);
}
