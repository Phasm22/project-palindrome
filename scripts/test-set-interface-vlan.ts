#!/usr/bin/env bun

import { setInterfaceVlan } from "../src/actions/network/set-interface-vlan";
import { ProxmoxClient } from "../src/tools/proxmox/client";

async function findVmOnNode(node: string): Promise<number | null> {
  try {
    const nodeLower = node.toLowerCase();
    let url: string;
    let tokenId: string | undefined;
    let tokenSecret: string | undefined;
    
    if (nodeLower === "yin" || nodeLower === "yang") {
      url = nodeLower === "yin"
        ? process.env.PROXMOX_YIN_URL || process.env.PROXMOX_URL || ""
        : process.env.PROXMOX_YANG_URL || process.env.PROXMOX_URL || "";
      tokenId = process.env.CLUSTER_TF_TOKEN_ID;
      if (nodeLower === "yin") {
        tokenSecret = process.env.PROXMOX_YIN_TF_SECRET || process.env.PROXMOX_CLUSTER_TF_SECRET;
      } else {
        tokenSecret = process.env.PROXMOX_YANG_TF_SECRET || process.env.PROXMOX_CLUSTER_TF_SECRET;
      }
    } else {
      url = process.env.PROXMOX_URL || "";
      tokenId = process.env.CLUSTER_TF_TOKEN_ID || process.env.PROXBIG_TF_TOKEN_ID;
      tokenSecret = process.env.PROXMOX_PROXBIG_TF_SECRET || process.env.PROXBIG_TF_SECRET || process.env.PROXBIG_TOKEN_SECRET || process.env.PROXMOX_CLUSTER_TF_SECRET;
    }
    
    if (!url || !tokenId || !tokenSecret) {
      return null;
    }

    const client = new ProxmoxClient({
      url,
      tokenId,
      tokenSecret,
      verifySsl: process.env.PROXMOX_VERIFY_SSL !== "false",
    });

    const normalizedNode = nodeLower === "yang" ? "YANG" : node;
    const result = await client.get(`nodes/${normalizedNode}/qemu`);
    const vms = result.data.data || [];
    
    if (vms.length > 0) {
      return vms[0].vmid;
    }
    return null;
  } catch (error) {
    return null;
  }
}

async function main() {
  console.log("🧪 Testing Set Interface VLAN Action\n");

  // Find an existing VM on YANG
  console.log("🔍 Finding an existing VM on YANG...");
  const existingVmId = await findVmOnNode("YANG");
  
  if (!existingVmId) {
    console.error("❌ No VMs found on YANG. Please create a VM first or specify a VM ID manually.");
    process.exit(1);
  }

  console.log(`✅ Found VM ${existingVmId} on YANG\n`);

  // Test parameters
  const testParams = {
    vmid: existingVmId,
    node: "YANG",
    vlanId: 50,
    bridge: "vmbr2", // vmbr2 has VLAN 50 configured on the switch
    dryRun: true, // Start with dry-run for safety
  };

  console.log("📋 Test Parameters:");
  console.log(`   vmid: ${testParams.vmid}`);
  console.log(`   node: ${testParams.node}`);
  console.log(`   vlanId: ${testParams.vlanId}`);
  console.log(`   bridge: ${testParams.bridge}`);
  console.log(`   dryRun: ${testParams.dryRun}\n`);

  try {
    console.log("🔍 Validating VLAN and VM...\n");
    const result = await setInterfaceVlan(testParams);

    console.log("📊 Result:");
    console.log(`   Success: ${result.success}`);
    console.log(`   Message: ${result.message}`);
    if (result.vmid) console.log(`   VM ID: ${result.vmid}`);
    if (result.vlanId) console.log(`   VLAN ID: ${result.vlanId}`);
    if (result.bridge) console.log(`   Bridge: ${result.bridge}`);

    if (result.success) {
      console.log("\n✅ Dry-run successful! The action validated correctly.");
      console.log("\n💡 To actually assign the VLAN, set dryRun: false");
      console.log("   Note: VM may need to be restarted for network changes to take effect.");
    } else {
      console.log("\n❌ Validation failed. Check the error message above.");
      process.exit(1);
    }
  } catch (error: any) {
    console.error("\n❌ Error executing set-interface-vlan action:");
    console.error(`   ${error.message}`);
    if (error.stack) {
      console.error("\nStack trace:");
      console.error(error.stack);
    }
    process.exit(1);
  } finally {
    // Force exit to close any hanging connections
    process.exit(0);
  }
}

main();

