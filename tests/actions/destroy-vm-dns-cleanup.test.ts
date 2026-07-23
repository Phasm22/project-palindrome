import { describe, test, expect } from "bun:test";
import {
  deleteDnsRecordForDestroyedVm,
  normalizeDestroyVmIdentifiers,
  type PiholeDnsClient,
} from "../../src/actions/compute/destroy-vm";
import type { DnsRecord } from "../../src/tools/pihole/client";

describe("deleteDnsRecordForDestroyedVm", () => {
  test("returns dnsRecordDeleted true and calls delete when record exists", async () => {
    const records: DnsRecord[] = [
      { domain: "aha.prox", ip: "172.16.50.10" },
      { domain: "other.prox", ip: "172.16.50.11" },
    ];
    let listCalls = 0;
    const mockClient: PiholeDnsClient = {
      listDnsRecords: async () => {
        listCalls++;
        return listCalls === 1 ? records : records.filter((r) => r.domain !== "aha.prox");
      },
      deleteDnsRecord: async (domain, ip) => {
        expect(domain).toBe("aha.prox");
        expect(ip).toBe("172.16.50.10");
      },
    };

    const result = await deleteDnsRecordForDestroyedVm(mockClient, "aha.prox", "aha");

    expect(result.dnsRecordDeleted).toBe(true);
  });

  test("returns dnsRecordDeleted false when no matching record", async () => {
    const records: DnsRecord[] = [{ domain: "other.prox", ip: "172.16.50.11" }];
    const mockClient: PiholeDnsClient = {
      listDnsRecords: async () => records,
      deleteDnsRecord: async () => {
        expect(true).toBe(false);
      },
    };

    const result = await deleteDnsRecordForDestroyedVm(mockClient, "missing.prox", "missing");

    expect(result.dnsRecordDeleted).toBe(false);
  });

  test("matches domain case-insensitively and trims trailing dot", async () => {
    const records: DnsRecord[] = [{ domain: "AHA.PROX.", ip: "172.16.50.10" }];
    let deleteCalled = false;
    const mockClient: PiholeDnsClient = {
      listDnsRecords: async () => (deleteCalled ? [] : records),
      deleteDnsRecord: async (domain, ip) => {
        deleteCalled = true;
        expect(domain).toBe("AHA.PROX.");
        expect(ip).toBe("172.16.50.10");
      },
    };

    const result = await deleteDnsRecordForDestroyedVm(mockClient, "aha.prox", "aha");

    expect(result.dnsRecordDeleted).toBe(true);
    expect(deleteCalled).toBe(true);
  });

  test("uses dnsDomain from normalizeDestroyVmIdentifiers for consistency", () => {
    expect(normalizeDestroyVmIdentifiers("aha.prox").dnsDomain).toBe("aha.prox");
    expect(normalizeDestroyVmIdentifiers("aha").dnsDomain).toBe("aha.prox");
    expect(normalizeDestroyVmIdentifiers("aha.prox.").dnsDomain).toBe("aha.prox");
  });
});
