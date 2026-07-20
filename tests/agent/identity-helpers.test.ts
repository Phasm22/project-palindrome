import { describe, expect, test } from "bun:test";
import { isLivenessCheck } from "../../src/agent/handlers/identity-helpers";

describe("isLivenessCheck", () => {
  test.each(["test", "TEST!", "ping", "health check", "are you online?"])(
    "recognizes %s as a liveness probe",
    (input) => {
      expect(isLivenessCheck(input)).toBe(true);
    }
  );

  test.each(["", "test the firewall", "ping 10.0.0.1", "are you online today"])(
    "does not consume %s as a liveness probe",
    (input) => {
      expect(isLivenessCheck(input)).toBe(false);
    }
  );
});
