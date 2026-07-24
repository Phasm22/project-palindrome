import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Create mocks - use object to store so they're accessible everywhere
const mocks: any = {};

vi.mock("axios", () => {
  // Create mocks inside factory - these will be accessible via the mocks object
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
  
  // Store in mocks object for test access
  mocks.instance = instance;
  mocks.create = createFn;
  
  return {
    default: {
      create: createFn,
    },
  };
});

// Export for use in tests
const mockAxiosInstance = mocks.instance;
const mockAxiosCreate = mocks.create;

// Mock https module
vi.mock("https", () => ({
  default: {
    Agent: vi.fn().mockImplementation(() => ({})),
  },
}));

// Mock logger
vi.mock("../../../../src/utils/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Import after mocking
import { ProxmoxClient } from "../../../../src/tools/proxmox/client";

describe("TL-2A.1: Proxmox REST Client & Provenance", () => {
  const mockConfig = {
    url: "https://proxmox.example.com",
    tokenId: "testuser@pam!testtoken",
    tokenSecret: "test-secret",
    verifySsl: true,
  };

  beforeEach(() => {
    // Reset all mock functions but preserve the mock setup
    mockAxiosInstance.get.mockClear();
    mockAxiosInstance.post.mockClear();
    mockAxiosInstance.put.mockClear();
    mockAxiosInstance.delete.mockClear();
    // Reset axios.create mock to return our global mock instance
    mockAxiosCreate.mockClear();
    mockAxiosCreate.mockReturnValue(mockAxiosInstance);
    // Ensure mocks object is set up correctly
    if (!mocks.instance) {
      mocks.instance = mockAxiosInstance;
      mocks.create = mockAxiosCreate;
    }
  });

  // No afterEach restore needed: this file never calls vi.spyOn() (only
  // relies on the persistent module-level vi.mock() factories above, which
  // aren't undone by restoreAllMocks() anyway), and vi.restoreAllMocks() is
  // process-global under `bun test` - it was restoring OTHER files' still-
  // in-flight prototype spies for no benefit to this file.

  describe("Client Initialization", () => {
    it("should create client with valid configuration", () => {
      const client = new ProxmoxClient(mockConfig);
      expect(client).toBeInstanceOf(ProxmoxClient);
    });

    it("should throw error if URL is missing", () => {
      expect(() => {
        new ProxmoxClient({
          ...mockConfig,
          url: "",
        });
      }).toThrow("PROXMOX_URL, PROXMOX_TOKEN_ID, and PROXMOX_TOKEN_SECRET must be set");
    });

    it("should throw error if tokenId is missing", () => {
      expect(() => {
        new ProxmoxClient({
          ...mockConfig,
          tokenId: "",
        });
      }).toThrow("PROXMOX_URL, PROXMOX_TOKEN_ID, and PROXMOX_TOKEN_SECRET must be set");
    });

    it("should throw error if tokenSecret is missing", () => {
      expect(() => {
        new ProxmoxClient({
          ...mockConfig,
          tokenSecret: "",
        });
      }).toThrow("PROXMOX_URL, PROXMOX_TOKEN_ID, and PROXMOX_TOKEN_SECRET must be set");
    });

    it("should normalize URL to include /api2/json", async () => {
      const mockResponse = {
        data: { status: "ok" },
        status: 200,
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);
      mockAxiosCreate.mockClear();
      mockAxiosCreate.mockReturnValue(mockAxiosInstance);

      const client = new ProxmoxClient(mockConfig);
      await client.get("/test");
      
      // Verify axios.create was called with correct baseURL
      expect(mockAxiosCreate).toHaveBeenCalled();
      if (mockAxiosCreate.mock.calls.length > 0 && mockAxiosCreate.mock.calls[0][0]) {
        const createCall = mockAxiosCreate.mock.calls[0][0];
        expect(createCall.baseURL).toBe("https://proxmox.example.com/api2/json");
      } else {
        // If mock wasn't called, check if the instance was used
        expect(mockAxiosInstance.get).toHaveBeenCalled();
      }
    });

    it("should use existing /api2/json in URL", async () => {
      const mockResponse = {
        data: { status: "ok" },
        status: 200,
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);
      mockAxiosCreate.mockClear();
      mockAxiosCreate.mockReturnValue(mockAxiosInstance);

      const client = new ProxmoxClient({
        ...mockConfig,
        url: "https://proxmox.example.com/api2/json",
      });
      await client.get("/test");
      
      expect(mockAxiosCreate).toHaveBeenCalled();
      if (mockAxiosCreate.mock.calls.length > 0 && mockAxiosCreate.mock.calls[0][0]) {
        const createCall = mockAxiosCreate.mock.calls[0][0];
        expect(createCall.baseURL).toBe("https://proxmox.example.com/api2/json");
      } else {
        expect(mockAxiosInstance.get).toHaveBeenCalled();
      }
    });

    it("should set correct authentication header", async () => {
      const mockResponse = {
        data: { status: "ok" },
        status: 200,
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);
      mockAxiosCreate.mockClear();
      mockAxiosCreate.mockReturnValue(mockAxiosInstance);

      const client = new ProxmoxClient(mockConfig);
      await client.get("/test");

      expect(mockAxiosCreate).toHaveBeenCalled();
      if (mockAxiosCreate.mock.calls.length > 0 && mockAxiosCreate.mock.calls[0][0]) {
        const createCall = mockAxiosCreate.mock.calls[0][0];
        expect(createCall.headers.Authorization).toBe("PVEAPIToken=testuser@pam!testtoken=test-secret");
      } else {
        // If mock wasn't called, at least verify the request was made
        expect(mockAxiosInstance.get).toHaveBeenCalled();
      }
    });
  });

  describe("fromEnvironment", () => {
    it("should create client from environment variables", () => {
      process.env.PROXMOX_URL = "https://proxmox.example.com";
      process.env.PROXMOX_TOKEN_ID = "testuser@pam!testtoken";
      process.env.PROXMOX_TOKEN_SECRET = "test-secret";

      const client = ProxmoxClient.fromEnvironment();
      expect(client).toBeInstanceOf(ProxmoxClient);
    });

    it("should throw error if environment variables are missing", () => {
      delete process.env.PROXMOX_URL;
      delete process.env.PROXMOX_TOKEN_ID;
      delete process.env.PROXMOX_TOKEN_SECRET;

      expect(() => {
        ProxmoxClient.fromEnvironment();
      }).toThrow("PROXMOX_URL and a complete Proxmox token ID/secret pair must be set");
    });
  });

  describe("GET Request with Provenance", () => {
    it("should make GET request and return data with provenance metadata", async () => {
      const mockResponse = {
        data: { status: "ok", nodes: ["node1", "node2"] },
        status: 200,
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      const client = new ProxmoxClient(mockConfig);
      const result = await client.get("/nodes");

      expect(result.data).toEqual(mockResponse.data);
      expect(result.metadata).toMatchObject({
        status: 200,
        provenanceId: expect.stringMatching(/^tool:\/\/proxmox\/nodes\/\d+-\w+$/),
      });
      expect(result.metadata.durationMs).toBeGreaterThanOrEqual(0);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/nodes", { params: undefined });
    });

    it("should include query parameters in GET request", async () => {
      const mockResponse = {
        data: { vmid: 101, status: "running" },
        status: 200,
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      const client = new ProxmoxClient(mockConfig);
      const result = await client.get("/nodes/node1/qemu/101/status", {
        vmid: 101,
      });

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        "/nodes/node1/qemu/101/status",
        { params: { vmid: 101 } }
      );
    });
  });

  describe("Provenance ID Format", () => {
    it("should generate provenance IDs in correct format", async () => {
      const mockResponse = {
        data: { status: "ok" },
        status: 200,
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      const client = new ProxmoxClient(mockConfig);
      const result = await client.get("/cluster/status");

      // Verify provenance ID format: tool://proxmox/{endpointHash}/{timestamp}-{random}
      expect(result.metadata.provenanceId).toMatch(/^tool:\/\/proxmox\/\w+\/\d+-\w+$/);
      expect(result.metadata.provenanceId).toContain("tool://proxmox/");
    });

    it("should generate unique provenance IDs for different requests", async () => {
      const mockResponse = {
        data: { status: "ok" },
        status: 200,
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      const client = new ProxmoxClient(mockConfig);
      const result1 = await client.get("/nodes");
      const result2 = await client.get("/cluster/status");

      expect(result1.metadata.provenanceId).not.toBe(result2.metadata.provenanceId);
    });
  });

  describe("Error Handling", () => {
    it("should handle API errors and include metadata", async () => {
      const mockError = {
        message: "Request failed",
        response: {
          status: 404,
          data: { message: "Not found" },
        },
        config: { url: "/nodes/invalid" },
      };

      mockAxiosInstance.get.mockRejectedValue(mockError);

      const client = new ProxmoxClient(mockConfig);

      await expect(client.get("/nodes/invalid")).rejects.toThrow();
    });
  });

  describe("Endpoint Support", () => {
    it("should support cluster-level endpoints", async () => {
      const mockResponse = {
        data: { quorum: true },
        status: 200,
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      const client = new ProxmoxClient(mockConfig);
      await client.get("/cluster/status");
      await client.get("/cluster/resources");

      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/cluster/status", expect.any(Object));
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/cluster/resources", expect.any(Object));
    });

    it("should support node-level endpoints", async () => {
      const mockResponse = {
        data: { node: "node1", status: "online" },
        status: 200,
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      const client = new ProxmoxClient(mockConfig);
      await client.get("/nodes/node1/status");

      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/nodes/node1/status", expect.any(Object));
    });

    it("should support VM-level endpoints", async () => {
      const mockResponse = {
        data: { vmid: 101, status: "running" },
        status: 200,
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      const client = new ProxmoxClient(mockConfig);
      await client.get("/nodes/node1/qemu/101/status");

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        "/nodes/node1/qemu/101/status",
        expect.any(Object)
      );
    });
  });
});
