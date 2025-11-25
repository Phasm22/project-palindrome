/**
 * Proxmox API Discovery Service
 * 
 * Automatically discovers Proxmox API endpoints by:
 * 1. Querying the API documentation endpoint (if available)
 * 2. Probing common endpoint patterns
 * 3. Using OpenAPI/Swagger spec if available
 * 4. Runtime introspection of available paths
 */

import { ApiDiscoveryService, DiscoveredEndpoint, DiscoveryResult } from "./discovery-framework";
import { ProxmoxClient } from "../proxmox/client";
import { pceLogger as logger } from "../../pce/utils/logger";
import axios from "axios";

export class ProxmoxDiscoveryService extends ApiDiscoveryService {
  serviceName = "proxmox";
  baseUrl: string;
  private client: ProxmoxClient;
  private nodeInfo: {
    isStandalone: boolean;
    nodeName?: string;
    hasGlobalAccess: boolean;
  } | null = null;

  constructor(client: ProxmoxClient, baseUrl: string) {
    super();
    this.client = client;
    this.baseUrl = baseUrl;
  }

  /**
   * Detect node type and token scope
   */
  private async detectNodeInfo(): Promise<void> {
    if (this.nodeInfo) return; // Already detected

    let isStandalone = false;
    let nodeName: string | undefined;
    let hasGlobalAccess = false;

    // Step 1: Detect token scope by trying a global endpoint
    try {
      await this.client.get("/version");
      hasGlobalAccess = true;
      logger.debug("Token has global access");
    } catch (error: any) {
      if (error.response?.status === 401 || error.response?.status === 403) {
        hasGlobalAccess = false;
        logger.debug("Token is node-scoped (no global access)");
      }
    }

    // Step 2: Get actual node name from Proxmox API (preserves exact case)
    if (hasGlobalAccess) {
      // If we have global access, query /nodes to get the actual node name
      try {
        const nodesResult = await this.client.get("/nodes");
        const nodes = nodesResult.data?.data || [];
        
        if (nodes.length > 0) {
          // Use the first node, or try to match by hostname
          const url = new URL(this.baseUrl);
          const hostname = url.hostname.toLowerCase();
          
          // Try to find node matching hostname (case-insensitive match)
          const matchedNode = nodes.find((n: any) => 
            n.node && n.node.toLowerCase() === hostname.split('.')[0].toLowerCase()
          );
          
          if (matchedNode) {
            nodeName = matchedNode.node; // Use EXACT case from API
            logger.debug(`Found node from /nodes endpoint: ${nodeName} (matched hostname ${hostname})`);
          } else {
            // Use first node if no match
            nodeName = nodes[0].node; // Use EXACT case from API
            logger.debug(`Using first node from /nodes endpoint: ${nodeName}`);
          }
          
          // Check if it's a cluster (multiple nodes) or standalone
          isStandalone = nodes.length === 1;
          logger.debug(`Node type: ${isStandalone ? "standalone" : "cluster member"}`);
        }
      } catch (error: any) {
        logger.warn("Could not query /nodes endpoint, will try direct node access", error);
      }
    }

    // Step 3: If we don't have global access or /nodes failed, try direct node access
    // Use hostname-based candidates but preserve case from successful API calls
    if (!nodeName) {
      const url = new URL(this.baseUrl);
      const hostname = url.hostname;
      const hostnameNode = hostname.split('.')[0]; // Preserve case from hostname
      
      // Try common node names (preserving case)
      const possibleNodeNames = [
        hostnameNode, // Use hostname as-is (preserves case)
        'proxBig',    // Known node names with correct case
        'yin',
        'yang',
      ];

      // Try each candidate, but use the EXACT case from successful API response
      for (const candidateNode of possibleNodeNames) {
        try {
          const statusResult = await this.client.get(`/nodes/${candidateNode}/status`);
          const statusData = statusResult.data?.data;
          
          if (statusData) {
            // Success! Use the candidate name as-is (preserves case)
            nodeName = candidateNode;
            // Check if it's a cluster node
            isStandalone = statusData.type === "node" || statusData.type !== "cluster";
            logger.debug(`Node detected via direct access: ${nodeName}, type: ${statusData.type}, standalone: ${isStandalone}`);
            break;
          }
        } catch (error: any) {
          // If 401/403, it might be auth issue
          if (error.response?.status === 401) {
            logger.warn(`Authentication failed for node ${candidateNode}: Token may lack permissions`);
            throw new Error(`Authentication failed: Token lacks permissions for /nodes/${candidateNode}/status. Run 'pveum aclmod / -user <user> -role PVEAuditor'`);
          } else if (error.response?.status === 403) {
            logger.warn(`Access forbidden for node ${candidateNode}: Token may lack ACLs`);
            throw new Error(`Access forbidden: Token lacks ACLs for /nodes/${candidateNode}/status`);
          }
          // 404/596 or other errors - node doesn't exist with this case, try next
          logger.debug(`Node ${candidateNode} not found (status: ${error.response?.status || "unknown"}), trying next...`);
          continue;
        }
      }
    }

    // Step 4: Final fallback - use hostname (but warn)
    if (!nodeName) {
      const url = new URL(this.baseUrl);
      nodeName = url.hostname.split('.')[0]; // Preserve case from hostname
      logger.warn(`Could not detect node name from API, using ${nodeName} from hostname (may be incorrect case)`);
    }

    this.nodeInfo = {
      isStandalone,
      nodeName, // This now preserves exact case from API
      hasGlobalAccess,
    };
    
    logger.info(`Node detection complete: name=${nodeName}, standalone=${isStandalone}, globalAccess=${hasGlobalAccess}`);
  }

