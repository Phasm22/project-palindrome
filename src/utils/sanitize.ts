/**
 * Sanitizes data before sending to OpenAI to prevent sensitive information leakage
 */

export function sanitizeForLLM(data: any): any {
  if (typeof data === "string") {
    return sanitizeString(data);
  }
  
  if (typeof data === "object" && data !== null) {
    if (Array.isArray(data)) {
      return data.map(item => sanitizeForLLM(item));
    }
    
    const sanitized: any = {};
    for (const [key, value] of Object.entries(data)) {
      // Skip sensitive keys
      if (isSensitiveKey(key)) {
        sanitized[key] = "[REDACTED]";
        continue;
      }
      
      sanitized[key] = sanitizeForLLM(value);
    }
    return sanitized;
  }
  
  return data;
}

function isSensitiveKey(key: string): boolean {
  const sensitivePatterns = [
    /password/i,
    /secret/i,
    /key/i,
    /token/i,
    /credential/i,
    /auth/i,
    /private/i,
    /api[_-]?key/i,
    /api[_-]?secret/i,
  ];
  
  return sensitivePatterns.some(pattern => pattern.test(key));
}

function sanitizeString(str: string): string {
  // Remove potential API keys, tokens, passwords from strings
  // Pattern: long alphanumeric strings that might be keys
  let sanitized = str;
  
  // Remove potential API keys (long hex/base64-like strings)
  sanitized = sanitized.replace(/\b[a-fA-F0-9]{32,}\b/g, "[API_KEY_REDACTED]");
  
  // Remove potential tokens (base64-like strings)
  sanitized = sanitized.replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, (match) => {
    // Don't redact if it looks like a normal path or filename
    if (match.includes('/') || match.includes('\\')) {
      return match;
    }
    return "[TOKEN_REDACTED]";
  });
  
  // Remove email addresses (might contain sensitive info)
  // Actually, let's keep emails but be careful - they might be in logs
  
  // Remove full file paths that might contain usernames
  sanitized = sanitized.replace(/\/home\/[^\/\s]+\//g, "/home/[USER]/");
  sanitized = sanitized.replace(/\/Users\/[^\/\s]+\//g, "/Users/[USER]/");
  
  return sanitized;
}

/**
 * Sanitizes tool results before adding to context
 */
export function sanitizeToolResult(toolName: string, data: any): any {
  // For SSH results, be extra careful with stdout/stderr
  if (toolName === "ssh_execute" && data && typeof data === "object") {
    const sanitized = { ...data };
    
    // Sanitize stdout and stderr
    if (sanitized.stdout) {
      sanitized.stdout = sanitizeString(String(sanitized.stdout));
    }
    if (sanitized.stderr) {
      sanitized.stderr = sanitizeString(String(sanitized.stderr));
    }
    
    return sanitized;
  }
  
  // For OPNsense results, sanitize any sensitive fields
  if (toolName === "opnsense_manage" && data && typeof data === "object") {
    return sanitizeForLLM(data);
  }
  
  // Default sanitization
  return sanitizeForLLM(data);
}

