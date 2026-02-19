import axios from "axios";
import type { AxiosInstance } from "axios";
import https from "https";
import { pceLogger as logger } from "../../pce/utils/logger";

export interface PiholeApiConfig {
  url: string; // Pi-hole admin URL (e.g., https://172.16.0.13)
  apiKey?: string; // Legacy API: pwhash (webserver.api.pwhash) for /admin/api.php
  webPassword?: string; // REST API: Web interface password for /api/* endpoints (v6+)
  verifySsl?: boolean;
}

export interface DnsRecord {
  domain: string;
  ip: string;
}

export interface PiholeApiResponse<T = any> {
  success: boolean;
  data?: T;
  message?: string;
}

/**
 * Pi-hole REST API Client
 * 
 * Provides API key authentication and DNS record management.
 * Follows the same pattern as ProxmoxClient for consistency.
 */
// Singleton instance to prevent multiple sessions
let sharedPiholeClient: PiholeClient | null = null;

/**
 * Get or create a shared PiholeClient instance
 * This ensures all operations use the same session, preventing "API seats exceeded" errors
 */
export function getPiholeClient(config?: PiholeApiConfig): PiholeClient {
  if (!sharedPiholeClient) {
    if (!config) {
      // Create from environment variables if no config provided
      const piholeUrl = process.env.PIHOLE_URL || "https://piholelab.prox";
      let cleanUrl = piholeUrl.replace(/\/admin\/?$/, "");
      if (!cleanUrl.startsWith("http://") && !cleanUrl.startsWith("https://")) {
        cleanUrl = `https://${cleanUrl}`; // Default to HTTPS
      }

      config = {
        url: cleanUrl,
        webPassword: process.env.PIHOLE_WEB_PWD || undefined,
        apiKey: process.env.PIHOLE_WEB_PWD ? undefined : process.env.PIHOLE_API_KEY,
        verifySsl: process.env.PIHOLE_VERIFY_SSL === "true",
      };
    }
    sharedPiholeClient = new PiholeClient(config);
  }
  return sharedPiholeClient;
}

export class PiholeClient {
  private apiClient: AxiosInstance | null = null;
  private config: PiholeApiConfig;
  private sessionCookie: string | null = null;
  private csrfToken: string | null = null;
  private loginPromise: Promise<string> | null = null; // Prevent concurrent logins

  constructor(config: PiholeApiConfig) {
    this.config = {
      verifySsl: false, // Pi-hole typically uses HTTP or self-signed HTTPS
      ...config,
    };

    if (!this.config.url) {
      throw new Error("PIHOLE_URL must be set");
    }

    // For REST API (v6+), we need webPassword
    // For legacy API, we need apiKey (pwhash)
    // At least one must be provided
    if (!this.config.webPassword && !this.config.apiKey) {
      throw new Error("Either PIHOLE_WEB_PWD (for REST API v6+) or PIHOLE_API_KEY (for legacy API) must be set");
    }
  }

