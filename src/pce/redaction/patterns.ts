/**
 * Redaction Pipeline - Pattern Definitions
 * Task 2.1: Redaction Pipeline Setup
 */

export interface RedactionPattern {
  name: string;
  pattern: RegExp;
  replacement: string | ((match: string, ...args: any[]) => string);
  description: string;
}

/**
 * Initial regex patterns for sensitive data
 * Common API keys, mock PII, etc.
 */
export const DEFAULT_REDACTION_PATTERNS: RedactionPattern[] = [
  {
    name: "api_key_generic",
    pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"]?([a-zA-Z0-9_\-]{20,})['"]?/gi,
    replacement: "[REDACTED_API_KEY]",
    description: "Generic API key patterns",
  },
  {
    name: "aws_access_key",
    pattern: /AKIA[0-9A-Z]{16}/g,
    replacement: "[REDACTED_AWS_ACCESS_KEY]",
    description: "AWS access key ID",
  },
  {
    name: "aws_secret_key",
    pattern: /aws[_-]?secret[_-]?access[_-]?key\s*[:=]\s*['"]?([a-zA-Z0-9/+=]{40})['"]?/gi,
    replacement: "[REDACTED_AWS_SECRET_KEY]",
    description: "AWS secret access key",
  },
  {
    name: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    replacement: "[REDACTED_EMAIL]",
    description: "Email addresses",
  },
  {
    name: "ip_address_private",
    pattern: /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g,
    replacement: "[REDACTED_IP]",
    description: "Private IP addresses",
  },
  {
    name: "password",
    pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"]?([^\s'"]{8,})['"]?/gi,
    replacement: "[REDACTED_PASSWORD]",
    description: "Password fields",
  },
  {
    name: "jwt_token",
    pattern: /eyJ[A-Za-z0-9-_=]+\.eyJ[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/g,
    replacement: "[REDACTED_JWT]",
    description: "JWT tokens",
  },
  {
    name: "credit_card",
    pattern: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,
    replacement: "[REDACTED_CC]",
    description: "Credit card numbers",
  },
  {
    name: "ssh_private_key",
    pattern: /-----BEGIN\s+(?:RSA|DSA|EC|OPENSSH)\s+PRIVATE KEY-----[\s\S]*?-----END\s+(?:RSA|DSA|EC|OPENSSH)\s+PRIVATE KEY-----/g,
    replacement: "[REDACTED_SSH_KEY]",
    description: "SSH private keys",
  },
];

/**
 * Proxmox-specific redaction patterns
 * TL-2A.4: CRITICAL Redaction Test (Proxmox-Specific)
 */
export const PROXMOX_REDACTION_PATTERNS: RedactionPattern[] = [
  {
    name: "proxmox_api_token",
    // Match tokens FIRST (before user realm redaction) - tokens include user@realm!token
    pattern: /\b[a-zA-Z0-9_\-]+@(?:pam|pve|ldap|ad|openid|oidc|saml)![a-zA-Z0-9_\-]+\b/gi,
    replacement: "token-[REDACTED]",
    description: "Proxmox API token names (myuser!deploy)",
  },
  {
    name: "proxmox_user_realm",
    // Match user realms AFTER tokens (to catch standalone user@realm that aren't tokens)
    pattern: /\b[a-zA-Z0-9_\-]+@(?:pam|pve|ldap|ad|openid|oidc|saml)\b/gi,
    replacement: "user-[REDACTED]",
    description: "Proxmox user realm identifiers (user@pam, root@pve, automation@ldap)",
  },
  {
    name: "proxmox_mac_address",
    pattern: /\b(?:[0-9A-Fa-f]{2}[:-]){5}(?:[0-9A-Fa-f]{2})\b/g,
    replacement: "MAC-[REDACTED]",
    description: "MAC addresses (AA:BB:CC:DD:EE:FF or AA-BB-CC-DD-EE-FF)",
  },
  {
    name: "proxmox_internal_ips",
    pattern: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})\b/g,
    replacement: "IP-[REDACTED]",
    description: "Internal Proxmox/Storage IPs (Storage VLANs, Ceph backends, corosync networks)",
  },
  {
    name: "proxmox_config_secrets",
    // Match secrets in various formats:
    // - JSON: "password":"value" or "password": "value"
    // - Text: password: value or password=value
    // - Config files: storage.cfg token = "value" or HA resource key: "value"
    // Exclude API tokens (user@realm!token format) - those are handled by proxmox_api_token pattern
    // Use negative lookahead to exclude API token format from the value
    // Use replacement function to preserve key and quotes, only redact value
    pattern: /((?:["']?(?:cloud-init|user-data|password|secret|credential)["']?|storage\.cfg\s+token|ha\s+resource\s+key|(?<![a-zA-Z0-9_])(?:token|key)(?![a-zA-Z0-9_]))\s*[:=]\s*["']?)((?!.*@(?:pam|pve|ldap|ad|openid|oidc|saml)![a-zA-Z0-9_\-]+).{8,})(["']?)/gim,
    replacement: (match: string, keyPart: string, value: string, quote: string, ...args: any[]) => {
      // Double-check: Skip if this looks like an API token (contains @ and ! in the value)
      // API tokens are handled by proxmox_api_token pattern which runs first
      // Check for the pattern: user@realm!token
      // The value parameter should be the second captured group
      const actualValue = (value !== undefined && value !== null) ? String(value) : match;
      // Check if the value matches the API token pattern
      const apiTokenPattern = /[a-zA-Z0-9_\-]+@(?:pam|pve|ldap|ad|openid|oidc|saml)![a-zA-Z0-9_\-]+/;
      if (actualValue && apiTokenPattern.test(actualValue)) {
        // Don't redact - return original match so API token pattern can handle it
        return match;
      }
      // keyPart already includes the key, colon/equals, and opening quote
      // We just need to replace the value and keep the closing quote
      return `${keyPart}[REDACTED_CONFIG_SECRET]${quote || ""}`;
    },
    description: "Configuration secrets in cloud-init templates, storage.cfg, replication configs, HA resource configs",
  },
];

/**
 * Combined redaction patterns including Proxmox-specific patterns
 * Proxmox patterns are added first to take precedence over generic patterns
 */
export const ALL_REDACTION_PATTERNS: RedactionPattern[] = [
  ...PROXMOX_REDACTION_PATTERNS,
  ...DEFAULT_REDACTION_PATTERNS.filter(
    // Exclude default private IP pattern since Proxmox pattern covers it
    (p) => p.name !== "ip_address_private"
  ),
];

