import { describe, expect, test } from "bun:test";
import {
  parseCompoundApplicationRequest,
  summarizeCompoundApplicationRequest,
} from "../../src/agent/application-request";

const request =
  "Create a VM called Samsung Open Ports 22 and eighty and four three and put an Nginx server up with the picture of Of A Grand piano. Also put the VM under the ops domain.";

describe("compound application requests", () => {
  test("preserves application concerns without treating the ops domain as a node", () => {
    expect(parseCompoundApplicationRequest(request)).toEqual({
      vmName: "Samsung",
      node: undefined,
      requestedPorts: [22, 80, 43],
      services: ["Nginx"],
      assetDescription: "A Grand piano",
      domain: "samsung.ops.prox",
    });
  });

  test("builds a complete confirmation summary after node clarification", () => {
    const parsed = parseCompoundApplicationRequest(`${request} on proxBig`);
    expect(parsed?.node).toBe("proxBig");
    expect(summarizeCompoundApplicationRequest(parsed!)).toBe(
      "deploy application Samsung\n" +
      "- VM: Samsung on proxBig\n" +
      "- Services: Nginx\n" +
      "- Firewall ports: 22, 80, 43\n" +
      "- Generated image: A Grand piano\n" +
      "- Domain: samsung.ops.prox"
    );
  });

  test("does not capture ordinary VM creation", () => {
    expect(parseCompoundApplicationRequest("create a VM called apple on yin")).toBeNull();
  });
});
