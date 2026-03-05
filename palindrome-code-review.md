# Palindrome — Code Review & Next Iteration Roadmap

---

## Executive Summary

You've built something legitimately impressive for a solo homelab project. The ingestion pipeline (Qdrant + Neo4j + hybrid RAG), the reasoning trace system, the tool policy / confirmation guard, and the api-discovery framework are all well-architected. The bones are solid.

The issues you're feeling — inconsistent formatting, choppy conversations, LLM output variance, and the action layer feeling like a cage — are all real and all fixable. They share a common root: the agent loop grew organically and now has too many code paths that each behave slightly differently, and the action layer was designed to be safe but not extensible.

This document covers: what's causing each problem, what to fix immediately, and where to take this next.

---

## Part 1 — Code Review

### 1. `runner.ts` is a 3,550-line god file

Every concern lives here: intent classification, five domain-specific detectors, RAG retrieval, the LLM loop, tool execution, confirmation/clarification flow, reasoning trace recording, and response formatting. This makes it hard to test individual concerns, hard to reason about execution order, and the source of most of the UX bugs.

**Specific sub-problem:** There are roughly 15 early-return paths in `runner.ts`. Each one formats its response differently:
- Social chat: hardcoded `"Hi — what do you want to check or change in your lab?"`
- VM create: `"VMCreate | node=... | name=... | vmid=..."`
- Compute intent chain: goes through `formatResponseForBot()`
- Clarification: raw question from `ask_missing` tool
- RAG low-confidence: goes through `formatResponseForBot()` after `cleanupRagAnswer()`
- Subnet sizing: a custom `SubnetSizing | ...` pipe format

This is the source of your formatting inconsistency. The LLM isn't the problem — the dispatch architecture is.

### 2. Double LLM call on every response

`formatResponseForBot()` makes a **second** `gpt-4o-mini` call to reformat whatever the main agent produced. This means:

- Every substantive response costs 2× the API calls
- Adds ~300–700ms of latency per response
- Introduces a second source of non-determinism — you're asking one LLM to rewrite another LLM's output

The three `ResponseMode` prompts (TERSE_DATA, ASSISTIVE, EXPLAINER) are good ideas, but the implementation of calling the API twice to achieve them is the wrong architecture. The fix is to embed the mode's formatting instructions into the main system prompt so you get the right format in a single call.

### 3. Five independent intent detectors in a waterfall

Before the LLM loop runs, five regex/rule-based detectors execute in order:

```
detectActionIntent → detectExposureIntent → detectComputeIntent →
detectFirewallIntent → detectNetworkIntent
```

These run **in addition to** the probabilistic classifier (`classifyAndRoute`). That's six intent classification systems. The ordering is critical and fragile — a query that matches `detectComputeIntent` never reaches the LLM tool loop, even if the LLM would have done something better. The waterfall also explains why some queries feel "bypassed": they hit a domain chain that answers deterministically without LLM reasoning.

The detectors exist because the LLM-only path was inconsistent. That's valid — but the right fix is better prompting with structured output on the primary call, not five pre-filters.

### 4. `cleanupRagAnswer()` is a symptom, not a fix

80+ lines of regexes exist specifically to clean up inconsistent LLM output from the RAG layer. Removing `[Source N]` citations, stripping verbose explanations, collapsing redundant memory patterns. This is the code equivalent of spraying air freshener instead of taking out the trash. The real fix is a tighter prompt that specifies output format, making the cleanup unnecessary.

### 5. Conversation continuity is client-reconstructed

`conversationHistory` is passed in by the client with each request. The agent creates a fresh `AgentContext` every call and reconstructs context from the passed array. The `chat-history-store.ts` exists at the API layer but isn't fed back into the agent loop in a way that gives the LLM genuine thread continuity.

In practice: if the client drops state, context is gone. The LLM has no persistent memory of what it just said. This is why multi-turn conversations feel choppy — every turn, the LLM is starting from a reconstructed snapshot rather than an organic conversation.

