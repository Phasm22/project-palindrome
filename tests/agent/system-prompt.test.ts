import { describe, expect, test } from "bun:test";
import {
  buildSystemPrompt,
  MODE_INSTRUCTIONS,
} from "../../src/agent/system-prompt";

describe("response-mode system prompts", () => {
  test("appends the shared instruction for every response mode", () => {
    for (const mode of Object.keys(MODE_INSTRUCTIONS) as Array<keyof typeof MODE_INSTRUCTIONS>) {
      expect(buildSystemPrompt(mode)).toEndWith(MODE_INSTRUCTIONS[mode]);
    }
  });

  test("keeps aggregate values separate from per-item TERSE_DATA rows", () => {
    expect(MODE_INSTRUCTIONS.TERSE_DATA).toContain(
      "report the aggregate as its own separate entity row"
    );
  });
});
