import { z } from "zod";
import { OpnsenseReadOnlyTool } from "../../tools/opnsense/readonly/opnsense-readonly-tool";
import { PiholeClient } from "../../tools/pihole/client";
import { pceLogger as logger } from "../../pce/utils/logger";

/**
 * Sync DHCP Leases to DNS Records Action Schema
 */
export const SyncDhcpToDnsSchema = z.object({
  dryRun: z.boolean().default(false),
  domain: z.string().optional().default(".prox"), // Domain suffix for DNS records
  updateExisting: z.boolean().default(true), // Update DNS records if IP changed
});

export type SyncDhcpToDnsParams = z.infer<typeof SyncDhcpToDnsSchema>;

export interface SyncDhcpToDnsResult {
  success: boolean;
  message: string;
  stats: {
    totalLeases: number;
    leasesWithHostname: number;
    dnsRecordsCreated: number;
    dnsRecordsUpdated: number;
    dnsRecordsSkipped: number;
    errors: number;
  };
  details?: Array<{
    hostname: string;
    ip: string;
    mac?: string;
    action: "created" | "updated" | "skipped" | "error";
    error?: string;
  }>;
}

/**
 * Sync DHCP Leases to DNS Records Action
 * 
 * Queries OPNsense DHCP leases and creates/updates corresponding DNS records in Pi-hole.
 * This bridges the gap between OPNsense DHCP (which registers in Unbound) and Pi-hole (the forwarder).
 */
