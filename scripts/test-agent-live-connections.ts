#!/usr/bin/env bun

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ConnectionEndpoint } from "../src/types/connections";

const execFileAsync = promisify(execFile);
const API_BASE = process.env.PCE_API_URL || "http://localhost:4000";
const USER_ID = `live-agent-${Date.now()}`;
const NODE = process.env.LIVE_TEST_NODE || "YANG";
const CLEANUP_VM = process.argv.find((argument) => argument.startsWith("--cleanup-vm="))?.split("=", 2)[1];
const RESUME_VM = process.argv.find((argument) => argument.startsWith("--resume-vm="))?.split("=", 2)[1];
const DRY_RUN_ONLY = process.argv.includes("--dry-run-only");
const VM_NAME = CLEANUP_VM || RESUME_VM || `livecheck-${Date.now().toString(36)}`;
const TURN_TIMEOUT_MS = Number(process.env.LIVE_TEST_TURN_TIMEOUT_MS || 15 * 60_000);

type Message = {
  role: "user" | "assistant";
  content: string;
  structuredResponse?: any;
};

type TurnResult = {
  conversationId: string;
  sessionId: string;
  message: Message;
  durationMs: number;
};

const phases: Array<{ name: string; durationMs: number; detail: string }> = [];
const observations: string[] = [];

function assertLiveFlag(): void {
  if (!process.argv.includes("--execute-live")) {
    throw new Error("Refusing to mutate infrastructure without --execute-live");
  }
}

async function getMessages(conversationId: string): Promise<Message[]> {
  const response = await fetch(`${API_BASE}/api/chat/conversations/${conversationId}/messages?userId=${encodeURIComponent(USER_ID)}&limit=100`);
  if (!response.ok) throw new Error(`Message API returned HTTP ${response.status}`);
  const payload = await response.json() as { data?: Message[] };
  return payload.data ?? [];
}

async function waitForNewAssistant(conversationId: string, baseline: number): Promise<Message> {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const messages = await getMessages(conversationId);
    const additions = messages.slice(baseline);
    const assistant = additions.findLast((message) => message.role === "assistant");
    if (assistant) return assistant;
    await Bun.sleep(1000);
  }
  throw new Error(`Timed out after ${TURN_TIMEOUT_MS / 1000}s waiting for the agent`);
}

async function runTurn(prompt: string, conversationId?: string): Promise<TurnResult> {
  const baseline = conversationId ? (await getMessages(conversationId)).length : 0;
  const sessionId = `live-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  const response = await fetch(`${API_BASE}/api/agent/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: prompt,
      userId: USER_ID,
      aclGroup: "admin",
      sessionId,
      ...(conversationId ? { conversationId } : {}),
    }),
  });
  const body = await response.json().catch(() => ({})) as any;
  if (!response.ok) throw new Error(`Agent API returned HTTP ${response.status}: ${body.error || "unknown error"}`);
  const resolvedConversationId = body.conversationId as string | undefined;
  if (!resolvedConversationId) throw new Error("Agent API did not return a conversation ID");
  const message = await waitForNewAssistant(resolvedConversationId, baseline);
  return {
    conversationId: resolvedConversationId,
    sessionId: body.sessionId || sessionId,
    message,
    durationMs: Date.now() - startedAt,
  };
}

async function runConfirmedTurn(prompt: string, conversationId?: string): Promise<TurnResult> {
  const proposal = await runTurn(prompt, conversationId);
  const confirmationId = proposal.message.content.match(/CONFIRM\s+([a-z0-9_-]+)/i)?.[1];
  if (!confirmationId) return proposal;
  phases.push({ name: "confirmation", durationMs: proposal.durationMs, detail: `Confirmation requested for ${prompt.slice(0, 60)}` });
  return runTurn(`CONFIRM ${confirmationId}`, proposal.conversationId);
}

function connectionEndpoints(message: Message): ConnectionEndpoint[] {
  const sections = message.structuredResponse?.answer?.sections;
  if (!Array.isArray(sections)) return [];
  return sections
    .filter((section: any) => section?.type === "connections" && Array.isArray(section.data))
    .flatMap((section: any) => section.data) as ConnectionEndpoint[];
}