  /**
   * Login to Pi-hole and get session cookie
   * Pi-hole v6+ uses session-based authentication
   */
  private async login(): Promise<string> {
    // If we already have a valid session, return it
    if (this.sessionCookie && this.csrfToken) {
      return this.sessionCookie;
    }

    // If a login is already in progress, wait for it instead of creating a new one
    if (this.loginPromise) {
      return this.loginPromise;
    }

    // Create login promise to prevent concurrent logins
    const loginPromise: Promise<string> = (async () => {
      try {
        const webPassword = this.config.webPassword?.replace(/^["']|["']$/g, "") || this.config.apiKey?.replace(/^["']|["']$/g, "");
        if (!webPassword) {
          throw new Error("PIHOLE_WEB_PWD must be set for Pi-hole v6+ REST API");
        }

        // Normalize URL
        let baseURL = this.config.url;
        baseURL = baseURL.replace(/\/admin\/?$/, "");
        baseURL = baseURL.replace(/\/$/, "");

        // Create HTTPS agent with SSL verification disabled by default (Pi-hole often uses self-signed certs)
        const httpsAgent = new https.Agent({
          rejectUnauthorized: this.config.verifySsl === true, // Only verify if explicitly enabled
        });

        // Create temporary client for login
        const loginClient = axios.create({
          baseURL,
          httpsAgent,
          timeout: 30000,
          withCredentials: true, // Important: enables cookie handling
        });

        // Login endpoint - Pi-hole v6+ uses POST /api/auth with password only
        const response = await loginClient.post("/api/auth", {
          password: webPassword,
        }, {
          headers: {
            "Content-Type": "application/json",
          },
        });

        // Pi-hole v6+ returns session info in response body AND Set-Cookie header
        // Response body: {"session":{"valid":true,"sid":"...","csrf":"...","validity":1800}}
        // Set-Cookie header: sid=...; SameSite=Lax; Path=/; Max-Age=1800; HttpOnly
        
        // Extract sid and csrf from response body (most reliable)
        if (response.data?.session?.sid) {
          const sid = response.data.session.sid as string;
          this.sessionCookie = sid;
          this.csrfToken = response.data.session.csrf || null;
          logger.info("Pi-hole session authenticated (from response body)", {
            sessionId: sid.substring(0, 10) + "...",
            csrfToken: this.csrfToken ? this.csrfToken.substring(0, 10) + "..." : "none",
            valid: response.data.session.valid,
            validity: response.data.session.validity,
          });
          return sid;
        }

        // Fallback: Extract session cookie from Set-Cookie header
        const setCookieHeader = response.headers["set-cookie"];
        let cookieString: string | undefined;
        
        if (Array.isArray(setCookieHeader)) {
          cookieString = setCookieHeader.find(c => c.includes("sid="));
        } else if (setCookieHeader) {
          cookieString = setCookieHeader;
        }
        
        if (cookieString) {
          // Extract just the sid value (format: sid=value; Path=/; ...)
          const sidMatch = cookieString.match(/sid=([^;]+)/);
          if (sidMatch) {
            const sid = sidMatch[1];
            if (!sid) {
              throw new Error("Failed to extract sid value from Set-Cookie header");
            }
            this.sessionCookie = sid;
            logger.warn("Pi-hole session authenticated (from Set-Cookie header, CSRF token not available)", {
              sessionId: sid.substring(0, 10) + "...",
              note: "CSRF token not available from header, API calls may fail. Check response body for csrf token.",
            });
            return sid;
          }
        }

        // Log what we received for debugging
        logger.error("Failed to extract session cookie", {
          setCookieHeader,
          responseHeaders: Object.keys(response.headers),
          status: response.status,
        });
        throw new Error("Failed to extract session cookie from login response");
      } catch (error: any) {
        logger.error("Pi-hole login failed", {
          error: error.message,
          status: error.response?.status,
          data: error.response?.data,
        });
        throw new Error(`Pi-hole login failed: ${error.message}`);
      } finally {
        // Clear login promise after completion (success or failure) so we can retry if needed
        this.loginPromise = null;
      }
    })();
    this.loginPromise = loginPromise;

    return loginPromise;
  }

  /**
   * Get or create authenticated axios instance
   */
  private async getApiClient(): Promise<AxiosInstance> {
    // If we already have a client and session, return it
    if (this.apiClient && this.sessionCookie && this.csrfToken) {
      return this.apiClient;
    }

    // Login first to get session cookie
    await this.login();

    // Normalize URL - Pi-hole v6.3+ API endpoint is at /api (not /admin/api.php)
    // Base URL should be the root URL, API endpoint is /api
    let baseURL = this.config.url;
    // Remove /admin suffix if present (v6.3+ uses /api, not /admin/api.php)
    baseURL = baseURL.replace(/\/admin\/?$/, "");
    // Remove trailing slash
    baseURL = baseURL.replace(/\/$/, "");

    // Create HTTPS agent with SSL verification disabled by default (Pi-hole often uses self-signed certs)
    const httpsAgent = new https.Agent({
      rejectUnauthorized: this.config.verifySsl === true, // Only verify if explicitly enabled
    });

    logger.info("Pi-hole API client initialized", {
      url: baseURL,
      authMethod: "Session-based (cookie)",
      sessionId: this.sessionCookie ? this.sessionCookie.substring(0, 10) + "..." : "none",
      fullEndpoint: `${baseURL}/api/config/dns/hosts`,
      note: "Pi-hole v6+ REST API uses session cookies from /api/auth login",
    });

    // Create axios client with cookie support
    // Use axios-cookiejar-support or manual cookie header
    // Pi-hole expects: Cookie: sid=<session-id>
    this.apiClient = axios.create({
      baseURL,
      httpsAgent,
      timeout: 30000, // 30 second timeout
      withCredentials: true, // Enable cookie handling
    });

    // Add request interceptor to include session cookie and CSRF token in all requests
    this.apiClient.interceptors.request.use((config) => {
      if (this.sessionCookie) {
        // Ensure Cookie header is set (may need to use lowercase 'cookie' for some axios versions)
        config.headers = config.headers || {};
        config.headers.Cookie = `sid=${this.sessionCookie}`;
        config.headers.cookie = `sid=${this.sessionCookie}`; // Also set lowercase for compatibility
        
        // Pi-hole v6+ requires CSRF token for config endpoints
        if (this.csrfToken) {
          config.headers["X-CSRF-Token"] = this.csrfToken;
        }
        
        logger.debug("Added session cookie and CSRF token to request", {
          url: config.url,
          cookie: `sid=${this.sessionCookie.substring(0, 10)}...`,
          hasCsrf: !!this.csrfToken,
        });
      }
      return config;
    });

    // Add request interceptor for logging
    this.apiClient.interceptors.request.use(
      (config) => {
        logger.debug("Pi-hole API request", {
          method: config.method?.toUpperCase(),
          url: config.url,
          baseURL: config.baseURL,
        });
        return config;
      },
      (error) => {
        logger.error("Pi-hole API request error", { error: error.message });
        return Promise.reject(error);
      }
    );

    // Add response interceptor for logging
    this.apiClient.interceptors.response.use(
      (response) => {
        logger.debug("Pi-hole API response", {
          status: response.status,
          url: response.config.url,
        });
        return response;
      },
      (error) => {
        const errorDetails: any = {
          status: error.response?.status,
          message: error.message,
          url: error.config?.url,
          baseURL: error.config?.baseURL,
        };
        
        // Add helpful diagnostics for connection errors
        if (error.code === "ECONNREFUSED" || error.message.includes("ECONNREFUSED")) {
          errorDetails.diagnostic = `Connection refused to Pi-hole API. Check:
1. PIHOLE_URL is set correctly (current: ${this.config.url})
2. Pi-hole is accessible at the configured URL
3. Try using IP address instead of hostname (e.g., http://172.16.0.13)
4. Check if Pi-hole admin interface is accessible in browser`;
        } else if (error.code === "ENOTFOUND" || error.message.includes("ENOTFOUND")) {
          errorDetails.diagnostic = `Hostname not found. Check:
1. PIHOLE_URL hostname is correct (current: ${this.config.url})
2. DNS resolution works for the hostname
3. Try using IP address instead (e.g., http://172.16.0.13)`;
        } else if (error.response?.status === 401 || error.response?.data?.error?.key === "unauthorized") {
          errorDetails.diagnostic = `Authentication failed (401 Unauthorized). Check:
1. Session cookie was obtained from login: ${this.sessionCookie ? "Yes" : "No"}
2. Session cookie is being sent in requests: Check Cookie header in request
3. Session may have expired (Pi-hole sessions last 30 minutes)
4. Try logging in again to get a fresh session cookie`;
          errorDetails.authMethod = "Session-based (cookie)";
          errorDetails.sessionCookie = this.sessionCookie ? this.sessionCookie.substring(0, 10) + "..." : "none";
          errorDetails.requestHeaders = error.config?.headers;
        }
        
        logger.error("Pi-hole API response error", errorDetails);
        return Promise.reject(error);
      }
    );

    return this.apiClient;
  }

  /**
   * List all custom DNS records
   * Pi-hole v6+ uses REST API: GET /api/config/dns/hosts
   */
  async listDnsRecords(): Promise<DnsRecord[]> {
    try {
      const response = await (await this.getApiClient()).get("/api/config/dns/hosts");

      // Pi-hole v6+ returns data in format:
      // { "config": { "dns": { "hosts": ["IP domain", "IP domain", ...] } } }
      // Each entry is a space-separated string: "172.16.0.49 dad.prox"
      const hosts = response.data?.config?.dns?.hosts || [];
      
      if (!Array.isArray(hosts)) {
        logger.warn("Unexpected DNS hosts format", { data: response.data });
        return [];
      }

      // Parse space-separated strings: "IP domain" -> {ip: "IP", domain: "domain"}
      const records: DnsRecord[] = [];
      for (const entry of hosts) {
        if (typeof entry === "string") {
          // Format: "172.16.0.49 dad.prox" (IP and domain separated by space)
          const parts = entry.trim().split(/\s+/);
          if (parts.length >= 2) {
            records.push({
              ip: parts[0] ?? "",
              domain: parts.slice(1).join(" "), // Join in case domain has spaces (unlikely but safe)
            });
          } else if (parts.length === 1 && parts[0]) {
            // Handle edge case: just IP or just domain
            logger.debug("Skipping malformed DNS entry", { entry });
          }
        } else if (typeof entry === "object" && entry !== null) {
          // Fallback: handle object format if it exists
          if ("ip" in entry || "domain" in entry) {
            records.push({
              ip: (entry as any).ip || "",
              domain: (entry as any).domain || "",
            });
          }
        }
      }
      
      return records;
    } catch (error: any) {
      logger.error("Failed to list DNS records", { 
        error: error.message,
        status: error.response?.status,
        data: error.response?.data,
      });
      throw new Error(`Failed to list DNS records: ${error.message}`);
    }
  }

  /**
   * Create a DNS A record
   * @param domain - Hostname (e.g., "web-server" or "web-server.prox")
   * @param ip - IP address (e.g., "172.16.50.100")
   */
  async createDnsRecord(domain: string, ip: string): Promise<void> {
    try {
      // Validate IP address format
      if (!this.isValidIp(ip)) {
        throw new Error(`Invalid IP address: ${ip}`);
      }

      // Check if record already exists
      const existingRecords = await this.listDnsRecords();
      const existing = existingRecords.find(
        (r) => r.domain === domain && r.ip === ip
      );

      if (existing) {
        logger.info("DNS record already exists", { domain, ip });
        return; // Already exists, no error
      }

      // Check for conflicting domain with different IP - update it instead of erroring
      const conflicting = existingRecords.find(
        (r) => r.domain.toLowerCase() === domain.toLowerCase() && r.ip !== ip
      );
      if (conflicting) {
        logger.info("DNS record exists with different IP, updating", {
          domain,
          oldIp: conflicting.ip,
          newIp: ip,
        });
        // Delete the old record first
        await this.deleteDnsRecord(conflicting.domain, conflicting.ip);
        // Then create the new one (will fall through to creation below)
      }

      // Create the DNS record using Pi-hole v6+ REST API
      // PUT /api/config/dns/hosts/{ip}%20{domain}
      // Format: IP and domain are URL-encoded in the path, separated by a space (%20)
      const encodedDomain = encodeURIComponent(domain);
      const encodedIp = encodeURIComponent(ip);
      const url = `/api/config/dns/hosts/${encodedIp}%20${encodedDomain}`;
      
      const response = await (await this.getApiClient()).put(url);

      // Pi-hole returns success status
      // Check for "already exists" message - this is not an error, it's idempotent
      const responseMessage = response.data?.message || "";
      if (responseMessage.includes("already has a custom DNS entry")) {
        // Check if the existing record has the same IP
        const existingRecords = await this.listDnsRecords();
        const existing = existingRecords.find((r) => r.domain === domain);
        if (existing && existing.ip === ip) {
          logger.info("DNS record already exists with same IP", { domain, ip });
          return; // Already exists with correct IP, no error
        } else if (existing && existing.ip !== ip) {
          // Different IP - this is a conflict that needs to be handled by caller
          throw new Error(
            `DNS record for domain "${domain}" already exists with IP ${existing.ip}. Delete it first or use a different domain.`
          );
        } else {
          // Record exists but we can't verify IP - treat as success (idempotent)
          logger.info("DNS record already exists (could not verify IP)", { domain, ip });
          return;
        }
      }

      if (response.data?.success !== true && response.data?.success !== undefined) {
        throw new Error(
          response.data?.message || "Failed to create DNS record"
        );
      }

      logger.info("DNS record created successfully", { domain, ip });
    } catch (error: any) {
      logger.error("Failed to create DNS record", {
        domain,
        ip,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Delete a DNS record
   * @param domain - Hostname to delete
   * @param ip - IP address (optional, for disambiguation)
   */
  async deleteDnsRecord(domain: string, ip?: string): Promise<void> {
    try {
      const existingRecords = await this.listDnsRecords();
      // Use case-insensitive matching for domain
      const toDelete = ip
        ? existingRecords.find((r) => r.domain.toLowerCase() === domain.toLowerCase() && r.ip === ip)
        : existingRecords.find((r) => r.domain.toLowerCase() === domain.toLowerCase());

      if (!toDelete) {
        logger.warn("DNS record not found for deletion", { 
          domain, 
          ip,
          searchedRecords: existingRecords.map(r => ({ domain: r.domain, ip: r.ip })).slice(0, 5), // Log first 5 for debugging
        });
        return; // Not found, but don't error (idempotent)
      }

      // Delete the DNS record using Pi-hole v6+ REST API
      // DELETE /api/config/dns/hosts/{ip}%20{domain}
      // Format: IP and domain are URL-encoded in the path, separated by a space (%20)
      const encodedDomain = encodeURIComponent(toDelete.domain);
      const encodedIp = encodeURIComponent(toDelete.ip);
      const url = `/api/config/dns/hosts/${encodedIp}%20${encodedDomain}`;
      
      const response = await (await this.getApiClient()).delete(url);

      // Pi-hole API returns success=true on successful deletion
      // Some versions may return success=undefined for success, so check both
      const isSuccess = response.data?.success === true || 
                       (response.data?.success === undefined && !response.data?.message);
      
      if (!isSuccess) {
        const errorMsg = response.data?.message || "Failed to delete DNS record";
        logger.error("Pi-hole API deletion failed", {
          domain: toDelete.domain,
          ip: toDelete.ip,
          response: response.data,
        });
        throw new Error(errorMsg);
      }

      logger.info("DNS record deleted successfully", {
        domain: toDelete.domain,
        ip: toDelete.ip,
        response: response.data,
      });
    } catch (error: any) {
      logger.error("Failed to delete DNS record", {
        domain,
        ip,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get Pi-hole statistics
   */
  async getStatistics(): Promise<any> {
    try {
      const response = await (await this.getApiClient()).get("/api", {
        params: {
          summary: "",
        },
      });
      return response.data;
    } catch (error: any) {
      logger.error("Failed to get Pi-hole statistics", { error: error.message });
      throw new Error(`Failed to get statistics: ${error.message}`);
    }
  }

  /**
   * Validate IP address format (IPv4)
   */
  private isValidIp(ip: string): boolean {
    const ipv4Regex =
      /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    return ipv4Regex.test(ip);
  }
}
