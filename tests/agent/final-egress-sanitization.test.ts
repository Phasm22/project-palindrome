import { describe, expect, test } from "bun:test";
import { AgentEventBus, type AgentEvent } from "../../src/agent/event-bus";
import { emitFinalEvent } from "../../src/agent/handlers/emit-helpers";
import { createTextAgentResponse } from "../../src/agent/schemas/agent-response";

describe("final answer egress sanitization", () => {
  test("redacts secrets from text and structured response before emitting", () => {
    const eventBus = new AgentEventBus();
    const emitted: AgentEvent[] = [];
    eventBus.onEvent((event) => emitted.push(event));

    const secret = "SuperSecret123";
    const finalText = `Completed. password=${secret}`;
    const structuredResponse = createTextAgentResponse(finalText);
    structuredResponse.answer.sections.push({
      type: "details",
      data: `Generated detail password=${secret}`,
    });

    emitFinalEvent(eventBus, "session-redaction-test", Date.now(), finalText, {
      structuredResponse,
    });

    expect(emitted).toHaveLength(1);
    const serializedPayload = JSON.stringify(emitted[0]?.data);
    expect(serializedPayload).not.toContain(secret);
    expect(serializedPayload).toContain("[REDACTED_PASSWORD]");
  });
});
