#!/usr/bin/env bun

/**
 * Guest Agent Diagnostic Tool
 * 
 * Checks guest agent status for a VM:
 * 1. Proxmox config (agent enabled)
 * 2. Package installed (via SSH)
 * 3. Service running (via SSH)
 * 4. API query (agent/network-get-interfaces)
 */

import { ProxmoxClient } from "../src/tools/proxmox/client";
import { normalizeNodeId } from "../src/parsers/compute/helpers";

// Get Proxmox client config for a node (simplified version)
function getProxmoxClientConfig(node: string) {
  const nodeLower = node.toLowerCase();
  
  let url: string;
  let tokenId: string | undefined;
  let tokenSecret: string | undefined;
  
  if (nodeLower === "yin" || nodeLower === "yang") {
    url = nodeLower === "yin"
      ? process.env.PROXMOX_YIN_URL || process.env.PROXMOX_URL || `https://yin.prox:8006`
      : process.env.PROXMOX_YANG_URL || process.env.PROXMOX_URL || `https://YANG.prox:8006`;
    tokenId = process.env.CLUSTER_TF_TOKEN_ID || process.env.PROXMOX_TOKEN_ID;
    if (nodeLower === "yin") {
      tokenSecret = process.env.PROXMOX_YIN_TF_SECRET || process.env.PROXMOX_CLUSTER_TF_SECRET;
    } else {
      tokenSecret = process.env.PROXMOX_YANG_TF_SECRET || process.env.PROXMOX_CLUSTER_TF_SECRET;
    }
  } else {
    url = process.env.PROXMOX_URL || `https://proxBig.prox:8006`;
    tokenId = process.env.CLUSTER_TF_TOKEN_ID || process.env.PROXBIG_TF_TOKEN_ID || process.env.PROXMOX_TOKEN_ID;
    tokenSecret = process.env.PROXMOX_PROXBIG_TF_SECRET || process.env.PROXBIG_TF_SECRET || process.env.PROXMOX_CLUSTER_TF_SECRET;
  }
  
  if (!url || !tokenId || !tokenSecret) {
    throw new Error(`Missing Proxmox API configuration for node "${node}". Check environment variables.`);
  }
  
  return { url, tokenId, tokenSecret };
}

interface GuestAgentStatus {
  vmid: number;
  node: string;
  vmName: string;
  config: {
    agentEnabled: boolean;
    agentValue: any;
  };
  package: {
    installed: boolean;
    error?: string;
  };
  service: {
    running: boolean;
    enabled: boolean;
    error?: string;
  };
  api: {
    reachable: boolean;
    error?: string;
    response?: any;
  };
}

