import { createHash } from "node:crypto";
import { logger } from "../../utils/logger";
import { TerraformRunner } from "../../actions/helpers/terraform-runner";

export function buildPendingActionRecord(
  executeInput: string,
  summary?: string,
  type: string = "change_request"
): {
  id: string;
  digest: string;
  createdAt: number;
  expiresAt: number;
  type: string;
  preview: string;
  executeInput: string;
  summary: string;
} {
  const createdAt = Date.now();
  const expiresAt = createdAt + 15 * 60 * 1000;
  const digest = createHash("sha256").update(executeInput).digest("hex");
  const id = digest.slice(0, 8);
  return {
    id,
    digest,
    createdAt,
    expiresAt,
    type,
    preview: summary ?? executeInput,
    executeInput,
    summary: summary ?? executeInput,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function summarizeToolCall(toolName: string, params: Record<string, any>): string {
  if (toolName === "action" && params.action) {
    const actionName = String(params.action);
    const actionParams =
      params.params && typeof params.params === "object" && !Array.isArray(params.params)
        ? params.params
        : {};
    const detailParts: string[] = [];
    if (typeof actionParams.name === "string" && actionParams.name.trim().length > 0) {
      detailParts.push(`name ${actionParams.name.trim()}`);
    }
    if (typeof actionParams.node === "string" && actionParams.node.trim().length > 0) {
      detailParts.push(`node ${actionParams.node.trim()}`);
    }
    if (typeof actionParams.vmId === "number") {
      detailParts.push(`vmid ${actionParams.vmId}`);
    }
    if (typeof actionParams.vmid === "number") {
      detailParts.push(`vmid ${actionParams.vmid}`);
    }
    return detailParts.length > 0
      ? `action ${actionName} (${detailParts.join(", ")})`
      : `action ${actionName}`;
  }
  if (toolName === "proxmox_write" && params.action) {
    const target = params.vmid ? `vmid ${params.vmid}` : params.node ? `node ${params.node}` : "";
    return `proxmox_write ${params.action}${target ? ` ${target}` : ""}`;
  }
  if (toolName === "opnsense_safewrite" && params.action) {
    return `opnsense ${params.action}`;
  }
  return `${toolName} change`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function inferMissingToolSlots(toolName: string, params: Record<string, any>): string[] {
  const missing = new Set<string>();

  if (toolName === "action" && typeof params.action === "string") {
    const actionName = params.action;
    const actionParams =
      params.params && typeof params.params === "object" && !Array.isArray(params.params)
        ? params.params
        : {};

    if (actionName === "compute.create_vm") {
      const node =
        typeof actionParams.node === "string" ? actionParams.node.trim() : "";
      if (!node) {
        missing.add("target");
        missing.add("node");
      }
    }

    if (actionName === "compute.destroy_vm") {
      const hasName = typeof actionParams.name === "string" && actionParams.name.trim().length > 0;
      const hasVmId =
        typeof actionParams.vmId === "number" ||
        (typeof actionParams.vmid === "number") ||
        (typeof actionParams.vmId === "string" && actionParams.vmId.trim().length > 0) ||
        (typeof actionParams.vmid === "string" && actionParams.vmid.trim().length > 0);
      if (!hasName && !hasVmId) {
        missing.add("target");
      }
    }
  }

  if (toolName === "proxmox_write" && typeof params.action === "string") {
    const actionName = params.action.toLowerCase();
    const requiresVmTarget = ["start_vm", "stop_vm", "restart_vm", "destroy_vm"].includes(actionName);
    if (requiresVmTarget) {
      const hasNode = typeof params.node === "string" && params.node.trim().length > 0;
      const hasVmId =
        typeof params.vmid === "number" ||
        (typeof params.vmid === "string" && params.vmid.trim().length > 0);
      if (!hasNode) missing.add("node");
      if (!hasVmId) missing.add("vmid");
    }
  }

  return Array.from(missing);
}

export async function cleanupAfterProxmoxDestroy(vmName: string): Promise<void> {
  const normalizedName = vmName.trim();
  const infraName = normalizedName.replace(/\.prox$/i, "");
  if (!infraName || infraName.toLowerCase() === "unknown") {
    return;
  }

  try {
    if (process.env.PIHOLE_WEB_PWD || process.env.PIHOLE_API_KEY) {
      const { getPiholeClient } = await import("../../tools/pihole/client");
      const piholeClient = getPiholeClient();
      const dnsDomain = normalizedName.toLowerCase().endsWith(".prox")
        ? normalizedName
        : `${infraName}.prox`;
      const existingRecords = await piholeClient.listDnsRecords();
      const dnsRecord = existingRecords.find((record) => {
        const left = record.domain.toLowerCase().replace(/\.$/, "");
        const right = dnsDomain.toLowerCase().replace(/\.$/, "");
        return left === right;
      });
      if (dnsRecord) {
        await piholeClient.deleteDnsRecord(dnsRecord.domain, dnsRecord.ip);
        logger.info("Deleted DNS record after proxmox_write destroy_vm", {
          vmName: normalizedName,
          domain: dnsRecord.domain,
          ip: dnsRecord.ip,
        });
      } else {
        logger.warn("No DNS record found after proxmox_write destroy_vm", {
          vmName: normalizedName,
          expectedDomain: dnsDomain,
        });
      }
    }
  } catch (error: unknown) {
    logger.warn("Failed DNS cleanup after proxmox_write destroy_vm", {
      vmName: normalizedName,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const terraformRunner = new TerraformRunner();
  try {
    await terraformRunner.removeVmFromState(infraName);
  } catch (error: unknown) {
    logger.warn("Failed to clean Terraform state after proxmox_write destroy_vm", {
      vmName: infraName,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const removed = await terraformRunner.removeVmFromTfvars(infraName);
    if (!removed) {
      logger.warn("Destroyed VM not present in tfvars during proxmox_write cleanup", {
        vmName: infraName,
      });
    }
  } catch (error: unknown) {
    logger.warn("Failed to clean tfvars after proxmox_write destroy_vm", {
      vmName: infraName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
