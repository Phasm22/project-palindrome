import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks: any = {};
const loggerCounters = new Map<string, number>();

vi.mock("axios", () => {
  const instance = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
  };
  const createFn = vi.fn(() => instance);
  mocks.instance = instance;
  mocks.create = createFn;
  return {
    default: {
      create: createFn,
    },
  };
});

vi.mock("https", () => ({
  default: {
    Agent: class Agent {},
  },
}));

vi.mock("../../../src/pce/utils/logger", () => ({
  pceLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    incrementCounter: vi.fn((counterName: string, amount: number = 1) => {
      loggerCounters.set(counterName, (loggerCounters.get(counterName) ?? 0) + amount);
    }),
    getCounter: vi.fn((counterName: string) => loggerCounters.get(counterName) ?? 0),
    getAllCounters: vi.fn(() => Object.fromEntries(loggerCounters.entries())),
    resetCounters: vi.fn(() => {
      loggerCounters.clear();
    }),
    logCounters: vi.fn(),
    logHashComparison: vi.fn(),
    logDocumentStatusChange: vi.fn(),
  },
}));

const mockAxiosInstance = mocks.instance!;
const mockAxiosCreate = mocks.create!;

import { PiholeClient } from "../../../src/tools/pihole/client";

describe("PiholeClient DNS record operations", () => {
  const mockConfig = {
    url: "https://pihole.example.com",
    webPassword: "test-password",
    verifySsl: false,
  };

  beforeEach(() => {
    loggerCounters.clear();
    mockAxiosInstance.get.mockClear();
    mockAxiosInstance.post.mockClear();
    mockAxiosInstance.delete.mockClear();
    mockAxiosCreate.mockClear();
    mockAxiosCreate.mockReturnValue(mockAxiosInstance);
    // Login: post must resolve with Set-Cookie so client gets session
    mockAxiosInstance.post.mockResolvedValue({
      headers: { "set-cookie": ["sid=test-session-id; path=/"] },
      data: {},
      status: 200,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("listDnsRecords", () => {
    it("parses Pi-hole v6 hosts format and returns DnsRecord[]", async () => {
      mockAxiosInstance.get.mockResolvedValue({
        data: {
          config: {
            dns: {
              hosts: ["172.16.0.49 dad.prox", "10.0.0.1 web.prox"],
            },
          },
        },
        status: 200,
      });

      const client = new PiholeClient(mockConfig);
      const records = await client.listDnsRecords();

      expect(records).toEqual([
        { ip: "172.16.0.49", domain: "dad.prox" },
        { ip: "10.0.0.1", domain: "web.prox" },
      ]);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/config/dns/hosts");
    });

    it("returns empty array when hosts is not an array", async () => {
      mockAxiosInstance.get.mockResolvedValue({
        data: { config: { dns: { hosts: null } } },
        status: 200,
      });

      const client = new PiholeClient(mockConfig);
      const records = await client.listDnsRecords();

      expect(records).toEqual([]);
    });
  });

  describe("deleteDnsRecord", () => {
    it("throws when API returns success false", async () => {
      mockAxiosInstance.get.mockResolvedValue({
        data: { config: { dns: { hosts: ["172.16.0.1 vm.prox"] } } },
        status: 200,
      });
      mockAxiosInstance.delete.mockImplementation(() =>
        Promise.resolve({
          data: { success: false, message: "Record locked" },
          status: 200,
        })
      );

      const client = new PiholeClient(mockConfig);
      await expect(client.deleteDnsRecord("vm.prox", "172.16.0.1")).rejects.toThrow("Record locked");
      expect(mockAxiosInstance.delete).toHaveBeenCalled();
    });

    it("calls DELETE with correct URL and resolves when API returns success", async () => {
      const hostsBefore = ["172.16.0.49 vm.prox"];
      const hostsAfter: string[] = [];
      mockAxiosInstance.get
        .mockResolvedValueOnce({
          data: { config: { dns: { hosts: hostsBefore } } },
          status: 200,
        })
        .mockResolvedValueOnce({
          data: { config: { dns: { hosts: hostsAfter } } },
          status: 200,
        });
      mockAxiosInstance.delete.mockResolvedValue({
        data: { success: true },
        status: 200,
      });

      const client = new PiholeClient(mockConfig);
      await client.deleteDnsRecord("vm.prox", "172.16.0.49");

      expect(mockAxiosInstance.delete).toHaveBeenCalledWith(
        "/api/config/dns/hosts/172.16.0.49%20vm.prox"
      );
    });

    it("does not throw when record not found (idempotent)", async () => {
      mockAxiosInstance.get.mockResolvedValue({
        data: { config: { dns: { hosts: ["1.2.3.4 other.prox"] } } },
        status: 200,
      });

      const client = new PiholeClient(mockConfig);
      await expect(client.deleteDnsRecord("nonexistent.prox")).resolves.toBeUndefined();
      expect(mockAxiosInstance.delete).not.toHaveBeenCalled();
    });

    it("uses case-insensitive domain matching for deletion", async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce({
          data: { config: { dns: { hosts: ["172.16.0.1 VM.PROX"] } } },
          status: 200,
        })
        .mockResolvedValueOnce({
          data: { config: { dns: { hosts: [] } } },
          status: 200,
        });
      mockAxiosInstance.delete.mockResolvedValue({ data: { success: true }, status: 200 });

      const client = new PiholeClient(mockConfig);
      await client.deleteDnsRecord("vm.prox");

      expect(mockAxiosInstance.delete).toHaveBeenCalledWith(
        "/api/config/dns/hosts/172.16.0.1%20VM.PROX"
      );
    });

  });
});