async function checkGuestAgent(vmid: number, node: string): Promise<GuestAgentStatus> {
  // Normalize node name: handle both "YANG" and "yang", etc.
  let normalizedNode = node.toUpperCase();
  if (normalizedNode === "YANG" || normalizedNode === "YIN") {
    normalizedNode = normalizedNode === "YANG" ? "YANG" : "yin";
  } else if (normalizedNode === "PROXBIG" || normalizedNode === "PROX_BIG") {
    normalizedNode = "proxBig";
  }
  
  const proxmoxConfig = getProxmoxClientConfig(normalizedNode);
  const proxmoxClient = new ProxmoxClient({
    url: proxmoxConfig.url,
    tokenId: proxmoxConfig.tokenId,
    tokenSecret: proxmoxConfig.tokenSecret,
    verifySsl: process.env.PROXMOX_VERIFY_SSL !== "false",
  });

  // Get VM config
  const vmConfig = await proxmoxClient.get(`/nodes/${normalizedNode}/qemu/${vmid}/config`);
  const vmStatus = await proxmoxClient.get(`/nodes/${normalizedNode}/qemu/${vmid}/status/current`);
  const vmName = vmConfig.data.data.name || `VM ${vmid}`;

  const status: GuestAgentStatus = {
    vmid,
    node: normalizedNode,
    vmName,
    config: {
      agentEnabled: false,
      agentValue: vmConfig.data.data.agent,
    },
    package: {
      installed: false,
    },
    service: {
      running: false,
      enabled: false,
    },
    api: {
      reachable: false,
    },
  };

  // Check 1: Proxmox config
  const agentValue = vmConfig.data.data.agent;
  // Handle different formats: 1, "1", "enabled", or "enabled=1,..."
  status.config.agentEnabled = 
    agentValue === 1 || 
    agentValue === "1" || 
    agentValue === "enabled" ||
    (typeof agentValue === "string" && agentValue.includes("enabled=1"));
  status.config.agentValue = agentValue;

  // Check 2 & 3: Package and service (via Proxmox guest agent exec API)
  // Note: These checks require guest agent to be running, so they may fail if agent isn't working
  // We'll try them but mark as "unknown" if guest agent isn't available
  if (status.config.agentEnabled && status.api.reachable) {
    // Only try package/service checks if agent is enabled and API is reachable
    try {
      // Try to check package via guest agent exec
      try {
        const packageCheck = await proxmoxClient.post(
          `/nodes/${normalizedNode}/qemu/${vmid}/agent/exec`,
          {
            command: "/usr/bin/dpkg",
            arguments: ["-l", "qemu-guest-agent"],
          }
        );
        // If we get a response, check if package is listed
        const output = packageCheck.data.data?.out || "";
        status.package.installed = output.includes("qemu-guest-agent");
      } catch (error: any) {
        // Guest agent exec might not be available
        status.package.error = `Cannot check package: ${error.message}`;
      }

      // Check service status via guest agent
      try {
        const serviceStatus = await proxmoxClient.post(
          `/nodes/${normalizedNode}/qemu/${vmid}/agent/exec-status`,
          {
            command: "/usr/bin/systemctl",
            arguments: ["is-active", "qemu-guest-agent.service"],
          }
        );
        const output = serviceStatus.data.data?.out || "";
        status.service.running = output.trim() === "active";

        const serviceEnabled = await proxmoxClient.post(
          `/nodes/${normalizedNode}/qemu/${vmid}/agent/exec-status`,
          {
            command: "/usr/bin/systemctl",
            arguments: ["is-enabled", "qemu-guest-agent.service"],
          }
        );
        const enabledOutput = serviceEnabled.data.data?.out || "";
        status.service.enabled = enabledOutput.trim() === "enabled";
      } catch (error: any) {
        status.service.error = `Cannot check service: ${error.message}`;
      }
    } catch (error: any) {
      status.package.error = error.message;
      status.service.error = error.message;
    }
  } else {
    status.package.error = "Cannot check package/service: guest agent not enabled or not reachable";
    status.service.error = "Cannot check package/service: guest agent not enabled or not reachable";
  }

  // Check 4: API query
  try {
    const agentResponse = await proxmoxClient.get(
      `/nodes/${normalizedNode}/qemu/${vmid}/agent/network-get-interfaces`
    );
    status.api.reachable = true;
    status.api.response = agentResponse.data.data;
  } catch (error: any) {
    status.api.error = error.message;
    if (error.response) {
      status.api.error = `HTTP ${error.response.status}: ${error.response.statusText}`;
    }
  }

  return status;
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.error("Usage: bun scripts/check-guest-agent.ts <vmid> <node>");
    console.error("Example: bun scripts/check-guest-agent.ts 9000 YANG");
    process.exit(1);
  }

  const vmid = parseInt(args[0]);
  const node = args[1];

  if (isNaN(vmid)) {
    console.error(`Invalid VM ID: ${args[0]}`);
    process.exit(1);
  }

  console.log(`\n🔍 Checking guest agent status for VM ${vmid} on node ${node}...\n`);

  try {
    const status = await checkGuestAgent(vmid, node);

    console.log(`VM: ${status.vmName} (ID: ${status.vmid}, Node: ${status.node})\n`);

    // Config check
    console.log("1️⃣  Proxmox Config:");
    console.log(`   Agent enabled: ${status.config.agentEnabled ? "✅ YES" : "❌ NO"}`);
    console.log(`   Agent value: ${JSON.stringify(status.config.agentValue)}`);

    // Package check
    console.log("\n2️⃣  Package Installation:");
    if (status.package.error) {
      console.log(`   Status: ⚠️  Error: ${status.package.error}`);
    } else {
      console.log(`   Installed: ${status.package.installed ? "✅ YES" : "❌ NO"}`);
    }

    // Service check
    console.log("\n3️⃣  Service Status:");
    if (status.service.error) {
      console.log(`   Status: ⚠️  Error: ${status.service.error}`);
    } else {
      console.log(`   Running: ${status.service.running ? "✅ YES" : "❌ NO"}`);
      console.log(`   Enabled: ${status.service.enabled ? "✅ YES" : "❌ NO"}`);
    }

    // API check
    console.log("\n4️⃣  API Query:");
    if (status.api.error) {
      console.log(`   Reachable: ❌ NO`);
      console.log(`   Error: ${status.api.error}`);
    } else {
      console.log(`   Reachable: ✅ YES`);
      if (status.api.response?.result) {
        const interfaces = status.api.response.result;
        console.log(`   Network interfaces: ${interfaces.length}`);
        interfaces.forEach((iface: any, idx: number) => {
          const ips = iface["ip-addresses"] || [];
          const ipv4s = ips.filter((ip: any) => ip["ip-address-type"] === "ipv4" && !ip["ip-address"].startsWith("127."));
          console.log(`     ${idx + 1}. ${iface.name || "unknown"}: ${ipv4s.length > 0 ? ipv4s.map((ip: any) => ip["ip-address"]).join(", ") : "no IPv4"}`);
        });
      }
    }

    // Summary
    console.log("\n📊 Summary:");
    const allGood = 
      status.config.agentEnabled &&
      status.package.installed &&
      status.service.running &&
      status.service.enabled &&
      status.api.reachable;

    if (allGood) {
      console.log("   ✅ Guest agent is fully operational!");
    } else {
      console.log("   ⚠️  Guest agent has issues:");
      if (!status.config.agentEnabled) {
        console.log("      - Agent not enabled in Proxmox config");
        console.log("      - Fix: Run `qm set ${status.vmid} --agent enabled=1`");
      }
      if (!status.package.installed) {
        console.log("      - Package not installed in VM");
        console.log("      - Fix: SSH into VM and run `apt install qemu-guest-agent`");
      }
      if (!status.service.running) {
        console.log("      - Service not running");
        console.log("      - Fix: SSH into VM and run `systemctl start qemu-guest-agent`");
      }
      if (!status.service.enabled) {
        console.log("      - Service not enabled");
        console.log("      - Fix: SSH into VM and run `systemctl enable qemu-guest-agent`");
      }
      if (!status.api.reachable) {
        console.log("      - API query failed");
        if (status.api.error?.includes("403")) {
          console.log("      - Fix: Check API token permissions (needs VM.Monitor + VM.Audit)");
        } else if (status.api.error?.includes("500") || status.api.error?.includes("501")) {
          console.log("      - Fix: Ensure guest agent is running and VM is booted");
        }
      }
    }

  } catch (error: any) {
    console.error("\n❌ Error checking guest agent:");
    console.error(`   ${error.message}`);
    if (error.stack) {
      console.error("\nStack trace:");
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();

