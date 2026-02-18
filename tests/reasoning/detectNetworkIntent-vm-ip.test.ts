import { detectNetworkIntent } from "../../src/reasoning/detectNetworkIntent";

test("what is the IP of sentinelZero returns vm_ip_by_name", () => {
  const intent = detectNetworkIntent("what is the IP of sentinelZero");
  expect(intent).not.toBeNull();
  expect(intent?.type).toBe("vm_ip_by_name");
  expect((intent as { vmNameOrId: string }).vmNameOrId).toBe("sentinelZero");
});

test("IP of X and IP address of X return vm_ip_by_name", () => {
  expect(detectNetworkIntent("IP of sentinelZero")?.type).toBe("vm_ip_by_name");
  expect((detectNetworkIntent("IP of sentinelZero") as { vmNameOrId: string }).vmNameOrId).toBe("sentinelZero");
  expect(detectNetworkIntent("what is the IP address of myvm")?.type).toBe("vm_ip_by_name");
  expect((detectNetworkIntent("what is the IP address of myvm") as { vmNameOrId: string }).vmNameOrId).toBe("myvm");
});

test("literal IP returns vm_by_ip not vm_ip_by_name", () => {
  const intent = detectNetworkIntent("which vm has IP 172.16.0.198");
  expect(intent?.type).toBe("vm_by_ip");
  expect((intent as { ip: string }).ip).toBe("172.16.0.198");
});