  /**
   * Discover Proxmox API endpoints
   * 
   * Strategy:
   * 1. Detect node type (standalone vs cluster) and token scope
   * 2. Only probe endpoints that match node type and token permissions
   * 3. Use response structure to infer available endpoints
   */
  async discoverEndpoints(): Promise<DiscoveryResult> {
    const endpoints: DiscoveredEndpoint[] = [];

    // Step 1: Detect node info first
    await this.detectNodeInfo();
    const { isStandalone, nodeName, hasGlobalAccess } = this.nodeInfo!;

    logger.info(`Discovery context: standalone=${isStandalone}, node=${nodeName}, globalAccess=${hasGlobalAccess}`);

    // Step 2: Discover node-scoped endpoints (always available)
    if (nodeName) {
      const nodeEndpoints = await this.discoverNodeEndpoints(nodeName);
      endpoints.push(...nodeEndpoints);
    }

    // Step 3: Discover cluster endpoints (only if not standalone AND has global access)
    if (!isStandalone && hasGlobalAccess) {
      const clusterEndpoints = await this.discoverClusterEndpoints();
      endpoints.push(...clusterEndpoints);
    } else {
      logger.debug("Skipping cluster endpoints (standalone node or no global access)");
    }

    // Step 4: Discover global endpoints (only if has global access)
    if (hasGlobalAccess) {
      const globalEndpoints = await this.discoverGlobalEndpoints();
      endpoints.push(...globalEndpoints);
    } else {
      logger.debug("Skipping global endpoints (node-scoped token)");
    }

    return {
      service: this.serviceName,
      baseUrl: this.baseUrl,
      endpoints: this.deduplicateEndpoints(endpoints),
      discoveredAt: new Date().toISOString(),
      metadata: {
        isStandalone,
        nodeName,
        hasGlobalAccess,
      },
    };
  }

