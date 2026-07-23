import { describe, it, expect } from "vitest";
import { getExpectedEndpointLabel, wasEndpointVerified } from "../../../src/tools/proxmox/endpoint-attribution";

describe("endpoint-attribution", () => {
  describe("getExpectedEndpointLabel", () => {
    it("maps proxBig (any case) to the proxbig endpoint", () => {
      expect(getExpectedEndpointLabel("proxBig")).toBe("proxbig");
      expect(getExpectedEndpointLabel("PROXBIG")).toBe("proxbig");
      expect(getExpectedEndpointLabel("proxbig")).toBe("proxbig");
    });

    it("maps any other node name to the shared cluster endpoint", () => {
      expect(getExpectedEndpointLabel("yin")).toBe("cluster");
      expect(getExpectedEndpointLabel("yang")).toBe("cluster");
    });

    it("returns undefined when the node name is unknown", () => {
      expect(getExpectedEndpointLabel(undefined)).toBeUndefined();
      expect(getExpectedEndpointLabel("")).toBeUndefined();
    });
  });

  describe("wasEndpointVerified", () => {
    it("is true when the expected endpoint was successfully queried", () => {
      const successful = new Set(["cluster"]);
      expect(wasEndpointVerified("cluster", successful, 2)).toBe(true);
    });

    it("is false when the expected endpoint failed this run, even if others succeeded", () => {
      const successful = new Set(["cluster"]);
      expect(wasEndpointVerified("proxbig", successful, 2)).toBe(false);
    });

    it("falls back to requiring every endpoint when the expected one is unknown", () => {
      const allSucceeded = new Set(["cluster", "proxbig"]);
      expect(wasEndpointVerified(undefined, allSucceeded, 2)).toBe(true);

      const partial = new Set(["cluster"]);
      expect(wasEndpointVerified(undefined, partial, 2)).toBe(false);
    });
  });
});
