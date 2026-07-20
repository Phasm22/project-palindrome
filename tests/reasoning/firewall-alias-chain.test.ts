import { expect, test } from "bun:test";
import { aliasContentsChain } from "../../src/reasoning/chains/firewall";

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
