import { readFile } from "fs/promises";
import { join } from "path";
import { CiscoIosSwitchParser } from "../../src/parsers/network/cisco-ios-switch-parser";
import type { ParserContext } from "../../src/parsers";
import { normalizeSubnetId } from "../../src/parsers/network/network-utils";

const context: ParserContext = {
  source: "test",
  collectedAt: new Date("2025-01-01T00:00:00Z"),
};

const SAMPLE_CONFIG = `
!
hostname TJswitch
!
interface GigabitEthernet0/1
 switchport mode access
!
interface GigabitEthernet0/17
 switchport access vlan 50
 switchport mode access
!
interface GigabitEthernet0/41
 description uplink to home network
 switchport access vlan 40
 switchport trunk allowed vlan 1,40,50
 switchport mode access
!
interface Vlan1
 ip address 172.16.0.9 255.255.252.0
 ip helper-address 172.16.0.13
!
interface Vlan10
 no ip address
 shutdown
!
interface Vlan40
 description Home to Lab
 ip address 192.168.71.6 255.255.252.0
!
ip default-gateway 192.168.68.1
ip route 0.0.0.0 0.0.0.0 192.168.68.1
end
`;

test("CiscoIosSwitchParser extracts hostname and builds a SWITCH entity", async () => {
  const parser = new CiscoIosSwitchParser();
  const result = await parser.parse({ configText: SAMPLE_CONFIG }, context);

  const switchEntity = result.entities.find((e) => e.type === "switch");
  expect(switchEntity).toBeDefined();
  expect(switchEntity!.id).toBe("switch:tjswitch:observed");
  expect((switchEntity as any).data.hostname).toBe("TJswitch");
  expect((switchEntity as any).data.provenance).toBe("observed");
  expect((switchEntity as any).data.managementIps.sort()).toEqual(["172.16.0.9", "192.168.71.6"]);
});

test("CiscoIosSwitchParser normalizes port names and captures access VLANs", async () => {
  const parser = new CiscoIosSwitchParser();
  const result = await parser.parse({ configText: SAMPLE_CONFIG }, context);

  const ports = result.entities.filter((e) => e.type === "switch_port");
  expect(ports).toHaveLength(3);

  const gi1 = ports.find((p) => (p as any).data.portName === "Gi0/1")!;
  expect(gi1.data).toMatchObject({ mode: "access", accessVlan: null, trunkVlans: [] });

  const gi17 = ports.find((p) => (p as any).data.portName === "Gi0/17")!;
  expect(gi17.data).toMatchObject({ mode: "access", accessVlan: 50 });
});

test("CiscoIosSwitchParser preserves the real (contradictory) Gi0/41 config as observed", async () => {
  // This port is configured with BOTH an access-vlan 40 assignment AND a
  // "trunk allowed vlan" line, while switchport mode stays "access" — real,
  // slightly self-contradictory config. The parser should record exactly
  // what's there, not "fix" it.
  const parser = new CiscoIosSwitchParser();
  const result = await parser.parse({ configText: SAMPLE_CONFIG }, context);

  const ports = result.entities.filter((e) => e.type === "switch_port");
  const gi41 = ports.find((p) => (p as any).data.portName === "Gi0/41")!;
  expect(gi41.id).toBe("switch-port:tjswitch:gi0-41:observed");
  expect(gi41.data).toMatchObject({
    mode: "access",
    accessVlan: 40,
    trunkVlans: [1, 40, 50],
    description: "uplink to home network",
  });
});

test("CiscoIosSwitchParser emits HAS_PORT for every port and ROUTES_FOR only for routable SVIs", async () => {
  const parser = new CiscoIosSwitchParser();
  const result = await parser.parse({ configText: SAMPLE_CONFIG }, context);

  const hasPortRels = result.relationships.filter((r) => r.type === "HAS_PORT");
  expect(hasPortRels).toHaveLength(3);
  expect(hasPortRels.every((r) => r.fromId === "switch:tjswitch:observed")).toBe(true);

  const routesForRels = result.relationships.filter((r) => r.type === "ROUTES_FOR");
  // Vlan1 and Vlan40 have real IPs; Vlan10 is shutdown with no IP and must be excluded.
  expect(routesForRels).toHaveLength(2);
  const targets = routesForRels.map((r) => r.toId).sort();
  expect(targets).toEqual([normalizeSubnetId("172.16.0.9/22"), normalizeSubnetId("192.168.71.6/22")].sort());
});

test("CiscoIosSwitchParser throws when the config has no hostname", async () => {
  const parser = new CiscoIosSwitchParser();
  await expect(parser.parse({ configText: "interface GigabitEthernet0/1\n switchport mode access\n!" }, context))
    .rejects.toThrow(/hostname/i);
});

test("CiscoIosSwitchParser parses the real sanitized 2960G seed file end to end", async () => {
  const configText = await readFile(
    join(process.cwd(), "docs", "network", "2960g-running-config-2026-07-20.txt"),
    "utf8"
  );
  const parser = new CiscoIosSwitchParser();
  const result = await parser.parse({ configText }, { source: "cisco-ios:2960g-seed", collectedAt: new Date() });

  expect(result.entities.find((e) => e.type === "switch")).toBeDefined();
  const ports = result.entities.filter((e) => e.type === "switch_port");
  expect(ports).toHaveLength(48);

  const gi41 = ports.find((p) => (p as any).data.portName === "Gi0/41")!;
  expect(gi41.data).toMatchObject({ accessVlan: 40, trunkVlans: [1, 40, 50] });

  // The declared-vs-observed conflict this whole feature exists to preserve:
  // topology.yaml declares the lab subnet as VLAN 50, but the switch's own
  // VLAN 1 SVI (untagged default) is what actually carries 172.16.0.0/22.
  const routesForRels = result.relationships.filter((r) => r.type === "ROUTES_FOR");
  expect(routesForRels.some((r) => r.toId === normalizeSubnetId("172.16.0.9/22"))).toBe(true);
});
