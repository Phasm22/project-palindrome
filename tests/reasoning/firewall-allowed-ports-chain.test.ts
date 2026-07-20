import { describe, expect, test } from "bun:test";
import {
  allowedPortsBetweenChain,
  formatAllowedPortsBetweenPayload,
} from "../../src/reasoning/chains/firewall";

const rulesPayload = {
  rules: [
    "block drop in log on ! vtnet1 inet from 192.168.68.0/22 to any",
    "block drop in log on ! vtnet0 inet from 172.16.0.0/22 to any",
    'pass in log quick on vtnet1 reply-to (vtnet1 192.168.68.1) inet proto tcp from <TJs_Computers> to (vtnet0:network) port = ssh flags S/SA keep state label "services"',
    'pass in log quick on vtnet1 reply-to (vtnet1 192.168.68.1) inet proto udp from <TJs_Computers> to (vtnet0:network) port = domain keep state label "services"',
    'pass in log quick on vtnet1 reply-to (vtnet1 192.168.68.1) inet proto tcp from (vtnet1:network) to any port = domain keep state label "dns-ntp"',
    'pass in log quick on vtnet1 reply-to (vtnet1 192.168.68.1) inet proto udp from (vtnet1:network) to any port = domain keep state label "dns-ntp"',
    'pass in log quick on vtnet1 reply-to (vtnet1 192.168.68.1) inet proto tcp from (vtnet1:network) to any port = ntp keep state label "dns-ntp"',
    'pass in log quick on vtnet1 reply-to (vtnet1 192.168.68.1) inet proto udp from (vtnet1:network) to any port = ntp keep state label "dns-ntp"',
    'pass in log quick on vtnet1 reply-to (vtnet1 192.168.68.1) inet proto icmp from (vtnet1:network) to any keep state label "ping"',
    'pass in log quick on vtnet1 reply-to (vtnet1 192.168.68.1) inet from <TJs_Computers> to any keep state label "root"',
    'pass in log quick on vtnet1 inet proto tcp from <allowed_guest> to (self) port = http keep state label "unrelated"',
    'block in log quick on vtnet1 inet from (vtnet1:network) to (vtnet0:network) label "block-home-lab"',
  ],
};

const aliasesPayload = {
  aliases: [
    {
      name: "TJs_Computers",
      type: "host",
      content: "TJ_surface\nTJ_thinpad\nsentinel_hunter",
    },
    { name: "TJ_surface", type: "host", content: "192.168.68.150" },
    { name: "TJ_thinpad", type: "host", content: "192.168.68.111" },
    { name: "sentinel_hunter", type: "host", content: "172.16.0.180" },
    {
      name: "allowed_guest",
      type: "host",
      content: "172.16.0.11\n192.168.71.25",
    },
    {
      name: "LAB_SERVICES_PORTS",
      type: "port",
      content: "22\n53\n80\n443\n3000\n3389\n5000\n8006\n17875\n51820",
    },
    { name: "DNS_NTP", type: "port", content: "53\n123" },
  ],
};

describe("allowed home-to-lab policy", () => {
  test("groups effective ports by source and excludes unrelated aliases", () => {
    const response = formatAllowedPortsBetweenPayload(
      "home",
      "lab",
      rulesPayload,
      aliasesPayload
    );

    expect(response).toContain("Access Policy: HomeNet -> LabNet");
    expect(response).toContain("`TJs_Computers`: all ports (all IPv4 protocols)");
    expect(response).toContain("`TJ_surface (192.168.68.150)`");
    expect(response).toContain("`TJ_thinpad (192.168.68.111)`");
    expect(response).not.toContain("sentinel_hunter");
    expect(response).toContain("`HomeNet (192.168.68.0/22)`: 53 (DNS, TCP/UDP), 123 (NTP, TCP/UDP)");
    expect(response).toContain("ICMP is also allowed");
    expect(response).toContain("Other HomeNet-to-LabNet traffic is blocked");
    expect(response).not.toContain("allowed_guest");
  });

  test("fetches rules and aliases without model interpretation", async () => {
    const actions: string[] = [];
    const opnsenseTool = {
      metadata: { name: "opnsense_readonly" },
      execute: async (params: Record<string, any>) => {
        actions.push(params.action);
        return {
          data: params.action === "firewall_rules_list"
            ? rulesPayload
            : aliasesPayload,
        };
      },
    };

    const response = await allowedPortsBetweenChain(
      "home",
      "lab",
      [opnsenseTool as any],
      {}
    );

    expect(actions.sort()).toEqual(["firewall_aliases_list", "firewall_rules_list"]);
    expect(response).toContain("`TJs_Computers`: all ports");
  });
});