### 6. Streaming is completely disabled

The code explicitly logs: *"Streaming mode is not available with tool orchestration; defaulting to non-streaming mode."*

For queries that involve multiple tool calls (VM inventory across 3 nodes, firewall rule analysis, create VM + DNS), this means the user stares at a blank for 10–20 seconds. The `AgentEventBus` already emits `agent:step` and `tool:start/complete` events — the infrastructure is there. It just isn't wired to SSE output.

### 7. The action layer's IaC prison

The `registry.ts` hardcodes 10 actions. The Terraform runner manages VM creation by reading/writing a `terraform.tfvars.json` file. To create a VM, you add an entry to that JSON in a fixed schema — meaning you can only create VMs that match the template's shape. Want a VM with more RAM, a different VLAN, a different OS image, a GPU passthrough? You have to touch the Terraform templates and potentially the schema.

The Ansible actions (`install_docker`, `install_nginx`, `bootstrap`, `configure_firewall`, `set_static_ip`) are similarly hardcoded — one function per action. There's no composition.

The api-discovery framework (`src/tools/api-discovery/`) was built precisely to solve the scalability problem — it can probe the Proxmox and OPNsense APIs to discover what they actually support. But it isn't wired to the action layer. It generates discovery reports to `docs/` but doesn't dynamically expand what the agent can do.

### 8. Model hardcoded, no upgrade path

`const MODEL_ID = "gpt-4o-mini"` is set at the top of `runner.ts` and the formatter uses the same model. For firewall exposure analysis or attack path reasoning, a more capable model would give meaningfully better results. There's no per-query model selection or escalation path.

---

## Part 2 — What to Fix First (Your Stated Gripes)

### Fix 1: Formatting Inconsistency

**Root cause:** 15 early-return paths each produce different output formats, and a second LLM call adds variance on top.

**Fix:** Define a single `AgentResponseShape` type and run every exit path through one serializer.

```typescript
// src/agent/response-serializer.ts
export type ResponseShape =
  | { type: "action_result"; action: string; status: "ok" | "error"; fields: Record<string, string> }
  | { type: "query_result"; data: string; mode: ResponseMode }
  | { type: "clarification"; question: string }
  | { type: "confirmation_request"; id: string; preview: string; expiresAt: number }
  | { type: "error"; message: string };

export function serializeResponse(shape: ResponseShape): string {
  switch (shape.type) {
    case "action_result":
      const prefix = shape.status === "ok" ? shape.action : `Error | action=${shape.action}`;
      const parts = Object.entries(shape.fields).map(([k, v]) => `${k}=${v}`);
      return [prefix, ...parts].join(" | ");
    case "query_result":
      return shape.data; // already formatted upstream
    case "clarification":
      return shape.question;
    // etc.
  }
}
```

All 15 code paths route through this. The output is now type-enforced and consistent.

### Fix 2: Eliminate the Double LLM Call

Move the ResponseMode instructions into the **system prompt itself**, conditioned on the detected mode. The formatter call goes away entirely.

```typescript
// In SYSTEM_PROMPT, add a dynamic section:
const modeInstructions = {
  TERSE_DATA: "Format all responses as structured pipe-delimited data. No narrative.",
  ASSISTIVE: "Format: Answer (1 sentence), Evidence (2-5 bullets), Next steps (1-3 bullets if relevant).",
  EXPLAINER: "Format: Answer (1-2 sentences), Why this matters (1-2 sentences), Runbook (3-6 steps).",
};

const systemPrompt = `${BASE_SYSTEM_PROMPT}\n\nResponse format: ${modeInstructions[mode ?? "ASSISTIVE"]}`;
```

One call. Consistent output. ~500ms faster per response.

### Fix 3: Conversation Continuity

Persist conversation on the server side, keyed by `conversationId`. Load it at the start of `runAgent` instead of relying on the client.

