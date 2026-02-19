import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BaseTool } from "./BaseTool";
import {
  RunDiagnosticParams,
  RunDiagnosticJSONSchema,
  isHostLike,
  type RunDiagnosticParamsType,
} from "./schemas/run-diagnostic";
import type { ExecutionContext, ExecutionResult } from "../types";

const execFileAsync = promisify(execFile);

function sanitizeTarget(command: string, target: string): string {
  if (command === "http_check") {
    try {
      const url = new URL(target);
      return url.toString();
    } catch {
      throw new Error("http_check requires a valid URL");
    }
  }

  if (!isHostLike(target)) {
    throw new Error("Host-only commands require a simple hostname or IP address");
  }
  return target;
}

export class RunDiagnosticTool extends BaseTool {
  constructor() {
    super({
      name: "run_diagnostic_command",
      description: "Runs safelisted diagnostics (ping, traceroute, HTTP health checks)",
      categories: ["diagnostics", "network"],
      parameters: RunDiagnosticJSONSchema,
      allowedAcls: ["admin", "ops", "sre"],
      risk: "medium",
    });
  }

  async execute(params: Record<string, any>, context: ExecutionContext): Promise<ExecutionResult> {
    const parsed = RunDiagnosticParams.safeParse(params);
    if (!parsed.success) {
      return { error: parsed.error.message };
    }

    const payload = parsed.data;
    const started = context.startedAt ?? Date.now();

    try {
      const target = sanitizeTarget(payload.command, payload.target.trim());
      let data;

      if (payload.command === "ping") {
        data = await this.runPing(target, payload);
      } else if (payload.command === "traceroute") {
        data = await this.runTraceroute(target, payload);
      } else {
        data = await this.runHttpCheck(target, payload);
      }

      return {
        data: {
          ...data,
          command: payload.command,
          target,
          observedAt: new Date().toISOString(),
        },
        durationMs: Date.now() - started,
      };
    } catch (error: any) {
      return {
        error: error.message ?? "Diagnostic command failed",
        durationMs: Date.now() - (context.startedAt ?? Date.now()),
      };
    }
  }

  private async runPing(target: string, payload: RunDiagnosticParamsType) {
    const args = ["-c", String(payload.packets), target];
    const { stdout } = await execFileAsync("ping", args, { timeout: payload.timeoutMs });
    const latencyMatch = stdout.match(/min\/avg\/max.* = .*\/(.*)\//);
    const averageLatency = latencyMatch?.[1] ? parseFloat(latencyMatch[1]) : null;

    return {
      summary: averageLatency
        ? `Average latency ${averageLatency.toFixed(2)} ms`
        : "Ping completed",
      stdout,
      metrics: {
        packets: payload.packets,
        averageLatencyMs: averageLatency,
      },
    };
  }

  private async runTraceroute(target: string, payload: RunDiagnosticParamsType) {
    const args = ["-m", String(payload.maxHops), target];
    const { stdout } = await execFileAsync("traceroute", args, { timeout: payload.timeoutMs });
    const hops = stdout
      .split("\n")
      .filter((line) => /^\s*\d+/.test(line))
      .map((line) => line.trim());

    return {
      summary: `Traceroute captured ${hops.length} hops`,
      stdout,
      metrics: {
        hops,
        maxHops: payload.maxHops,
      },
    };
  }

  private async runHttpCheck(target: string, payload: RunDiagnosticParamsType) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), payload.timeoutMs);
    const started = Date.now();

    try {
      const response = await fetch(target, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
      });
      const elapsed = Date.now() - started;
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      // Determine if site is "up" - 2xx and 3xx are considered up
      const isUp = response.status >= 200 && response.status < 400;
      const location = response.headers.get("location");
      
      let summary: string;
      if (isUp) {
        if (response.status >= 300 && response.status < 400 && location) {
          summary = `Site is UP and responding (HTTP ${response.status} redirect to ${location}) in ${elapsed}ms`;
        } else {
          summary = `Site is UP and responding (HTTP ${response.status}) in ${elapsed}ms`;
        }
      } else {
        summary = `Site returned HTTP ${response.status} (${response.statusText}) in ${elapsed}ms - may be down or experiencing issues`;
      }

      return {
        summary,
        isUp,
        http: {
          statusCode: response.status,
          statusText: response.statusText,
          latencyMs: elapsed,
          location: location || undefined,
          headers,
        },
      };
    } catch (error: any) {
      // Network errors, timeouts, etc. mean the site is down
      const elapsed = Date.now() - started;
      return {
        summary: `Site is DOWN - ${error.name === "AbortError" ? "Request timed out" : error.message} (after ${elapsed}ms)`,
        isUp: false,
        http: {
          error: error.name === "AbortError" ? "Timeout" : error.message,
          latencyMs: elapsed,
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
