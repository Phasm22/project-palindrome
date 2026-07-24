import { describe, expect, test } from "bun:test";
import { InfrastructureDiagnosticTool } from "../../src/tools/InfrastructureDiagnosticTool";

describe("InfrastructureDiagnosticTool", () => {
  test("advertises only implemented diagnostic types", () => {
    const diagnosticType = new InfrastructureDiagnosticTool()
      .getSchema()
      .parameters.properties.diagnostic_type;

    expect(diagnosticType.enum).toEqual(["guest_agent"]);
  });
});
