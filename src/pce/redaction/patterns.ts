/**
 * Redaction Pipeline - Pattern Definitions
 * Task 2.1: Redaction Pipeline Setup
 */

export interface RedactionPattern {
  name: string;
  pattern: RegExp;
  replacement: string;
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

