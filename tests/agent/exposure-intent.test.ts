import { detectExposureIntent } from "../../src/reasoning/detectExposureIntent";

test("detectExposureIntent detects vm reachability from subnet", () => {
  const intent = detectExposureIntent("Is VM 101 reachable from subnet 172.16.0.0/22?");
  expect(intent).toBeTruthy();
  expect(intent?.type).toBe("vm_reachability");
});

test("detectExposureIntent detects vms exposed to subnet", () => {
  const intent = detectExposureIntent("Which VMs are reachable from 172.16.0.0/22?");
  expect(intent).toBeTruthy();
  expect(intent?.type).toBe("vms_exposed_to_subnet");
});
