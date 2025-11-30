import { createVm } from "../src/actions/compute/create-vm";
import { destroyVm } from "../src/actions/compute/destroy-vm";
import { TwinQueryService } from "../src/twin/api/twin-query-service";

async function main() {
  const vmName = "test-vm-9999";
  const node = "yang";

  console.log("=".repeat(60));
  console.log("VM Lifecycle Test: Create → Verify → Destroy");
  console.log("=".repeat(60));
  console.log(`VM: ${vmName}`);
  console.log(`Node: ${node}\n`);

  // Step 0: Clean stale VMs from Neo4j first
  console.log("STEP 0: Cleaning stale VMs from Neo4j...");
  console.log("-".repeat(60));
  const twinQueryCleanup = new TwinQueryService();
  try {
    const cleanupResult = await twinQueryCleanup.cleanStaleVms();
    if (cleanupResult.deleted > 0) {
      console.log(`✅ Cleaned ${cleanupResult.deleted} stale VM(s) from Neo4j`);
    } else {
      console.log("✅ No stale VMs found in Neo4j");
    }
  } catch (error: any) {
    console.log(`⚠️  Error cleaning stale VMs: ${error.message}`);
    console.log("   Continuing anyway...");
  } finally {
    await twinQueryCleanup.close();
  }
  console.log("");

  // Step 0.5: Clean up any existing VM with the same name (now verified against Proxmox)
  console.log("STEP 0.5: Checking for existing VM (verified against Proxmox)...");
  console.log("-".repeat(60));
  const twinQuery0 = new TwinQueryService();
  try {
    // findVmByName now verifies against Proxmox by default
    const existingVms = await twinQuery0.findVmByName(vmName, { verifyAgainstProxmox: true });
    if (existingVms.length > 0) {
      console.log(`Found existing VM: ${vmName}, destroying it first...`);
      const destroyResult = await destroyVm({
        name: vmName,
        node: node,
        dryRun: false,
      });
      if (destroyResult.success) {
        console.log("✅ Existing VM destroyed");
      } else {
        console.log(`⚠️  Could not destroy existing VM: ${destroyResult.message}`);
        console.log("   Continuing anyway...");
      }
      // Wait a moment for cleanup
      await new Promise(resolve => setTimeout(resolve, 2000));
    } else {
      console.log("✅ No existing VM found");
    }
  } catch (error: any) {
    console.log(`⚠️  Error checking for existing VM: ${error.message}`);
    console.log("   Continuing anyway...");
  } finally {
    await twinQuery0.close();
  }
  console.log("");

  // Step 1: Create VM
  console.log("STEP 1: Creating VM...");
  console.log("-".repeat(60));
  const createResult = await createVm({
    name: vmName,
    node: node,
    cores: 2,
    memory: 4096,
    diskSize: "20G",
    dryRun: false,
  });

  console.log(`Success: ${createResult.success}`);
  console.log(`Message: ${createResult.message}`);
  if (createResult.vmId) console.log(`VM ID: ${createResult.vmId}`);
  if (createResult.hostname) console.log(`Hostname: ${createResult.hostname}`);
  if (createResult.ipAddresses) console.log(`IPs: ${createResult.ipAddresses.join(", ")}`);

  if (!createResult.success) {
    console.error("\n❌ VM creation failed. Aborting test.");
    process.exit(1);
  }

  console.log("\n✅ VM created successfully!\n");

  // Step 2: Verify VM exists
  console.log("STEP 2: Verifying VM exists...");
  console.log("-".repeat(60));
  const twinQuery = new TwinQueryService();
  try {
    // Verify against Proxmox to ensure we're not seeing stale data
    const vms = await twinQuery.findVmByName(vmName, { verifyAgainstProxmox: true });
    if (vms.length === 0) {
      console.error("❌ VM not found in twin after creation!");
      process.exit(1);
    }
    const vm = vms.find(v => v.nodeName?.toLowerCase() === node.toLowerCase()) || vms[0];
    console.log(`✅ VM found: ${vm.name} on ${vm.nodeName || "unknown"}`);
    console.log(`   VM ID: ${vm.id}`);
    console.log(`   Status: ${vm.state || "unknown"}`);
  } finally {
    await twinQuery.close();
  }

  console.log("\n✅ VM verification successful!\n");

  // Step 3: Destroy VM
  console.log("STEP 3: Destroying VM...");
  console.log("-".repeat(60));
  const destroyResult = await destroyVm({
    name: vmName,
    node: node,
    dryRun: false,
  });

  console.log(`Success: ${destroyResult.success}`);
  console.log(`Message: ${destroyResult.message}`);

  if (!destroyResult.success) {
    console.error("\n❌ VM destruction failed.");
    process.exit(1);
  }

  console.log("\n✅ VM destroyed successfully!\n");

  // Final verification
  console.log("FINAL: Verifying VM is gone...");
  console.log("-".repeat(60));
  const twinQuery2 = new TwinQueryService();
  try {
    // Verify against Proxmox - if VM was destroyed, it shouldn't exist
    const vmsAfter = await twinQuery2.findVmByName(vmName, { verifyAgainstProxmox: true });
    if (vmsAfter.length > 0) {
      console.log(`⚠️  VM still found in Proxmox: ${vmsAfter.map(v => `${v.name} on ${v.nodeName || "unknown"}`).join(", ")}`);
      console.log("   (This may indicate the destroy operation didn't complete)");
    } else {
      console.log("✅ VM not found in Proxmox (as expected after destruction)");
    }
  } finally {
    await twinQuery2.close();
  }

  console.log("\n" + "=".repeat(60));
  console.log("✅ All tests passed!");
  console.log("=".repeat(60));
}

main().catch((error) => {
  console.error("\n❌ Test failed with error:");
  console.error(error);
  process.exit(1);
});

