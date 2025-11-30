/**
 * API Discovery System
 * 
 * Automated discovery and ingestion of API capabilities.
 * 
 * Usage:
 * ```typescript
 * import { discoveryRegistry } from "./api-discovery";
 * import { ProxmoxDiscoveryService } from "./proxmox-discovery";
 * 
 * // Register discovery services
 * const proxmoxClient = new ProxmoxClient(config);
 * discoveryRegistry.register(new ProxmoxDiscoveryService(proxmoxClient));
 * 
 * // Discover all endpoints
 * const results = await discoveryRegistry.discoverAll();
 * 
 * // Generate tool schemas from discovery
 * results.forEach(result => {
 *   const schema = discoveryService.generateToolSchema(result, "tool_name", "description");
 *   // Use schema to update tool definitions
 * });
 * ```
 */

export * from "./discovery-framework";
export * from "./proxmox-discovery";
export * from "./opnsense-discovery";

