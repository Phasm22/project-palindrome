import { z } from "zod";
import { PiholeClient } from "../../tools/pihole/client";
import { pceLogger as logger } from "../../pce/utils/logger";

/**
 * Create DNS Record Action Schema
 */
export const CreateDnsRecordSchema = z.object({
  hostname: z.string().min(1, "Hostname is required"),
  ip: z.string().min(1, "IP address is required"),
  domain: z.string().optional().default(".prox"), // Default domain suffix
  dryRun: z.boolean().default(false),
});

export type CreateDnsRecordParams = z.infer<typeof CreateDnsRecordSchema>;

export interface CreateDnsRecordResult {
  success: boolean;
  message: string;
  record?: {
    domain: string;
    ip: string;
  };
}

/**
 * Create DNS Record Action
 * 
 * Creates a DNS A record in Pi-hole for the specified hostname and IP.
 */
export async function createDnsRecord(
  params: CreateDnsRecordParams
): Promise<CreateDnsRecordResult> {
  const { hostname, ip, domain = ".prox", dryRun } = params;

  logger.info("Creating DNS record", { hostname, ip, domain, dryRun });

  // Validate environment variables
  // Pi-hole v6+ REST API uses web password, legacy API uses pwhash
  const webPassword = process.env.PIHOLE_WEB_PWD;
  const apiKey = process.env.PIHOLE_API_KEY; // Legacy API fallback
  if (!webPassword && !apiKey) {
    return {
      success: false,
      message:
        "PIHOLE_WEB_PWD (for REST API v6+) or PIHOLE_API_KEY (for legacy API) environment variable is required for DNS operations.",
    };
  }

  // Pi-hole server URL (default to piholelab.prox, fallback to IP)
  // User specified: 172.16.0.13 or piholelab.prox
  // Note: Pi-hole v6.3+ may require HTTPS
  const piholeUrl =
    process.env.PIHOLE_URL || "http://piholelab.prox";
  
  logger.debug("Pi-hole URL configuration", {
    piholeUrl,
    envVar: process.env.PIHOLE_URL || "not set (using default)",
  });
  
  // Ensure URL doesn't have /admin suffix (v6.3+ uses /api, not /admin/api.php)
  // If URL is just an IP or hostname, try HTTPS first (Pi-hole v6.3+ often uses HTTPS)
  let cleanUrl = piholeUrl.replace(/\/admin\/?$/, "");
  if (!cleanUrl.startsWith("http://") && !cleanUrl.startsWith("https://")) {
    // Default to HTTPS for Pi-hole (v6.3+ typically uses HTTPS)
    cleanUrl = `https://${cleanUrl}`;
  }
  
  logger.debug("Pi-hole cleaned URL", { cleanUrl });

  // Construct full domain name
  // If hostname already includes domain, use it as-is
  // Otherwise, append the domain suffix
  let fullDomain = hostname;
  if (!hostname.includes(".")) {
    // Remove leading dot from domain if present
    const domainSuffix = domain.startsWith(".") ? domain : `.${domain}`;
    fullDomain = `${hostname}${domainSuffix}`;
  }

  // Validate IP address format
  const ipv4Regex =
    /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  if (!ipv4Regex.test(ip)) {
    return {
      success: false,
      message: `Invalid IP address format: ${ip}. Expected IPv4 address (e.g., 172.16.50.100).`,
    };
  }

  // Dry-run check
  if (dryRun) {
    return {
      success: true,
      message: `Dry-run successful. Would create DNS record: ${fullDomain} → ${ip}`,
    };
  }

  // Create Pi-hole client and add DNS record
  try {
    const { getPiholeClient } = await import("../../tools/pihole/client");
    const piholeClient = getPiholeClient(); // Use singleton to share session

    await piholeClient.createDnsRecord(fullDomain, ip);

    logger.info("DNS record created successfully", {
      domain: fullDomain,
      ip,
    });

    return {
      success: true,
      message: `DNS record created successfully: ${fullDomain} → ${ip}`,
      record: {
        domain: fullDomain,
        ip,
      },
    };
  } catch (error: any) {
    logger.error("Failed to create DNS record", {
      hostname,
      ip,
      domain: fullDomain,
      error: error.message,
    });

    return {
      success: false,
      message: `Failed to create DNS record: ${error.message}`,
    };
  }
}

