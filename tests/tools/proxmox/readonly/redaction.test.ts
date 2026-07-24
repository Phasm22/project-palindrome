import { describe, it, expect } from "vitest";
import { Redactor } from "../../../../src/pce/redaction/redactor";
import { PROXMOX_REDACTION_PATTERNS, ALL_REDACTION_PATTERNS } from "../../../../src/pce/redaction/patterns";
import { sanitizeToolPayload } from "../../../../src/agent/tool-sanitizer";

describe("TL-2A.4: CRITICAL Redaction Test (Proxmox-Specific)", () => {
  const redactor = new Redactor(PROXMOX_REDACTION_PATTERNS);
  const allRedactor = new Redactor(ALL_REDACTION_PATTERNS);

  describe("Pattern 1: User Realm Identifiers", () => {
    it("should preserve user@pam identifiers", () => {
      const text = "User: root@pam logged in";
      const result = redactor.redact(text);
      expect(result.redactedText).toBe(text);
      expect(result.redactions).toHaveLength(0);
    });

    it("should preserve root@pve identifiers", () => {
      const text = "Node managed by root@pve";
      const result = redactor.redact(text);
      expect(result.redactedText).toBe(text);
      expect(result.redactions).toHaveLength(0);
    });

    it("should preserve automation@ldap identifiers", () => {
      const text = "Service account: automation@ldap";
      const result = redactor.redact(text);
      expect(result.redactedText).toBe(text);
      expect(result.redactions).toHaveLength(0);
    });

    it("should preserve multiple user realm identifiers", () => {
      const text = "Users: admin@pam, user@pve, service@ldap";
      const result = redactor.redact(text);
      expect(result.redactedText).toBe(text);
      expect(result.redactions).toHaveLength(0);
    });

    it("should preserve various realm types", () => {
      const realms = ["pam", "pve", "ldap", "ad", "openid", "oidc", "saml"];
      for (const realm of realms) {
        const text = `user@${realm}`;
        const result = redactor.redact(text);
        expect(result.redactedText).toBe(text);
        expect(result.redactions).toHaveLength(0);
      }
    });
  });

  describe("Pattern 2: API Token Names", () => {
    it("should redact API token names", () => {
      const text = "Token: myuser@pam!deploy";
      const result = redactor.redact(text);
      expect(result.redactedText).toContain("token-[REDACTED]");
      expect(result.redactedText).not.toContain("myuser@pam!deploy");
      expect(result.redactions.some((r) => r.pattern === "proxmox_api_token")).toBe(true);
    });

    it("should redact tokens with different realms", () => {
      const tokens = [
        "admin@pam!api-token",
        "user@pve!deploy-token",
        "service@ldap!automation",
      ];

      for (const token of tokens) {
        const text = `Using token: ${token}`;
        const result = redactor.redact(text);
        expect(result.redactedText).toContain("token-[REDACTED]");
        expect(result.redactedText).not.toContain(token);
      }
    });

    it("should redact multiple tokens", () => {
      const text = "Tokens: user1@pam!token1, user2@pve!token2";
      const result = redactor.redact(text);
      expect(result.redactedText).not.toMatch(/![\w-]+/);
      expect(result.redactions.find((r) => r.pattern === "proxmox_api_token")?.count).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Pattern 3: MAC Addresses", () => {
    it("should preserve MAC addresses with colons", () => {
      const text = "Interface MAC: AA:BB:CC:DD:EE:FF";
      const result = redactor.redact(text);
      expect(result.redactedText).toBe(text);
      expect(result.redactions).toHaveLength(0);
    });

    it("should preserve MAC addresses with hyphens", () => {
      const text = "MAC address: AA-BB-CC-DD-EE-FF";
      const result = redactor.redact(text);
      expect(result.redactedText).toBe(text);
      expect(result.redactions).toHaveLength(0);
    });

    it("should preserve lowercase MAC addresses", () => {
      const text = "MAC: aa:bb:cc:dd:ee:ff";
      const result = redactor.redact(text);
      expect(result.redactedText).toBe(text);
      expect(result.redactions).toHaveLength(0);
    });

    it("should preserve multiple MAC addresses", () => {
      const text = "MACs: 00:11:22:33:44:55, AA:BB:CC:DD:EE:FF";
      const result = redactor.redact(text);
      expect(result.redactedText).toBe(text);
      expect(result.redactions).toHaveLength(0);
    });
  });

  describe("Pattern 4: Internal Node/Storage IPs", () => {
    it("should preserve 10.x.x.x IPs", () => {
      const text = "Storage IP: 10.0.0.1";
      const result = redactor.redact(text);
      expect(result.redactedText).toBe(text);
      expect(result.redactions).toHaveLength(0);
    });

    it("should preserve 192.168.x.x IPs", () => {
      const text = "Corosync network: 192.168.1.100";
      const result = redactor.redact(text);
      expect(result.redactedText).toBe(text);
      expect(result.redactions).toHaveLength(0);
    });

    it("should preserve 172.16-31.x.x IPs", () => {
      const text = "Ceph backend: 172.16.0.10";
      const result = redactor.redact(text);
      expect(result.redactedText).toBe(text);
      expect(result.redactions).toHaveLength(0);
    });

    it("should preserve 169.254.x.x link-local IPs", () => {
      const text = "Link-local: 169.254.1.1";
      const result = redactor.redact(text);
      expect(result.redactedText).toBe(text);
      expect(result.redactions).toHaveLength(0);
    });

    it("should preserve multiple internal IPs", () => {
      const text = "IPs: 10.0.0.1, 192.168.1.1, 172.16.0.1";
      const result = redactor.redact(text);
      expect(result.redactedText).toBe(text);
      expect(result.redactions).toHaveLength(0);
    });
  });

  describe("Pattern 5: Configuration Secrets", () => {
    it("should redact cloud-init passwords", () => {
      const text = 'cloud-init password: "MySecret123!"';
      const result = redactor.redact(text);
      expect(result.redactedText).toContain("[REDACTED_CONFIG_SECRET]");
      expect(result.redactedText).not.toContain("MySecret123!");
      expect(result.redactions.some((r) => r.pattern === "proxmox_config_secrets")).toBe(true);
    });

    it("should redact user-data secrets", () => {
      const text = "user-data secret: super-secret-key-12345";
      const result = redactor.redact(text);
      expect(result.redactedText).toContain("[REDACTED_CONFIG_SECRET]");
      expect(result.redactedText).not.toContain("super-secret-key-12345");
    });

    it("should redact storage.cfg tokens", () => {
      const text = 'storage.cfg token = "abc123xyz789"';
      const result = redactor.redact(text);
      expect(result.redactedText).toContain("[REDACTED_CONFIG_SECRET]");
      expect(result.redactedText).not.toContain("abc123xyz789");
    });

    it("should redact replication config credentials", () => {
      const text = "replication credential: my-secret-credential";
      const result = redactor.redact(text);
      expect(result.redactedText).toContain("[REDACTED_CONFIG_SECRET]");
      expect(result.redactedText).not.toContain("my-secret-credential");
    });

    it("should redact HA resource config keys", () => {
      const text = 'HA resource key: "ha-secret-key-456"';
      const result = redactor.redact(text);
      expect(result.redactedText).toContain("[REDACTED_CONFIG_SECRET]");
      expect(result.redactedText).not.toContain("ha-secret-key-456");
    });
  });

  describe("Integration: All Patterns Together", () => {
    it("should redact secrets and preserve infrastructure identifiers in a single response", () => {
      const text = `
        Node: pve1
        User: admin@pam
        Token: admin@pam!deploy-token
        Interface: eth0 (MAC: AA:BB:CC:DD:EE:FF)
        Storage IP: 10.0.0.1
        Cloud-init password: "Secret123"
      `;

      const result = allRedactor.redact(text);

      // Secrets are redacted.
      expect(result.redactedText).not.toContain("admin@pam!deploy-token");
      expect(result.redactedText).not.toContain("Secret123");

      // User realms, MAC addresses, and IP addresses are diagnostic identifiers.
      expect(result.redactedText).toContain("admin@pam");
      expect(result.redactedText).toContain("AA:BB:CC:DD:EE:FF");
      expect(result.redactedText).toContain("10.0.0.1");
      expect(result.redactedText).toContain("[REDACTED_CONFIG_SECRET]");
      expect(result.redactedText).toContain("[REDACTED_PASSWORD]");
    });
  });

  describe("End-to-End: sanitizeToolPayload Integration", () => {
    it("should redact Proxmox secrets and preserve identifiers in tool payloads", () => {
      const payload = {
        node: "pve1",
        user: "admin@pam",
        token: "admin@pam!deploy",
        interface: {
          name: "eth0",
          mac: "AA:BB:CC:DD:EE:FF",
          ip: "10.0.0.1",
        },
        config: {
          credential: "password: Secret123",
        },
      };

      const sanitized = sanitizeToolPayload(payload);
      const sanitizedStr = JSON.stringify(sanitized);

      // Verify sensitive data is redacted.
      expect(sanitizedStr).not.toContain("admin@pam!deploy");
      expect(sanitizedStr).not.toContain("Secret123");

      // Verify infrastructure identifiers are preserved.
      expect(sanitizedStr).toContain("admin@pam");
      expect(sanitizedStr).toContain("AA:BB:CC:DD:EE:FF");
      expect(sanitizedStr).toContain("10.0.0.1");
      expect(sanitizedStr).toContain("[REDACTED_PASSWORD]");
    });

    it("should redact tokens and preserve identifiers in string payloads", () => {
      const payload = "User admin@pam with token admin@pam!deploy on IP 10.0.0.1";
      const sanitized = sanitizeToolPayload(payload);

      // Token should be redacted; the user realm and IP should remain available.
      expect(sanitized).not.toContain("admin@pam!deploy");
      expect(sanitized).toContain("token-[REDACTED]");
      expect(sanitized).toContain("admin@pam");
      expect(sanitized).toContain("10.0.0.1");
    });

    it("should preserve non-sensitive data", () => {
      const payload = {
        node: "pve1",
        status: "online",
        vmid: 101,
        name: "test-vm",
      };

      const sanitized = sanitizeToolPayload(payload);

      expect(sanitized.node).toBe("pve1");
      expect(sanitized.status).toBe("online");
      expect(sanitized.vmid).toBe(101);
      expect(sanitized.name).toBe("test-vm");
    });
  });

  describe("Real-World Proxmox API Response Examples", () => {
    it("should preserve diagnostic identifiers in node status response", () => {
      const response = {
        node: "pve1",
        status: "online",
        interfaces: [
          {
            iface: "eth0",
            address: "10.0.0.1",
            mac: "AA:BB:CC:DD:EE:FF",
          },
        ],
        users: ["admin@pam", "user@pve"],
      };

      const sanitized = sanitizeToolPayload(response);
      expect(sanitized).toEqual(response);
    });

    it("should preserve MAC addresses and redact labeled secrets in VM config response", () => {
      const response = {
        vmid: 101,
        name: "test-vm",
        net0: "virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0",
        "cloud-init": {
          credential: "password: SecretPassword123",
        },
      };

      const sanitized = sanitizeToolPayload(response);
      const sanitizedStr = JSON.stringify(sanitized);

      expect(sanitizedStr).toContain("AA:BB:CC:DD:EE:FF");
      expect(sanitizedStr).not.toContain("SecretPassword123");
      expect(sanitizedStr).toContain("[REDACTED_PASSWORD]");
    });
  });
});
