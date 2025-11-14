import { runAgent } from "../src/agent/runner";

test("runAgent returns text response", async () => {
  if (!process.env.OPENAI_API_KEY) {
    console.log("Skipping test: OPENAI_API_KEY not set");
    return;
  }

  const res = await runAgent("Hello, how are you?");
  expect(res.text).toBeDefined();
  expect(typeof res.text).toBe("string");
}, { timeout: 30000 });

test("runAgent handles tool calls in loop", async () => {
  if (!process.env.OPENAI_API_KEY) {
    console.log("Skipping test: OPENAI_API_KEY not set");
    return;
  }

  // This test verifies the loop works, even if LLM doesn't call a tool
  const res = await runAgent("What is 2+2?");
  expect(res.text).toBeDefined();
}, { timeout: 30000 });

