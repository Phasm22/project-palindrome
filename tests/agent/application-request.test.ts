import { describe, expect, test } from "bun:test";
import {
  buildApplicationManifest,
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

  test("builds a valid strict manifest without model-authored defaults", () => {
    const parsed = parseCompoundApplicationRequest(`${request} on yin`)!;
    const manifest = buildApplicationManifest(parsed, {
      input: `${request} on yin`,
      sshUsername: "ops",
      opsboxIp: "172.16.0.184",
    });

    expect(manifest.applications[0]?.vms[0]).toMatchObject({
      name: "samsung",
      node: "yin",
      templateId: null,
      cloudInitDatastore: "local",
      services: ["nginx"],
      firewall: {
        defaultIncoming: "deny",
        rules: [
          { port: 22, protocol: "tcp", action: "allow", source: "any" },
          { port: 80, protocol: "tcp", action: "allow", source: "any" },
          { port: 43, protocol: "tcp", action: "allow", source: "any" },
        ],
      },
    });
    expect(manifest.applications[0]?.identity.provider).toBe("ops-authentik");
    expect(manifest.applications[0]?.vms[0]?.assets[0]).toMatchObject({
      source: "generate",
      prompt: "A Grand piano",
      destination: "/var/www/html/hero.jpg",
    });
  });

  test("normalizes comma-separated numeric ports", () => {
    const parsed = parseCompoundApplicationRequest(
      "Create a VM called Samsung. Open ports 22, 443, and 80, install Nginx, add an image of a grand piano, and use the ops domain on yin."
    );

    expect(parsed?.requestedPorts).toEqual([22, 443, 80]);
  });
});
