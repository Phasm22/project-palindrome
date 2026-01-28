import { deriveToolCallRisk, mapToolRiskToIntentRisk, maxRisk } from "../../src/agent/tool-risk";

test("Tool risk overrides low intent risk", () => {
  const intentRisk = "READ";
  const toolRisk = mapToolRiskToIntentRisk("high");
  const effective = maxRisk(intentRisk, toolRisk);
  expect(effective).toBe("WRITE_HIGH");
});

test("Action destroy is destructive", () => {
  const derived = deriveToolCallRisk("action", { action: "compute.destroy_vm" });
  expect(derived).toBe("DESTRUCTIVE");
});