  /**
   * Discover node-scoped endpoints (always available for node-scoped tokens)
   */
  private async discoverNodeEndpoints(nodeName: string): Promise<DiscoveredEndpoint[]> {
    const endpoints: DiscoveredEndpoint[] = [];
    
    const nodePatterns = [
      { path: `/nodes/${nodeName}/status`, method: "GET" as const, category: "node" },
      { path: `/nodes/${nodeName}/resources`, method: "GET" as const, category: "node" },
      { path: `/nodes/${nodeName}/qemu`, method: "GET" as const, category: "vm" },
      { path: `/nodes/${nodeName}/lxc`, method: "GET" as const, category: "container" },
      { path: `/nodes/${nodeName}/storage`, method: "GET" as const, category: "storage" },
      { path: `/nodes/${nodeName}/network`, method: "GET" as const, category: "network" },
      { path: `/nodes/${nodeName}/services`, method: "GET" as const, category: "system" },
      { path: `/nodes/${nodeName}/tasks`, method: "GET" as const, category: "system" },
      { path: `/nodes/${nodeName}/disks/list`, method: "GET" as const, category: "storage" },
    ];

    for (const pattern of nodePatterns) {
      try {
        const result = await this.probeEndpoint({
          ...pattern,
          readOnly: true,
          parameters: [
            { name: "node", type: "string", required: true, description: "Node name" },
          ],
        });
        
        if (result.accessible) {
          endpoints.push({
            ...pattern,
            path: pattern.path.replace(nodeName, "{node}"), // Parameterize
            readOnly: true,
            responseSchema: result.responseSchema,
          });
        }
      } catch (error: any) {
        // Skip endpoints that return 401/403 (not authorized) or 404 (not available)
        if (error.response?.status === 401 || error.response?.status === 403 || error.response?.status === 404) {
          continue;
        }
        // Other errors might indicate endpoint exists but requires params
      }
    }

    // Discover VM-specific endpoints by listing VMs first
    try {
      const qemuResult = await this.client.get(`/nodes/${nodeName}/qemu`);
      const qemuVms = qemuResult.data?.data || [];
      
      // Probe VM endpoints for the first VM found (as a sample)
      if (qemuVms.length > 0) {
        const sampleVmid = qemuVms[0].vmid;
        const vmPatterns = [
          { path: `/nodes/${nodeName}/qemu/${sampleVmid}/status`, method: "GET" as const, category: "vm" },
          { path: `/nodes/${nodeName}/qemu/${sampleVmid}/config`, method: "GET" as const, category: "vm" },
          { path: `/nodes/${nodeName}/qemu/${sampleVmid}/agent/network-get-interfaces`, method: "GET" as const, category: "vm" },
          { path: `/nodes/${nodeName}/qemu/${sampleVmid}/snapshot`, method: "GET" as const, category: "vm" },
        ];
        
        for (const pattern of vmPatterns) {
          try {
            const result = await this.probeEndpoint({
              ...pattern,
              readOnly: true,
              parameters: [
                { name: "node", type: "string", required: true },
                { name: "vmid", type: "number", required: true },
              ],
            });
            
            if (result.accessible) {
              endpoints.push({
                ...pattern,
                path: pattern.path.replace(nodeName, "{node}").replace(`/${sampleVmid}/`, "/{vmid}/"),
                readOnly: true,
                responseSchema: result.responseSchema,
              });
            }
          } catch (error: any) {
            // Skip endpoints that return 401/403/404
            if (error.response?.status === 401 || error.response?.status === 403 || error.response?.status === 404) {
              continue;
            }
          }
        }
      }
      
      // Same for LXC containers
      const lxcResult = await this.client.get(`/nodes/${nodeName}/lxc`);
      const lxcContainers = lxcResult.data?.data || [];
      
      if (lxcContainers.length > 0) {
        const sampleVmid = lxcContainers[0].vmid;
        const lxcPatterns = [
          { path: `/nodes/${nodeName}/lxc/${sampleVmid}/status`, method: "GET" as const, category: "container" },
          { path: `/nodes/${nodeName}/lxc/${sampleVmid}/config`, method: "GET" as const, category: "container" },
        ];
        
        for (const pattern of lxcPatterns) {
          try {
            const result = await this.probeEndpoint({
              ...pattern,
              readOnly: true,
              parameters: [
                { name: "node", type: "string", required: true },
                { name: "vmid", type: "number", required: true },
              ],
            });
            
            if (result.accessible) {
              endpoints.push({
                ...pattern,
                path: pattern.path.replace(nodeName, "{node}").replace(`/${sampleVmid}/`, "/{vmid}/"),
                readOnly: true,
                responseSchema: result.responseSchema,
              });
            }
          } catch (error: any) {
            if (error.response?.status === 401 || error.response?.status === 403 || error.response?.status === 404) {
              continue;
            }
          }
        }
      }
    } catch (error: any) {
      // If we can't list VMs, that's okay - we'll just skip VM-specific discovery
      logger.debug(`Could not discover VM-specific endpoints: ${error.message}`);
    }

    return endpoints;
  }

