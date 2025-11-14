import { runAgent } from "../src/agent/runner";

test("runAgent returns text", async () => {
  if (!process.env.OPENAI_API_KEY) {
    console.log("Skipping test: OPENAI_API_KEY not set");
    return;
  }
  const res = await runAgent("test");
  expect(res.text).toBeDefined();
}, { timeout: 30000 });

