import { EventEmitter } from "events";

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
  | "agent:final";

export interface AgentEvent {
  type: AgentEventType;
  sessionId?: string;
  timestamp: number;
  data: Record<string, any>;
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
  emit(event: AgentEvent): boolean {
    return super.emit("agent-event", event);
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
}