```typescript
// At the start of runAgent:
const storedHistory = await chatHistoryStore.getHistory(options.conversationId);
const effectiveHistory = storedHistory ?? options.conversationHistory ?? [];

// At the end, before returning:
await chatHistoryStore.appendTurn(options.conversationId, {
  user: userInput,
  assistant: finalText,
  timestamp: Date.now(),
});
```

The `ChatHistoryStore` already exists. You're just not using it in the agent loop.

### Fix 4: Wire Streaming to the Event Bus

The `AgentEventBus` emits events at every step. The SSE endpoint just needs to relay them.

```typescript
// In the SSE endpoint handler:
const sub = eventBus.subscribe(sessionId, (event) => {
  if (event.type === "agent:step") {
    res.write(`data: ${JSON.stringify({ type: "thinking", step: event.data.step })}\n\n`);
  }
  if (event.type === "tool:start") {
    res.write(`data: ${JSON.stringify({ type: "tool", name: event.data.toolName })}\n\n`);
  }
  if (event.type === "agent:final") {
    res.write(`data: ${JSON.stringify({ type: "done", text: event.data.text })}\n\n`);
    res.end();
  }
});
```

The dashboard already consumes SSE. You're one subscription away from a live "thinking..." indicator.

---

## Part 3 — The Action Layer: How to Escape the IaC Prison

This is your most interesting architectural question. You're right that it "defeats the purpose somewhat" to have a natural language interface that can only do things you pre-coded. Here's the path out:

### Step 1: Decouple lifecycle from provisioning

**Right now:** All VM operations (including start/stop/restart) are routed through the `action` tool which goes through Terraform.

**Better:** `proxmox_write` already exists and talks to the Proxmox API directly. Use it for lifecycle. Terraform only runs for `create` and `destroy`.

This immediately gives you: start, stop, restart, snapshot, clone — all without touching Terraform.

### Step 2: Parameterize VM creation

Change `TerraformRunner` to accept a flexible `VmSpec` instead of a fixed schema:

```typescript
interface VmSpec {
  name: string;
  node: string;
  cores?: number;      // default: 2
  memory?: number;     // default: 2048 MB
  disk?: string;       // default: "20G"
  osTemplate?: string; // "ubuntu-22.04" | "debian-12" | custom cloud-init URL
  vlanTag?: number;    // VLAN for network assignment
  sshPublicKey?: string;
  tags?: string[];
}
```

The Terraform template dynamically generates from this spec. You can now say "create a 4-core 8GB VM named gpu-test on yin with VLAN 20" and it just works without touching any code.

### Step 3: Generalize Ansible into a composition layer

Replace the 5 hardcoded Ansible actions with a single composable executor:

```typescript
// Instead of: installDocker(), installNginx(), configureFirewall()
// Use:
executePlaybook({
  host: "myvm.prox",
  playbooks: ["common.yml", "packages.yml"],
  vars: {
    packages: ["docker-ce", "nginx", "certbot"],
    ufw_rules: [{ port: 443, proto: "tcp" }],
  }
});
```

Write one generic `packages.yml` playbook that accepts a `packages` list. The LLM composes what to install; Ansible executes it. You go from "I can install Docker or nginx" to "I can install anything apt knows about."

### Step 4: Wire the api-discovery system to the action layer

The `api-discovery` framework already discovers Proxmox and OPNsense endpoints. The missing piece: when the LLM wants to do something there's no action for, it should be able to query discovery and construct a raw API call.

```typescript
// Dynamic action escape hatch:
// If the agent detects intent but no registered action exists...
const discovered = await discoveryRegistry.findEndpoint(intent);
if (discovered) {
  return await executeRawApiCall(discovered.endpoint, discovered.params);
}
```

This is essentially what MCP does. You're 80% of the way there already. The api-discovery system probes what's available; you just need a bridge from "LLM wants to do X" to "is X a discoverable endpoint?"

### The long-term vision

