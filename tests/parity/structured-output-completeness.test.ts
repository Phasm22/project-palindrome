import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { parseRepoFile, propertyNameText, readRepoFile, walk } from "./source-ast";

type CoverageDecision =
  | { status: "emits"; reason: string; count: number }
  | { status: "opt_out"; reason: string; count: number };

/*
 * A call-site signature is the emitted text expression plus the metadata
 * fields on the event. Property names are sorted, so formatting and property
 * order do not cause churn. Counts distinguish sibling branches that
 * intentionally share a shape. Any added/removed/reshaped final-answer path
 * must therefore receive an explicit review here.
 *
 * All current sites use the centralized AgentResponseV1 text-envelope
 * fallback in emitFinalEvent. Keep opt_out available for a deliberately
 * unstructured transport, but require a documented reason if one is added.
 */
const FINAL_EVENT_COVERAGE: Record<string, Record<string, CoverageDecision>> = {
  "src/agent/runner.ts": {
    "cleanedAnswer|classification,conversationContext,conversationState,ragAnswer,ragScore,traceId": {
      status: "emits",
      count: 1,
      reason: "RAG answer uses the centralized structured-response fallback.",
    },
    "clarificationMessage|clarification,classification,conversationContext,conversationState,needsResponse,traceId": {
      status: "emits",
      count: 1,
      reason: "Routing clarification uses the centralized structured-response fallback.",
    },
    "answer|conversationContext,conversationState,totalSteps,totalToolCalls,traceId": {
      status: "emits",
      count: 1,
      reason: "Application lifecycle answer uses the centralized structured-response fallback.",
    },
    "text|classification,connections,conversationContext,conversationState,structuredResponse,totalSteps,totalToolCalls": {
      status: "emits",
      count: 1,
      reason: "Service installation supplies a richer structured response explicitly.",
    },
    "prompt|clarification,conversationContext,conversationState,needsResponse": {
      status: "emits",
      count: 5,
      reason: "Action clarification siblings use the centralized structured-response fallback.",
    },
    "text|classification,connections,conversationContext,conversationState,structuredResponse,traceId": {
      status: "emits",
      count: 1,
      reason: "VM creation supplies a richer structured response explicitly.",
    },
    "text|classification,conversationContext,conversationState,traceId": {
      status: "emits",
      count: 1,
      reason: "Deterministic action answer uses the centralized structured-response fallback.",
    },
    "formattedAnswer|conversationContext,conversationState,intent,traceId": {
      status: "emits",
      count: 4,
      reason: "Twin-first domain siblings use the centralized structured-response fallback.",
    },
  },
  "src/agent/handlers/handle-execute.ts": {
    "finalText|conversationContext,conversationState,totalSteps,totalToolCalls,traceId": {
      status: "emits",
      count: 2,
      reason: "Deterministic EXECUTE answers use the centralized structured-response fallback.",
    },
    "clarificationAbort.prompt|clarification,classification,conversationContext,conversationState,needsResponse": {
      status: "emits",
      count: 1,
      reason: "EXECUTE clarification abort uses the centralized structured-response fallback.",
    },
    "confirmationAbort.prompt|classification,confirmationExpiresAt,confirmationId,confirmationPreview,confirmationRequired,conversationContext,conversationState": {
      status: "emits",
      count: 1,
      reason: "EXECUTE confirmation abort uses the centralized structured-response fallback.",
    },
    "finalText|clarification,connections,conversationContext,conversationState,needsResponse,structuredResponse,totalSteps,totalToolCalls,traceId": {
      status: "emits",
      count: 1,
      reason: "The main EXECUTE completion supplies a richer structured response explicitly.",
    },
    "boundaryText|conversationContext,conversationState,totalSteps,totalToolCalls,traceId": {
      status: "emits",
      count: 1,
      reason: "EXECUTE step-boundary answer uses the centralized structured-response fallback.",
    },
  },
};

function finalEventSignatures(relativePath: string): Record<string, number> {
  const sourceFile = parseRepoFile(relativePath);
  const counts: Record<string, number> = {};

  walk(sourceFile, (node) => {
    if (
      !ts.isCallExpression(node) ||
      node.expression.getText(sourceFile) !== "emitFinalEvent"
    ) {
      return;
    }

    const textArgument = node.arguments[3]?.getText(sourceFile) ?? "<missing-text>";
    const extra = node.arguments[4];
    const metadataKeys =
      extra && ts.isObjectLiteralExpression(extra)
        ? extra.properties
            .flatMap((property) => {
              if (
                ts.isPropertyAssignment(property) ||
                ts.isShorthandPropertyAssignment(property)
              ) {
                return [propertyNameText(property.name, sourceFile)];
              }
              return [`<non-property:${property.getText(sourceFile)}>`];
            })
            .sort()
        : ["<missing-metadata-object>"];
    const signature = `${textArgument}|${metadataKeys.join(",")}`;
    counts[signature] = (counts[signature] ?? 0) + 1;
  });

  return counts;
}

describe("structured-output path completeness", () => {
  test("every runner and EXECUTE final-event site has a reviewed coverage decision", () => {
    for (const [relativePath, decisions] of Object.entries(FINAL_EVENT_COVERAGE)) {
      const discovered = finalEventSignatures(relativePath);
      const expectedCounts = Object.fromEntries(
        Object.entries(decisions).map(([signature, decision]) => [
          signature,
          decision.count,
        ])
      );

      expect(discovered).toEqual(expectedCounts);
      for (const decision of Object.values(decisions)) {
        expect(["emits", "opt_out"]).toContain(decision.status);
        expect(decision.reason.length).toBeGreaterThan(20);
      }
    }
  });

  test("the shared final-event helper always supplies an AgentResponseV1 envelope", () => {
    const helper = readRepoFile("src/agent/handlers/emit-helpers.ts");

    expect(helper).toContain('from "../schemas/agent-response"');
    expect(helper).toMatch(
      /structuredResponse\s*=\s*sanitizeToolPayload\([^;]+?\)\s*\?\?\s*createTextAgentResponse\(/s
    );
    expect(helper).toMatch(
      /const\s+payload\s*:\s*AgentFinalPayload\s*=\s*\{[\s\S]*?\bstructuredResponse\s*,/
    );
  });

  test("direct runAgent consumers receive the same envelope, including EXECUTE", () => {
    const runner = readRepoFile("src/agent/runner.ts");

    expect(runner).toMatch(
      /structuredResponse:\s*structuredResponse\s*\?\?\s*createTextAgentResponse\(response\.text\s*\?\?\s*""\)/
    );
    expect(runner).toContain("return withStructuredResponse(executeResult);");
  });
});
