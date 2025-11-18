import { describe, it, expect } from "vitest";
import { Redactor } from "../../../../src/pce/redaction/redactor";
import { PROXMOX_REDACTION_PATTERNS, ALL_REDACTION_PATTERNS } from "../../../../src/pce/redaction/patterns";
import { sanitizeToolPayload } from "../../../../src/agent/tool-sanitizer";

describe("TL-2A.4: CRITICAL Redaction Test (Proxmox-Specific)", () => {
  const redactor = new Redactor(PROXMOX_REDACTION_PATTERNS);
  const allRedactor = new Redactor(ALL_REDACTION_PATTERNS);

  describe("Pattern 1: User Realm Identifiers", () => {
    it("should redact user@pam identifiers", () => {
      const text = "User: root@pam logged in";
      const result = redactor.redact(text);
      expect(result.redactedText).toContain("user-[REDACTED]");
      expect(result.redactedText).not.toContain("root@pam");
      expect(result.redactions.some((r) => r.pattern === "proxmox_user_realm")).toBe(true);
    });

    it("should redact root@pve identifiers", () => {
      const text = "Node managed by root@pve";
      const result = redactor.redact(text);
      expect(result.redactedText).toContain("user-[REDACTED]");
      expect(result.redactedText).not.toContain("root@pve");
    });

    it("should redact automation@ldap identifiers", () => {
      const text = "Service account: automation@ldap";
      const result = redactor.redact(text);
      expect(result.redactedText).toContain("user-[REDACTED]");
      expect(result.redactedText).not.toContain("automation@ldap");
    });

    it("should redact multiple user realm identifiers", () => {
      const text = "Users: admin@pam, user@pve, service@ldap";
      const result = redactor.redact(text);
      expect(result.redactedText).not.toMatch(/@(?:pam|pve|ldap)/);
      expect(result.redactions.find((r) => r.pattern === "proxmox_user_realm")?.count).toBeGreaterThanOrEqual(3);
    });

    it("should handle various realm types", () => {
      const realms = ["pam", "pve", "ldap", "ad", "openid", "oidc", "saml"];
      for (const realm of realms) {
        const text = `user@${realm}`;
        const result = redactor.redact(text);
        expect(result.redactedText).toContain("user-[REDACTED]");
        expect(result.redactedText).not.toContain(`@${realm}`);
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
    it("should redact MAC addresses with colons", () => {
      const text = "Interface MAC: AA:BB:CC:DD:EE:FF";
      const result = redactor.redact(text);
      expect(result.redactedText).toContain("MAC-[REDACTED]");
      expect(result.redactedText).not.toContain("AA:BB:CC:DD:EE:FF");
      expect(result.redactions.some((r) => r.pattern === "proxmox_mac_address")).toBe(true);
    });

    it("should redact MAC addresses with hyphens", () => {
      const text = "MAC address: AA-BB-CC-DD-EE-FF";
      const result = redactor.redact(text);
      expect(result.redactedText).toContain("MAC-[REDACTED]");
      expect(result.redactedText).not.toContain("AA-BB-CC-DD-EE-FF");
    });

    it("should redact lowercase MAC addresses", () => {
      const text = "MAC: aa:bb:cc:dd:ee:ff";
      const result = redactor.redact(text);
      expect(result.redactedText).toContain("MAC-[REDACTED]");
      expect(result.redactedText).not.toContain("aa:bb:cc:dd:ee:ff");
    });

    it("should redact multiple MAC addresses", () => {
      const text = "MACs: 00:11:22:33:44:55, AA:BB:CC:DD:EE:FF";
      const result = redactor.redact(text);
      expect(result.redactedText).not.toMatch(/(?:[0-9A-Fa-f]{2}[:-]){5}(?:[0-9A-Fa-f]{2})/);
      expect(result.redactions.find((r) => r.pattern === "proxmox_mac_address")?.count).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Pattern 4: Internal Node/Storage IPs", () => {
    it("should redact 10.x.x.x IPs", () => {
      const text = "Storage IP: 10.0.0.1";
      const result = redactor.redact(text);
      expect(result.redactedText).toContain("IP-[REDACTED]");
      expect(result.redactedText).not.toContain("10.0.0.1");
      expect(result.redactions.some((r) => r.pattern === "proxmox_internal_ips")).toBe(true);
    });

    it("should redact 192.168.x.x IPs", () => {
      const text = "Corosync network: 192.168.1.100";
      const result = redactor.redact(text);
      expect(result.redactedText).toContain("IP-[REDACTED]");
      expect(result.redactedText).not.toContain("192.168.1.100");
    });

    it("should redact 172.16-31.x.x IPs", () => {
      const text = "Ceph backend: 172.16.0.10";
      const result = redactor.redact(text);
      expect(result.redactedText).toContain("IP-[REDACTED]");
      expect(result.redactedText).not.toContain("172.16.0.10");
    });

    it("should redact 169.254.x.x link-local IPs", () => {
      const text = "Link-local: 169.254.1.1";
      const result = redactor.redact(text);
      expect(result.redactedText).toContain("IP-[REDACTED]");
      expect(result.redactedText).not.toContain("169.254.1.1");
    });

    it("should redact multiple internal IPs", () => {
      const text = "IPs: 10.0.0.1, 192.168.1.1, 172.16.0.1";
      const result = redactor.redact(text);
      expect(result.redactedText).not.toMatch(/\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01])|169\.254)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
      expect(result.redactions.find((r) => r.pattern === "proxmox_internal_ips")?.count).toBeGreaterThanOrEqual(3);
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
    it("should redact all Proxmox-specific patterns in a single response", () => {
      const text = `
        Node: pve1
        User: admin@pam
        Token: admin@pam!deploy-token
        Interface: eth0 (MAC: AA:BB:CC:DD:EE:FF)
        Storage IP: 10.0.0.1
        Cloud-init password: "Secret123"
      `;

      const result = allRedactor.redact(text);

      // Verify all patterns are redacted
      expect(result.redactedText).not.toContain("admin@pam!deploy-token");
      expect(result.redactedText).not.toContain("AA:BB:CC:DD:EE:FF");
      expect(result.redactedText).not.toContain("10.0.0.1");
      expect(result.redactedText).not.toContain("Secret123");

      // Verify replacements are present
      // Note: admin@pam might be redacted as user-[REDACTED] OR as part of token-[REDACTED]
      // depending on pattern order, so we check for at least one
      expect(
        result.redactedText.includes("user-[REDACTED]") ||
        result.redactedText.includes("token-[REDACTED]")
      ).toBe(true);
      expect(result.redactedText).toContain("token-[REDACTED]");
      expect(result.redactedText).toContain("MAC-[REDACTED]");
      expect(result.redactedText).toContain("IP-[REDACTED]");
      expect(result.redactedText).toContain("[REDACTED_CONFIG_SECRET]");
    });
  });

  describe("End-to-End: sanitizeToolPayload Integration", () => {
    it("should redact Proxmox data in tool payloads", () => {
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
          password: "Secret123",
        },
      };

      const sanitized = sanitizeToolPayload(payload);
      const sanitizedStr = JSON.stringify(sanitized);

      // Verify sensitive data is redacted
      expect(sanitizedStr).not.toContain("admin@pam!deploy");
      expect(sanitizedStr).not.toContain("AA:BB:CC:DD:EE:FF");
      expect(sanitizedStr).not.toContain("10.0.0.1");
      expect(sanitizedStr).not.toContain("Secret123");
      
      // Verify redactions are present
      expect(
        sanitizedStr.includes("user-[REDACTED]") ||
        sanitizedStr.includes("token-[REDACTED]")
      ).toBe(true);
      expect(sanitizedStr).toContain("MAC-[REDACTED]");
      expect(sanitizedStr).toContain("IP-[REDACTED]");
      expect(sanitizedStr).toContain("[REDACTED_CONFIG_SECRET]");
    });

    it("should redact Proxmox data in string payloads", () => {
      const payload = "User admin@pam with token admin@pam!deploy on IP 10.0.0.1";
      const sanitized = sanitizeToolPayload(payload);

      // Token should be redacted
      expect(sanitized).not.toContain("admin@pam!deploy");
      // IP should be redacted
      expect(sanitized).not.toContain("10.0.0.1");
      // Verify redactions present
      expect(sanitized).toContain("token-[REDACTED]");
      expect(sanitized).toContain("IP-[REDACTED]");
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
    it("should redact sensitive data in node status response", () => {
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
      const sanitizedStr = JSON.stringify(sanitized);

      expect(sanitizedStr).not.toContain("10.0.0.1");
      expect(sanitizedStr).not.toContain("AA:BB:CC:DD:EE:FF");
      expect(sanitizedStr).not.toContain("admin@pam");
      expect(sanitizedStr).not.toContain("user@pve");
      
      // Verify redactions are present
      expect(sanitizedStr).toContain("IP-[REDACTED]");
      expect(sanitizedStr).toContain("MAC-[REDACTED]");
      expect(sanitizedStr).toContain("user-[REDACTED]");
    });

    it("should redact sensitive data in VM config response", () => {
      const response = {
        vmid: 101,
        name: "test-vm",
        net0: "virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0",
        "cloud-init": {
          password: "SecretPassword123",
        },
      };

      const sanitized = sanitizeToolPayload(response);
      const sanitizedStr = JSON.stringify(sanitized);

      expect(sanitizedStr).not.toContain("AA:BB:CC:DD:EE:FF");
      expect(sanitizedStr).not.toContain("SecretPassword123");
      
      // Verify redactions are present
      expect(sanitizedStr).toContain("MAC-[REDACTED]");
      expect(sanitizedStr).toContain("[REDACTED_CONFIG_SECRET]");
    });
  });
});

