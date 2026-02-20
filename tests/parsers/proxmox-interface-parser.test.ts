import { ProxmoxInterfaceParser } from "../../src/parsers";
import type { ParserContext } from "../../src/parsers";

const context: ParserContext = {
  source: "test",
  collectedAt: new Date("2025-01-01T00:00:00Z"),
};

test("ProxmoxInterfaceParser attaches VM interfaces to compute_vms", async () => {
  const parser = new ProxmoxInterfaceParser();
  const result = await parser.parse(
    {
      nodes: [],
      vms: [
        {
          vmid: 211,
          node: "YANG",
          name: "opsbox",
          net: {
            net0: "virtio=BC:24:11:B9:76:E6,bridge=vmbr0",
          },
          guestInterfaces: [
            {
              name: "eth0",
              "hardware-address": "BC:24:11:B9:76:E6",
              "ip-addresses": [
                { "ip-address": "172.16.0.184", "ip-address-type": "ipv4", prefix: 22 },
              ],
            },
          ],
        },
      ],
    },
    context
  );

  const attached = result.relationships.find(
    (rel) =>
      rel.type === "ATTACHED_TO" &&
      rel.fromId === "network-if:yang:opsbox-net0" &&
      rel.toId === "compute-vm:yang:211"
  );

  expect(attached).toBeDefined();
});

test("ProxmoxInterfaceParser attaches host interfaces to compute_nodes", async () => {
  const parser = new ProxmoxInterfaceParser();
  const result = await parser.parse(
    {
      nodes: [
        {
          node: "proxBig",
          interfaces: [
            {
              iface: "vmbr0",
              address: "172.16.0.10",
              netmask: "255.255.252.0",
              active: 1,
            },
          ],
        },
      ],
      vms: [],
    },
    context
  );

  const attached = result.relationships.find(
    (rel) =>
      rel.type === "ATTACHED_TO" &&
      rel.fromId === "network-if:proxbig:vmbr0" &&
      rel.toId === "compute-node:proxbig"
  );

  expect(attached).toBeDefined();
});
