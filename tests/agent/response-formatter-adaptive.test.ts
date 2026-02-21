import { expect, test } from "bun:test";
import { applyAdaptivePackaging } from "../../src/agent/response-formatter";

test("compresses long allowed-port responses into summary packaging", () => {
  const response = `Allowed Ports
- 22 | proto=SSH
- 80 | proto=HTTP
- 443 | proto=HTTPS
- 53 | proto=DNS
- 3389 | proto=RDP
- 3000 | proto=Custom HTTP
- 5000 | proto=Custom HTTP
- 8006 | proto=Proxmox Web
- 17875 | proto=Ntopg
- 51820 | proto=WireGuard

Alias Definitions
Definition | term=LAB_SERVICES_PORTS | meaning="22, 53, 80, 443, 3000, 3389, 5000, 8006, 17875, 51820" | context="Allowed ports for lab services"`;

  const packaged = applyAdaptivePackaging(response, {
    userQuery: "what ports are allowed in from the home network to the lab network?",
    intentType: "firewall_rules",
  });

  expect(packaged).toBeTruthy();
  expect(packaged).toContain("Access Summary");
  expect(packaged).toContain("10 inbound service ports");
  expect(packaged).toContain("from home network to lab network");
  expect(packaged).toContain("Management exposure");
  expect(packaged).toContain("Policy aliases");
  expect(packaged).not.toContain("Definition | term=");
  expect(packaged).not.toContain("| proto=");
});

test("does not compress when user explicitly asks for full list", () => {
  const response = `Allowed Ports
- 22 | proto=SSH
- 80 | proto=HTTP
- 443 | proto=HTTPS
- 53 | proto=DNS
- 3389 | proto=RDP
- 3000 | proto=Custom HTTP`;

  const packaged = applyAdaptivePackaging(response, {
    userQuery: "show full allowed port list from home network to lab network",
    intentType: "firewall_rules",
  });

  expect(packaged).toBeNull();
});

test("compresses firewall rule lines with ports into access summary", () => {
  const response = `Firewall Rules
ALLOW | dir=in | src=192.168.68.0/22 | dst=lab_network | proto=TCP | port=22
ALLOW | dir=in | src=192.168.68.0/22 | dst=lab_network | proto=TCP | port=80
ALLOW | dir=in | src=192.168.68.0/22 | dst=lab_network | proto=TCP | port=443
ALLOW | dir=in | src=192.168.68.0/22 | dst=lab_network | proto=UDP | port=67
ALLOW | dir=in | src=192.168.68.0/22 | dst=lab_network | proto=UDP | port=68`;

  const packaged = applyAdaptivePackaging(response, {
    userQuery: "what ports are allowed in from the home network to the lab network?",
    intentType: "network_info",
  });

  expect(packaged).toBeTruthy();
  expect(packaged).toContain("Access Summary");
  expect(packaged).toContain("5 inbound service ports");
  expect(packaged).toContain("Observed source scope");
  expect(packaged).toContain("Observed destination scope");
  expect(packaged).toContain("from home network to lab network");
});

test("compresses non-port firewall policy response for allowed-port question", () => {
  const response = `Firewall Rules
BLOCK | dir=in | src=home_network | dst=lab_network | proto=any | if=any
ALLOW | dir=out | src=any | dst=any | proto=any | if=any

Anomaly
Lack of explicit rules for home to lab network traffic.`;

  const packaged = applyAdaptivePackaging(response, {
    userQuery: "what ports are allowed in from the home network to the lab network?",
    intentType: "network_info",
  });

  expect(packaged).toBeTruthy();
  expect(packaged).toContain("Access Summary");
  expect(packaged).toContain("No explicit inbound port allow rules");
  expect(packaged).toContain("Inbound rule mix");
  expect(packaged).toContain("Anomaly:");
  expect(packaged).toContain("from home network to lab network");
});

test("preserves canonical VM inventory formatting for list queries", () => {
  const response = `VMs on node yin:
- sentinelZero (VM, running)
  - Details: node=yin | trace=compute-vm:yin:200
  - Source: Digital twin (Proxmox ingest); agent status unknown
- ubuntu-cloud-template (VM, stopped)
  - Details: node=yin | trace=compute-vm:yin:8001
  - Source: Digital twin (Proxmox ingest); agent status unknown`;

  const packaged = applyAdaptivePackaging(response, {
    userQuery: "List all VMs currently on yin.",
    intentType: "compute_status",
  });

  expect(packaged).toBeTruthy();
  expect(packaged).toContain("VMs on node yin:");
  expect(packaged).toContain("- sentinelZero (VM, running)");
  expect(packaged).toContain("- ubuntu-cloud-template (VM, stopped)");
});

test("normalizes inline VM inventory rows into renderer-friendly format", () => {
  const response = `VMs on node yin
- sentinelZero | Status: running | Details: node=yin | trace=compute-vm:yin:200 | Source: Digital twin (Proxmox ingest); agent status unknown
- ubuntu-cloud-template | Status: stopped | Details: node=yin | trace=compute-vm:yin:8001 | Source: Digital twin (Proxmox ingest); agent status unknown`;

  const packaged = applyAdaptivePackaging(response, {
    userQuery: "List all VMs currently on yin.",
    intentType: "compute_status",
  });

  expect(packaged).toBeTruthy();
  expect(packaged).toContain("VMs on node yin:");
  expect(packaged).toContain("- sentinelZero (VM, running)");
  expect(packaged).toContain("- ubuntu-cloud-template (VM, stopped)");
  expect(packaged).toContain("trace=compute-vm:yin:200");
  expect(packaged).toContain("trace=compute-vm:yin:8001");
});

test("normalizes LXC inline inventory rows into renderer-friendly format", () => {
  const response = `LXC Containers
- PvVPN-Home | Status: running | Node: YANG | Trace: compute-vm:yang:103
- homebridge | Status: running | Node: YANG | Trace: compute-vm:yang:100`;

  const packaged = applyAdaptivePackaging(response, {
    userQuery: "list all the lxcs running",
    intentType: "compute_status",
  });

  expect(packaged).toBeTruthy();
  expect(packaged).toContain("LXC Containers:");
  expect(packaged).toContain("- PvVPN-Home (LXC, running)");
  expect(packaged).toContain("- homebridge (LXC, running)");
  expect(packaged).toContain("trace=compute-vm:yang:103");
  expect(packaged).toContain("trace=compute-vm:yang:100");
});