function requireConnections(
  endpoints: ConnectionEndpoint[],
  protocol: "ssh" | "http",
  port: number
): [ConnectionEndpoint, ConnectionEndpoint] {
  const matches = endpoints.filter((endpoint) =>
    endpoint.protocol === protocol && endpoint.port === port && endpoint.status === "verified"
  );
  const dns = matches.find((endpoint) => endpoint.addressType === "dns");
  const ip = matches.find((endpoint) => endpoint.addressType === "ip");
  if (!dns || !ip) {
    throw new Error(`Expected verified DNS and IP ${protocol.toUpperCase()}/${port} endpoints; received ${JSON.stringify(matches)}`);
  }
  return [dns, ip];
}

async function independentlyVerifySsh(endpoint: ConnectionEndpoint): Promise<void> {
  if (!/^[a-zA-Z0-9.:-]+$/.test(endpoint.host)) throw new Error(`Unsafe SSH host: ${endpoint.host}`);
  await execFileAsync("ssh", [
    "-p", String(endpoint.port),
    "-o", "ConnectTimeout=10",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    `${endpoint.username || "ops"}@${endpoint.host}`,
    "hostname",
  ], { timeout: 15_000 });
}

async function independentlyVerifyHttp(endpoint: ConnectionEndpoint): Promise<void> {
  const response = await fetch(endpoint.value, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
  await response.body?.cancel().catch(() => {});
  if (response.status < 200 || response.status >= 400) {
    throw new Error(`${endpoint.value} returned HTTP ${response.status}`);
  }
}

async function verifyCleanup(): Promise<void> {
  const { stdout } = await execFileAsync("terraform", ["-chdir=lab-infra/terraform", "state", "list"], { timeout: 30_000 });
  if (stdout.includes(`[\"${VM_NAME}\"]`)) throw new Error(`${VM_NAME} remains in Terraform state`);
  const dnsServer = process.env.LIVE_TEST_DNS_SERVER || "172.16.0.13";
  const dns = await execFileAsync("dig", [`@${dnsServer}`, "+short", `${VM_NAME}.prox`], { timeout: 10_000 });
  if (dns.stdout.trim()) throw new Error(`${VM_NAME}.prox still resolves to ${dns.stdout.trim()}`);
}

async function writeReport(success: boolean, error?: unknown): Promise<string> {
  const reportPath = join("docs", "tests", `agent-live-vm-connections-${new Date().toISOString().slice(0, 10)}.md`);
  await mkdir(join("docs", "tests"), { recursive: true });
  const lines = [
    "# Agent Live VM Connection Test",
    "",
    `- Timestamp: ${new Date().toISOString()}`,
    `- Result: ${success ? "PASS" : "FAIL"}`,
    `- Agent API user: ${USER_ID}`,
    `- Proxmox target: ${NODE}`,
    `- Disposable VM: ${VM_NAME}`,
    `- Error: ${error ? String(error instanceof Error ? error.message : error) : "None"}`,
    "",
    "## Phase timings",
    "",
    "| Phase | Duration | Detail |",
    "|---|---:|---|",
    ...phases.map((phase) => `| ${phase.name} | ${(phase.durationMs / 1000).toFixed(2)}s | ${phase.detail.replace(/\|/g, "\\|")} |`),
    "",
    "## Operational observations",
    "",
    ...observations.map((item) => `- ${item}`),
    "- The configured `PROXMOX_YIN_URL` currently reaches the YANG endpoint; cluster reads work, but the configuration should be corrected.",
    "- Existing Terraform state contains stale cloud-config entries and conflicting historical VM-ID observations; no unrelated state was repaired by this test.",
    "- Infrastructure turns require longer polling than the legacy 25-second agent API test timeout.",
    "",
    "Secrets and public-key material are intentionally omitted.",
    "",
  ];
  await writeFile(reportPath, lines.join("\n"), "utf8");
  return reportPath;
}

async function main(): Promise<void> {
  assertLiveFlag();
  let conversationId: string | undefined;
  let created = false;
  let success = false;
  let failure: unknown;

  try {
    const health = await fetch(`${API_BASE}/health`).then((response) => response.json()) as any;
    if (health?.success !== true) throw new Error("PCE API health check failed");

    if (CLEANUP_VM) {
      created = true;
      const cleanup = await runConfirmedTurn(`Destroy VM ${VM_NAME} on ${NODE}. This is guarded cleanup for a failed live test.`);
      phases.push({ name: "explicit cleanup", durationMs: cleanup.durationMs, detail: cleanup.message.content.slice(0, 120) });
      if (!/destroyed successfully/i.test(cleanup.message.content)) {
        throw new Error(`Explicit cleanup did not report success: ${cleanup.message.content}`);
      }
      created = false;
      await verifyCleanup();
      observations.push("Explicit guarded agent cleanup removed the disposable VM and DNS record.");
      success = true;
      return;
    }

    if (RESUME_VM) {
      created = true;
      observations.push("Resumed the live lifecycle using the VM preserved after a stalled nginx planning turn.");
    } else {
    // Arm cleanup even for the preview gate: if dry-run intent is ever lost in
    // routing or confirmation replay, the disposable target may have mutated.
    created = true;
    const dryRun = await runConfirmedTurn(
      `Dry-run: create VM ${VM_NAME} on ${NODE} with 1 core, 1024 MB RAM, 8G disk, SSH user ops, no bootstrap. Do not apply changes.`,
      conversationId
    );
    conversationId = dryRun.conversationId;
    phases.push({ name: "create dry-run", durationMs: dryRun.durationMs, detail: dryRun.message.content.slice(0, 120) });
    if (!/dry.?run successful|would create/i.test(dryRun.message.content)) {
      throw new Error(`Creation safety dry-run did not succeed: ${dryRun.message.content}`);
    }
    created = false;
    if (DRY_RUN_ONLY) {
      await verifyCleanup();
      observations.push("Agent dry-run completed without creating Terraform state or DNS.");
      success = true;
      return;
    }

    const createdTurn = await runConfirmedTurn(
      `Create VM ${VM_NAME} on ${NODE} with 1 core, 1024 MB RAM, 8G disk, SSH user ops, no bootstrap.`,
      conversationId
    );
    // Once the mutating turn starts, assume cleanup may be necessary even if the
    // final wording or post-create verification fails.
    created = true;
    conversationId = createdTurn.conversationId;
    phases.push({ name: "create + verify SSH", durationMs: createdTurn.durationMs, detail: createdTurn.message.content.slice(0, 120) });
    if (!/created successfully/i.test(createdTurn.message.content)) {
      throw new Error(`VM creation did not report success: ${createdTurn.message.content}`);
    }
    const [sshDns, sshIp] = requireConnections(connectionEndpoints(createdTurn.message), "ssh", 22);
    await independentlyVerifySsh(sshDns);
    await independentlyVerifySsh(sshIp);
    observations.push("Authenticated SSH succeeded independently through both DNS and IP endpoints.");
    }

    const nginxTurn = await runConfirmedTurn(`Install nginx on ${VM_NAME} and verify its connection URLs.`, conversationId);
    conversationId = nginxTurn.conversationId;
    phases.push({ name: "nginx + verify HTTP", durationMs: nginxTurn.durationMs, detail: nginxTurn.message.content.slice(0, 120) });
    const [httpDns, httpIp] = requireConnections(connectionEndpoints(nginxTurn.message), "http", 80);
    await independentlyVerifyHttp(httpDns);
    await independentlyVerifyHttp(httpIp);
    observations.push("Nginx returned a successful HTTP response independently through both DNS and IP URLs.");

    const destroyTurn = await runConfirmedTurn(`Destroy VM ${VM_NAME} on ${NODE}.`, conversationId);
    conversationId = destroyTurn.conversationId;
    phases.push({ name: "destroy", durationMs: destroyTurn.durationMs, detail: destroyTurn.message.content.slice(0, 120) });
    if (!/destroyed successfully|successfully destroyed/i.test(destroyTurn.message.content)) {
      throw new Error(`VM destruction did not report success: ${destroyTurn.message.content}`);
    }
    created = false;
    await verifyCleanup();
    observations.push("Terraform state and DNS no longer contain the disposable VM after destruction.");
    success = true;
  } catch (error) {
    failure = error;
    observations.push(`Primary lifecycle failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (created) {
      try {
        const cleanup = await runConfirmedTurn(`Destroy VM ${VM_NAME} on ${NODE}. This is cleanup for a failed live test.`, conversationId);
        phases.push({ name: "failure cleanup", durationMs: cleanup.durationMs, detail: cleanup.message.content.slice(0, 120) });
        created = false;
        await verifyCleanup();
        observations.push("Guarded agent cleanup removed the disposable VM after a test failure.");
      } catch (cleanupError) {
        observations.push(`URGENT: guarded cleanup failed for ${VM_NAME}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
      }
    }
    const report = await writeReport(success, failure);
    console.log(JSON.stringify({ success, vmName: VM_NAME, node: NODE, report, phases, observations }, null, 2));
  }

  if (!success) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