```
User: "Give the testbox VM 2 more cores and move it to VLAN 20"

Agent:
  1. Resolves VM (twin_query → vmid=142, node=yin, current cores=2)
  2. Detects needed ops: resize cores, reassign VLAN
  3. No action for "resize cores" → queries api-discovery → finds /nodes/{node}/qemu/{vmid}/config PUT
  4. Constructs + confirms: "Resize VM 142: cores 2→4, VLAN →20. CONFIRM abc123 or CANCEL."
  5. On confirm: PUT /nodes/yin/qemu/142/config { cores: 4 } via proxmox_write
  6. Calls setInterfaceVlan action for VLAN reassignment
  7. Reports: "VMUpdate | vmid=142 | cores=4 | vlan=20 | status=complete"
```

This is your stated goal — "my environment is a playground I can manage with a couple prompts." That's achievable with the stack you have.

---

## Part 4 — Structural Refactor Plan

### Split runner.ts into four focused modules

```
src/agent/
  intent-resolver.ts      # Classification + domain detection (currently inline in runner)
  retrieval-layer.ts      # RAG fetch, domain match, injection decision
  execution-engine.ts     # LLM loop, tool call dispatch, confirmation guard
  response-assembler.ts   # Canonical response building, serialization
  runner.ts               # Thin orchestrator — calls the above in sequence
```

`runner.ts` becomes ~200 lines: setup, sequence the four stages, return result.

### Consolidate intent detection

Replace the 5-detector waterfall with a single structured LLM call on the first turn:

```typescript
const intent = await classifyStructured(userInput);
// Returns: { type: "COMPUTE_QUERY" | "FIREWALL_ACTION" | ..., entities: {...}, confidence: 0.92 }
```

Use `response_format: { type: "json_schema" }` with a Zod schema. You get one deterministic classification instead of 5 regex checks + a probabilistic classifier. The regex detectors become validation/fallback, not primary path.

### Define a canonical response contract

```typescript
// Every response from the agent is one of these, always
export type PallindromeResponse =
  | ActionResponse      // { type: "action", action, status, fields }
  | QueryResponse       // { type: "query", answer, evidence?, nextSteps? }
  | ClarificationResponse
  | ConfirmationRequest
  | ErrorResponse;
```

The dashboard consumes this typed contract. No more "is this pipe-delimited or markdown or a question?" logic in the frontend.

---

## Part 5 — Quick Wins (This Week)

In priority order:

1. **Server-side conversation history** — Wire `ChatHistoryStore` into `runAgent`. Probably 30 lines of change, immediately fixes multi-turn coherence.

2. **Kill the formatter LLM call** — Move mode instructions into the system prompt. Delete `formatResponseForBot`. Saves ~500ms per response and removes a major source of variance.

3. **Delete `cleanupRagAnswer()`** — Fix the RAG generation prompt to not produce citations in the first place (`"Do not include [Source N] references in your answer."`). The cleanup function goes away.

4. **Wire streaming** — Connect `AgentEventBus` to SSE. The event bus is already emitting. The dashboard already consumes SSE. This is a plumbing change, not a logic change.

5. **Parameterize VM creation** — Add `cores`, `memory`, `disk`, `osTemplate`, `vlanTag` to `CreateVmSchema` and thread them through `TerraformRunner`. Immediate payoff: you can create arbitrarily-specced VMs from one prompt.

---

## Summary Table

| Problem | Root Cause | Fix Complexity |
|---|---|---|
| Inconsistent formatting | 15 exit paths, double LLM call | Medium — 1 serializer + remove formatter |
| Choppy conversations | Client-side history reconstruction | Low — wire ChatHistoryStore |
| LLM output variance | Loose prompts, cleanup regexes | Low — tighten prompts, delete cleanup |
| Blank wait on slow queries | Streaming disabled | Low — event bus already emits |
| Can only create fixed VMs | Hardcoded Terraform schema | Medium — parameterize VmSpec |
| Can only run preset Ansible | One function per playbook | Medium — generic executor |
| Action layer ceiling | No dynamic tool discovery | High — wire api-discovery to actions |
| runner.ts unmaintainable | God file | High — 4-way split |