export async function syncDhcpToDns(
  params: SyncDhcpToDnsParams
): Promise<SyncDhcpToDnsResult> {
  const { dryRun, domain = ".prox", updateExisting = true } = params;

  logger.info("Syncing DHCP leases to DNS records", { dryRun, domain, updateExisting });

  // Validate Pi-hole credentials
  // Pi-hole v6+ REST API uses web password, legacy API uses pwhash
  const webPassword = process.env.PIHOLE_WEB_PWD;
  const apiKey = process.env.PIHOLE_API_KEY; // Legacy API fallback
  if (!webPassword && !apiKey) {
    return {
      success: false,
      message: "PIHOLE_WEB_PWD (for REST API v6+) or PIHOLE_API_KEY (for legacy API) environment variable is required for DNS operations.",
      stats: {
        totalLeases: 0,
        leasesWithHostname: 0,
        dnsRecordsCreated: 0,
        dnsRecordsUpdated: 0,
        dnsRecordsSkipped: 0,
        errors: 1,
      },
    };
  }

  // Pi-hole server URL
  const piholeUrl = process.env.PIHOLE_URL || "http://piholelab.prox";
  let cleanUrl = piholeUrl.replace(/\/admin\/?$/, "");
  if (!cleanUrl.startsWith("http://") && !cleanUrl.startsWith("https://")) {
    cleanUrl = `http://${cleanUrl}`;
  }

  const stats = {
    totalLeases: 0,
    leasesWithHostname: 0,
    dnsRecordsCreated: 0,
    dnsRecordsUpdated: 0,
    dnsRecordsSkipped: 0,
    errors: 0,
  };

  const details: SyncDhcpToDnsResult["details"] = [];

  try {
    // 1. Query OPNsense DHCP leases
    const opnsenseTool = new OpnsenseReadOnlyTool();
    const dhcpResult = await opnsenseTool.execute(
      { action: "dhcp_leases_list" },
      { toolName: "opnsense_readonly", startedAt: Date.now() }
    );

    if (dhcpResult.error || !dhcpResult.data) {
      return {
        success: false,
        message: `Failed to query OPNsense DHCP leases: ${dhcpResult.error || "No data returned"}`,
        stats,
      };
    }

    // Parse leases from response
    const leases = Array.isArray(dhcpResult.data)
      ? dhcpResult.data
      : dhcpResult.data.leases || dhcpResult.data.data || [];

    stats.totalLeases = leases.length;
    logger.info("Retrieved DHCP leases", { count: stats.totalLeases });

    // 2. Filter leases with hostnames
    const leasesWithHostname = leases.filter((lease: any) => {
      const hostname = lease.hostname || lease.name || lease.host_name;
      return hostname && hostname.trim() && hostname !== "?" && hostname !== "-";
    });

    stats.leasesWithHostname = leasesWithHostname.length;
    logger.info("Leases with hostnames", { count: stats.leasesWithHostname });

    if (leasesWithHostname.length === 0) {
      return {
        success: true,
        message: "No DHCP leases with hostnames found. Nothing to sync.",
        stats,
      };
    }

    // 3. Get existing DNS records from Pi-hole
    const { getPiholeClient } = await import("../../tools/pihole/client");
    const piholeClient = getPiholeClient(); // Use singleton to share session

    let existingDnsRecords: Array<{ domain: string; ip: string }> = [];
    if (!dryRun) {
      try {
        existingDnsRecords = await piholeClient.listDnsRecords();
        logger.debug("Retrieved existing DNS records", { count: existingDnsRecords.length });
      } catch (error: any) {
        logger.warn("Failed to list existing DNS records, proceeding anyway", {
          error: error.message,
        });
      }
    }

    // 4. Process each lease
    for (const lease of leasesWithHostname) {
      const hostname = (lease.hostname || lease.name || lease.host_name || "").trim();
      const ip = lease.ip || lease.address || lease.ip_address;
      const mac = lease.mac || lease.mac_address;

      if (!hostname || !ip) {
        logger.debug("Skipping lease with missing hostname or IP", { hostname, ip, mac });
        stats.dnsRecordsSkipped++;
        continue;
      }

      // Construct full domain name
      let fullDomain = hostname;
      if (!hostname.includes(".")) {
        const domainSuffix = domain.startsWith(".") ? domain : `.${domain}`;
        fullDomain = `${hostname}${domainSuffix}`;
      }

      // Check if DNS record already exists
      const existingRecord = existingDnsRecords.find((r) => r.domain === fullDomain);

      try {
        if (dryRun) {
          if (existingRecord) {
            if (existingRecord.ip !== ip && updateExisting) {
              details.push({
                hostname: fullDomain,
                ip,
                mac,
                action: "updated",
              });
              stats.dnsRecordsUpdated++;
            } else {
              details.push({
                hostname: fullDomain,
                ip,
                mac,
                action: "skipped",
              });
              stats.dnsRecordsSkipped++;
            }
          } else {
            details.push({
              hostname: fullDomain,
              ip,
              mac,
              action: "created",
            });
            stats.dnsRecordsCreated++;
          }
        } else {
          // Create or update DNS record
          if (existingRecord) {
            if (existingRecord.ip !== ip && updateExisting) {
              // Delete old record and create new one
              await piholeClient.deleteDnsRecord(existingRecord.domain, existingRecord.ip);
              await piholeClient.createDnsRecord(fullDomain, ip);
              details.push({
                hostname: fullDomain,
                ip,
                mac,
                action: "updated",
              });
              stats.dnsRecordsUpdated++;
              logger.info("Updated DNS record", { domain: fullDomain, oldIp: existingRecord.ip, newIp: ip });
            } else {
              details.push({
                hostname: fullDomain,
                ip,
                mac,
                action: "skipped",
              });
              stats.dnsRecordsSkipped++;
            }
          } else {
            // Create new DNS record
            await piholeClient.createDnsRecord(fullDomain, ip);
            details.push({
              hostname: fullDomain,
              ip,
              mac,
              action: "created",
            });
            stats.dnsRecordsCreated++;
            logger.info("Created DNS record", { domain: fullDomain, ip });
          }
        }
      } catch (error: any) {
        // Check if error is "already exists" - treat as skipped, not error
        if (error.message && error.message.includes("already has a custom DNS entry")) {
          logger.info("DNS record already exists, skipping", { hostname: fullDomain, ip });
          details.push({
            hostname: fullDomain,
            ip,
            mac,
            action: "skipped",
          });
          stats.dnsRecordsSkipped++;
        } else {
          logger.error("Failed to process DNS record", {
            hostname: fullDomain,
            ip,
            error: error.message,
          });
          details.push({
            hostname: fullDomain,
            ip,
            mac,
            action: "error",
            error: error.message,
          });
          stats.errors++;
        }
      }
    }

    const message = dryRun
      ? `Dry-run: Would sync ${stats.dnsRecordsCreated} created, ${stats.dnsRecordsUpdated} updated, ${stats.dnsRecordsSkipped} skipped from ${stats.leasesWithHostname} DHCP leases with hostnames.`
      : `Synced ${stats.dnsRecordsCreated} created, ${stats.dnsRecordsUpdated} updated, ${stats.dnsRecordsSkipped} skipped DNS records from ${stats.leasesWithHostname} DHCP leases with hostnames.${stats.errors > 0 ? ` ${stats.errors} errors occurred.` : ""}`;

    return {
      success: stats.errors === 0,
      message,
      stats,
      details,
    };
  } catch (error: any) {
    logger.error("Failed to sync DHCP leases to DNS", { error: error.message });
    return {
      success: false,
      message: `Failed to sync DHCP leases to DNS: ${error.message}`,
      stats,
      details,
    };
  }
}

