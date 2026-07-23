/**
 * Webhook Listener
 * Task 12.1: Define Real-Time Ingestion Queue and Webhook Listener
 * Lightweight HTTP listener to receive external change events
 */

import type { Server } from "bun";
import { pceLogger } from "../utils/logger";
import { RealtimeIngestionQueue, type WebhookPayload } from "./queue";

export interface WebhookListenerOptions {
  port?: number;
  hostname?: string;
  path?: string;
  secret?: string; // Optional webhook secret for validation
}

/**
 * HTTP Webhook Listener for Real-Time Ingestion
 */
export class WebhookListener {
  private server: Server<any> | null = null;
  private queue: RealtimeIngestionQueue;
  private options: Required<WebhookListenerOptions>;

  constructor(queue: RealtimeIngestionQueue, options: WebhookListenerOptions = {}) {
    this.queue = queue;
    this.options = {
      port: options.port ?? 3001,
      hostname: options.hostname ?? "127.0.0.1",
      path: options.path || "/webhook",
      secret: options.secret || "",
    };
  }

  /**
   * Start the webhook listener server
   */
  async start(): Promise<void> {
    if (this.server) {
      throw new Error("Webhook listener is already running");
    }

    const queue = this.queue;
    const path = this.options.path;
    const validatePayload = this.validatePayload.bind(this);

    this.server = Bun.serve({
      port: this.options.port,
      hostname: this.options.hostname,
      async fetch(req) {
        const url = new URL(req.url);

        // Only accept POST requests to the webhook path
        if (req.method !== "POST" || url.pathname !== path) {
          return new Response("Not Found", { status: 404 });
        }

        try {
          // Parse webhook payload
          const body = await req.json();
          
          // Validate payload structure
          const payload = validatePayload(body);
          
          // Enqueue for processing
          const queueId = await queue.enqueue(payload);

          pceLogger.info(`Webhook received and enqueued`, {
            queueId,
            eventType: payload.eventType,
            source: req.headers.get("user-agent") || "unknown",
          });

          return new Response(
            JSON.stringify({
              success: true,
              queueId,
              message: "Webhook received and queued for processing",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        } catch (error: any) {
          pceLogger.error(`Webhook processing error`, {
            error: error.message,
            path: url.pathname,
          });

          return new Response(
            JSON.stringify({
              success: false,
              error: error.message,
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }
          );
        }
      },
    });

    pceLogger.info(`Webhook listener started`, {
      port: this.server.port,
      hostname: this.options.hostname,
      path: this.options.path,
      url: `http://${this.options.hostname}:${this.server.port}${this.options.path}`,
    });
  }

  /**
   * Stop the webhook listener
   */
  async stop(): Promise<void> {
    if (this.server) {
      this.server.stop();
      this.server = null;
      pceLogger.info("Webhook listener stopped");
    }
  }

  /**
   * Validate and normalize webhook payload
   */
  private validatePayload(body: any): WebhookPayload {
    // Required fields
    if (!body.documentType || !body.aclGroup || !body.eventType) {
      throw new Error("Missing required fields: documentType, aclGroup, eventType");
    }

    // Validate eventType
    if (!["create", "update", "delete"].includes(body.eventType)) {
      throw new Error(`Invalid eventType: ${body.eventType}. Must be one of: create, update, delete`);
    }

    // Must have either documentPath or documentContent
    if (!body.documentPath && !body.documentContent) {
      throw new Error("Must provide either documentPath or documentContent");
    }

    return {
      documentPath: body.documentPath,
      documentContent: body.documentContent,
      documentType: body.documentType,
      aclGroup: body.aclGroup,
      eventType: body.eventType,
      metadata: body.metadata || {},
    };
  }

  /**
   * Get server info
   */
  getInfo(): { hostname: string; port: number; path: string; running: boolean } {
    return {
      hostname: this.options.hostname,
      port: this.server?.port ?? this.options.port,
      path: this.options.path,
      running: this.server !== null,
    };
  }
}
