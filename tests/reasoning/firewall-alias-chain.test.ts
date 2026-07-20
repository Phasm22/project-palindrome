import { expect, test } from "bun:test";
import {
  aliasContentsChain,
  sourcesAccessingNetworkChain,
} from "../../src/reasoning/chains/firewall";

test("aliasContentsChain formats alias content for adaptive packaging", async () => {
  const opnsenseTool = {
    metadata: { name: "opnsense_readonly" },
    execute: async (params: Record<string, any>) => {
      expect(params).toEqual({ action: "firewall_aliases_get", alias_name: "tjs computers" });
      return {
        data: {
          action: "firewall_aliases_get",
          alias_name: "tjs computers",
          resolved_alias_name: "TJs_Computers",
          data: {
            enabled: "0",
            name: "TJs_Computers",
            type: "network",
            "%type": "Network",
            interface: "",
            content: "10.107.193.0/24",
          },
        },
      };
    },
  };

  const response = await aliasContentsChain("tjs computers", [opnsenseTool as any], {});

  expect(response).toContain('Alias "TJs_Computers" Contents');
  expect(response).toContain("Alias Name: TJs_Computers");
  expect(response).toContain("10.107.193.0/24");
  expect(response).toContain("Type: Network");
  expect(response).toContain("Enabled: No");
  expect(response).toContain("Interface: None");
});

test("sourcesAccessingNetworkChain resolves inbound source aliases and ignores outbound rules", async () => {
  const twinTool = {
    metadata: { name: "twin_query" },
    execute: async (params: Record<string, any>) => {
      expect(params).toEqual({
        operation: "firewall_rules_by_chain",
        params: { chain: "chain:wireguard" },
      });
      return {
        data: {
          data: [
            { id: "1", action: "pass", direction: "in", source: "<WG_VIP>", destination: "(vtnet0:network)" },
            { id: "2", action: "pass", direction: "in", source: "<WG_VIP>", destination: "(vtnet1:network)" },
            { id: "3", action: "pass", direction: "out", source: "<WG_VIP>", destination: "any" },
            { id: "4", action: "pass", direction: "out", source: "<WG_Friends>", destination: "any" },
          ],
          aliases: [
            { name: "WG_Friends", entries: [], cidrs: ["10.16.0.8/29"] },
            { name: "WG_VIP", entries: [], cidrs: ["10.16.0.0/29"] },
          ],
        },
      };
    },
  };

  const response = await sourcesAccessingNetworkChain(
    "chain:wireguard",
    "lab network",
    [twinTool as any],
    {}
  );

  expect(response).toContain("IPs in `10.16.0.0/29` (`WG_VIP`) can access lab network");
  expect(response).toContain("`(vtnet0:network)`");
  expect(response).toContain("`(vtnet1:network)`");
  expect(response).not.toContain("WG_Friends");
  expect(response).not.toContain("10.16.0.8/29");
});
