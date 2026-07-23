import { pceLogger as logger } from "../../pce/utils/logger";

/**
 * Validate environment variables required for terraform operations
 * Supports cluster nodes (yin/yang) and standalone nodes (proxBig)
 */
export function validateTerraformEnv(targetNode?: string): { valid: boolean; missing: string[]; warnings: string[] } {
  const missing: string[] = [];
  const warnings: string[] = [];

  // Normalize node name
  const nodeLower = targetNode?.toLowerCase() || "";

  // Check token based on target node
  const hasClusterTokenId = !!process.env.CLUSTER_TF_TOKEN_ID;
  
  if (nodeLower === "yin" || nodeLower === "yang") {
    // Cluster nodes - need either node-specific secret or cluster secret
    const hasNodeTokenId = nodeLower === "yin"
      ? !!process.env.PROXMOX_YIN_TF_TOKEN_ID
      : !!process.env.PROXMOX_YANG_TF_TOKEN_ID;
    const hasYinSecret = nodeLower === "yin" && !!process.env.PROXMOX_YIN_TF_SECRET;
    const hasYangSecret = nodeLower === "yang" && !!process.env.PROXMOX_YANG_TF_SECRET;
    const hasClusterSecret = !!process.env.PROXMOX_CLUSTER_TF_SECRET;
    
    if (!hasNodeTokenId && !hasClusterTokenId) {
      missing.push(`PROXMOX_${targetNode?.toUpperCase()}_TF_TOKEN_ID or CLUSTER_TF_TOKEN_ID`);
    }
    
    if (nodeLower === "yin" && !hasYinSecret && !hasClusterSecret) {
      missing.push("PROXMOX_YIN_TF_SECRET or PROXMOX_CLUSTER_TF_SECRET");
    } else if (nodeLower === "yang" && !hasYangSecret && !hasClusterSecret) {
      missing.push("PROXMOX_YANG_TF_SECRET or PROXMOX_CLUSTER_TF_SECRET");
    }
  } else {
    // Check for base URL (required for proxBig/default targets)
    if (!process.env.PROXMOX_URL) {
      missing.push("PROXMOX_URL");
    }

    // proxBig or default - need cluster token ID and proxbig-specific secret (or cluster secret as fallback)
    const hasProxbigSecret = !!(process.env.PROXMOX_PROXBIG_TF_SECRET || process.env.PROXBIG_TF_SECRET || process.env.PROXBIG_TOKEN_SECRET);
    const hasClusterSecret = !!process.env.PROXMOX_CLUSTER_TF_SECRET;

    if (!hasClusterTokenId) {
      missing.push("CLUSTER_TF_TOKEN_ID or PROXBIG_TF_TOKEN_ID");
    }
    if (!hasProxbigSecret && !hasClusterSecret) {
      missing.push("PROXMOX_PROXBIG_TF_SECRET, PROXBIG_TF_SECRET, or PROXBIG_TOKEN_SECRET (or PROXMOX_CLUSTER_TF_SECRET as fallback)");
    }
  }

  // Optional but recommended
  if (!process.env.SSH_PUBLIC_KEY) {
    warnings.push("SSH_PUBLIC_KEY not set - terraform will try to read from ~/.ssh/id_ed25519.pub");
  }

  return {
    valid: missing.length === 0,
    missing,
    warnings,
  };
}

/**
 * Validate and log environment variable status
 * @param targetNode - Optional target node name for cluster-aware validation
 */
export function checkTerraformEnv(targetNode?: string): boolean {
  const validation = validateTerraformEnv(targetNode);

  if (!validation.valid) {
    logger.error("Missing required environment variables for terraform operations:", {
      missing: validation.missing,
      targetNode: targetNode || "default",
    });
    
    const nodeLower = targetNode?.toLowerCase() || "";
    let requiredVars: string[] = [];
    
    if (nodeLower === "yin" || nodeLower === "yang") {
      requiredVars = [
        `PROXMOX_${targetNode?.toUpperCase()}_URL - Optional node-specific endpoint; defaults to https://${nodeLower}.prox:8006`,
        `PROXMOX_${targetNode?.toUpperCase()}_TF_TOKEN_ID or CLUSTER_TF_TOKEN_ID - Terraform token ID (e.g., llm@pve!llm-agent)`,
        `PROXMOX_${targetNode?.toUpperCase()}_TF_SECRET - Token secret for ${targetNode} node (or use PROXMOX_CLUSTER_TF_SECRET)`,
        "SSH_PUBLIC_KEY - SSH public key (optional, terraform can read from file)",
      ];
    } else {
      requiredVars = [
        "PROXMOX_URL - Proxmox API endpoint (e.g., https://proxBig.prox:8006)",
        "CLUSTER_TF_TOKEN_ID - Terraform token ID (e.g., llm@pve!llm-agent)",
        "PROXMOX_CLUSTER_TF_SECRET - Terraform token secret",
        "SSH_PUBLIC_KEY - SSH public key (optional, terraform can read from file)",
      ];
    }
    
    logger.info("Required environment variables:", { required: requiredVars });
    return false;
  }

  if (validation.warnings.length > 0) {
    logger.warn("Environment variable warnings:", { warnings: validation.warnings });
  }

  return true;
}