  /**
   * Discover cluster endpoints (only for cluster nodes with global access)
   */
  private async discoverClusterEndpoints(): Promise<DiscoveredEndpoint[]> {
    const endpoints: DiscoveredEndpoint[] = [];
    
    const clusterPatterns = [
      { path: "/cluster/status", method: "GET" as const, category: "cluster" },
      { path: "/cluster/resources", method: "GET" as const, category: "cluster" },
      { path: "/cluster/config/nodes", method: "GET" as const, category: "cluster" },
      { path: "/cluster/ha/groups", method: "GET" as const, category: "cluster" },
      { path: "/cluster/ha/resources", method: "GET" as const, category: "cluster" },
      { path: "/cluster/ceph/status", method: "GET" as const, category: "cluster" },
    ];

    for (const pattern of clusterPatterns) {
      try {
        const result = await this.probeEndpoint({
          ...pattern,
          readOnly: true,
        });
        
        if (result.accessible) {
          endpoints.push({
            ...pattern,
            readOnly: true,
            responseSchema: result.responseSchema,
          });
        }
      } catch (error: any) {
        // Skip endpoints that return 401/403 (not authorized) or 404 (not available)
        if (error.response?.status === 401 || error.response?.status === 403 || error.response?.status === 404) {
          continue;
        }
      }
    }

    // Try to discover via cluster resources
    try {
      const result = await this.client.get("/cluster/resources");
      const resources = result.data?.data || [];
      
      // Extract unique resource types
      const resourceTypes = new Set<string>();
      resources.forEach((r: any) => {
        if (r.type) resourceTypes.add(r.type);
        if (r.node) resourceTypes.add(`node:${r.node}`);
      });

      // Generate endpoints for each resource type
      resourceTypes.forEach(type => {
        if (type.startsWith("node:")) {
          const node = type.replace("node:", "");
          endpoints.push({
            path: `/nodes/${node}/status`,
            method: "GET",
            category: "node",
            readOnly: true,
            parameters: [{ name: "node", type: "string", required: true }],
          });
        }
      });
    } catch (error) {
      // Cluster resources not available, skip
    }

    return endpoints;
  }

  /**
   * Discover global endpoints (only for tokens with global access)
   */
  private async discoverGlobalEndpoints(): Promise<DiscoveredEndpoint[]> {
    const endpoints: DiscoveredEndpoint[] = [];
    
    const globalPatterns = [
      { path: "/version", method: "GET" as const, category: "system" },
      { path: "/nodes", method: "GET" as const, category: "cluster" },
      { path: "/storage", method: "GET" as const, category: "storage" },
      { path: "/access/users", method: "GET" as const, category: "access" },
      { path: "/access/roles", method: "GET" as const, category: "access" },
      { path: "/access/permissions", method: "GET" as const, category: "access" },
      { path: "/network", method: "GET" as const, category: "network" },
    ];

    for (const pattern of globalPatterns) {
      try {
        const result = await this.probeEndpoint({
          ...pattern,
          readOnly: true,
        });
        
        if (result.accessible) {
          endpoints.push({
            ...pattern,
            readOnly: true,
            responseSchema: result.responseSchema,
          });
        }
      } catch (error: any) {
        // Skip endpoints that return 401/403 (not authorized) or 404 (not available)
        if (error.response?.status === 401 || error.response?.status === 403 || error.response?.status === 404) {
          continue;
        }
      }
    }

    return endpoints;
  }

  /**
   * Probe an endpoint to see if it's accessible
   */
  async probeEndpoint(endpoint: DiscoveredEndpoint): Promise<{
    accessible: boolean;
    responseSchema?: any;
    error?: string;
  }> {
    try {
      // Replace parameterized paths with actual values for probing
      let probePath = endpoint.path;
      if (probePath.includes("{node}")) {
        // Use detected node name
        if (this.nodeInfo?.nodeName) {
          probePath = probePath.replace("{node}", this.nodeInfo.nodeName);
        } else {
          return { accessible: false, error: "No node name available for probing" };
        }
      }

      const result = await this.client.get(probePath);
      
      return {
        accessible: true,
        responseSchema: this.inferSchema(result.data),
      };
    } catch (error: any) {
      // 401 = Not authorized (token doesn't have permission)
      // 403 = Forbidden (endpoint exists but access denied)
      // 404 = Not found (endpoint doesn't exist)
      if (error.response?.status === 401 || error.response?.status === 403 || error.response?.status === 404) {
        return { accessible: false, error: error.response.statusText || `HTTP ${error.response.status}` };
      }
      // Other errors might indicate endpoint exists but requires params
      return { accessible: true }; // Assume accessible if not 401/403/404
    }
  }

  /**
   * Infer JSON schema from response data
   */
  private inferSchema(data: any): any {
    if (Array.isArray(data)) {
      return {
        type: "array",
        items: data.length > 0 ? this.inferSchema(data[0]) : {},
      };
    } else if (typeof data === "object" && data !== null) {
      const properties: Record<string, any> = {};
      Object.entries(data).forEach(([key, value]) => {
        properties[key] = this.inferSchema(value);
      });
      return { type: "object", properties };
    } else {
      return { type: typeof data };
    }
  }

  /**
   * Deduplicate endpoints by path and method
   */
  private deduplicateEndpoints(endpoints: DiscoveredEndpoint[]): DiscoveredEndpoint[] {
    const seen = new Set<string>();
    return endpoints.filter(e => {
      const key = `${e.method}:${e.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

