/**
 * Handles identity (name update, name query, assistant name) and CHAT_SOCIAL fast-paths.
 * Also handles subnet sizing fast-path. Returns { handled: true, response } or { handled: false }.
 */

import type { AgentEventBus } from "../event-bus";
import type { AgentStateV1 } from "../state";
import { emitFinalEvent } from "./emit-helpers";
import {
  extractUserNameUpdate,
  isAssistantNameQuery,
  isLivenessCheck,
  isUserNameQuery,
} from "./identity-helpers";

export interface HandleIdentityInput {
  state: AgentStateV1;
  memoryUserName: string | undefined;
  eventBus: AgentEventBus;
  assistantName: string;
  /** Record a trace for this identity/social response; returns traceId if recorded. */
  recordIdentityTrace: (params: {
    finalResponse: string;
    reason: string;
  }) => Promise<string | undefined>;
}

export type HandleIdentityResult =
  | { handled: true; response: { text: string } }
  | { handled: false };

export async function handleIdentityAndSocial(input: HandleIdentityInput): Promise<HandleIdentityResult> {
  const {
    state,
    memoryUserName,
    eventBus,
    assistantName,
    recordIdentityTrace,
  } = input;
  const {
    originalUserInput,
    effectiveUserInput: userInput,
    confirmation,
    classification,
    contextUpdate,
    sessionId,
    startTime,
  } = state;

  const nameUpdate = extractUserNameUpdate(originalUserInput);
  if (!confirmation.confirmed && nameUpdate) {
    const text = `Got it. I'll call you ${nameUpdate}.`;
    const traceId = await recordIdentityTrace({ finalResponse: text, reason: "meta_identity" });
    emitFinalEvent(eventBus, sessionId, startTime, text, {
      conversationState: "FOLLOWUP",
      conversationContext: { ...contextUpdate, userName: nameUpdate },
      memorySource: "user_explicit",
      memoryConfidence: 0.95,
      traceId,
    });
    return { handled: true, response: { text } };
  }

  if (!confirmation.confirmed && isUserNameQuery(originalUserInput)) {
    const text = memoryUserName
      ? `Your name is ${memoryUserName}.`
      : "I don't have your name yet. Tell me with \"my name is <name>\".";
    const traceId = await recordIdentityTrace({ finalResponse: text, reason: "meta_identity" });
    emitFinalEvent(eventBus, sessionId, startTime, text, {
      conversationState: "FOLLOWUP",
      conversationContext: contextUpdate,
      traceId,
    });
    return { handled: true, response: { text } };
  }

  if (!confirmation.confirmed && isAssistantNameQuery(originalUserInput)) {
    const text = `My name is ${assistantName}.`;
    const traceId = await recordIdentityTrace({ finalResponse: text, reason: "meta_identity" });
    emitFinalEvent(eventBus, sessionId, startTime, text, {
      conversationState: "FOLLOWUP",
      conversationContext: contextUpdate,
      traceId,
    });
    return { handled: true, response: { text } };
  }

  if (!confirmation.confirmed && isLivenessCheck(originalUserInput)) {
    const text = "Agent is online.";
    const traceId = await recordIdentityTrace({ finalResponse: text, reason: "liveness_check" });
    emitFinalEvent(eventBus, sessionId, startTime, text, {
      classification,
      conversationState: "FOLLOWUP",
      conversationContext: contextUpdate,
      traceId,
    });
    return { handled: true, response: { text } };
  }

  if (classification.intent === "CHAT_SOCIAL" && !confirmation.confirmed) {
    const text = "Hi — what do you want to check or change in your lab?";
    const traceId = await recordIdentityTrace({ finalResponse: text, reason: "chat_social" });
    emitFinalEvent(eventBus, sessionId, startTime, text, {
      classification,
      conversationState: "FOLLOWUP",
      conversationContext: contextUpdate,
      traceId,
    });
    return { handled: true, response: { text } };
  }

  // Fast-path subnet sizing
  const subnetSizing = (() => {
    const q = (originalUserInput || "").toLowerCase();
    const match =
      q.match(/\bsubnet\b[\s\S]*?\b(\d+)\b[\s\S]*?\bhosts?\b/) ||
      q.match(/\b(\d+)\b[\s\S]*?\bhosts?\b[\s\S]*?\bsubnet\b/);
    if (!match) return null;
    const hostsRaw = match[1];
    if (!hostsRaw) return null;
    const hosts = parseInt(hostsRaw, 10);
    if (!Number.isFinite(hosts) || hosts <= 0) return null;
    const needed = hosts + 2;
    let size = 1;
    while (size < needed) size *= 2;
    const prefix = 32 - Math.log2(size);
    const usable = Math.max(0, size - 2);
    const note =
      hosts === 128
        ? "Note: /25 has 128 total addresses but only 126 usable host IPs; /24 is the smallest that supports 128 usable hosts."
        : undefined;
    return { hosts, prefix, usable, total: size, note };
  })();
  if (subnetSizing) {
    const text =
      `SubnetSizing | required_hosts=${subnetSizing.hosts} | smallest_ipv4_prefix=/${subnetSizing.prefix} | usable_hosts=${subnetSizing.usable} | total_addresses=${subnetSizing.total}` +
      (subnetSizing.note ? ` | note="${subnetSizing.note}"` : "");
    emitFinalEvent(eventBus, sessionId, startTime, text, {
      classification,
      conversationState: "FOLLOWUP",
      conversationContext: contextUpdate,
    });
    return { handled: true, response: { text } };
  }

  return { handled: false };
}
