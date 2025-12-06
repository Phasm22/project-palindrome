import { createVm, CreateVmSchema } from "./compute/create-vm";
import { destroyVm, DestroyVmSchema } from "./compute/destroy-vm";
import { createDnsRecord, CreateDnsRecordSchema } from "./network/create-dns-record";
import { syncDhcpToDns, SyncDhcpToDnsSchema } from "./network/sync-dhcp-to-dns";

/**
 * Action Registry
 * 
 * Central registry for all actions in the Action Layer.
 * Actions are organized by domain (compute, network, firewall, bootstrap).
 */
export interface ActionDefinition {
  name: string;
  description: string;
  schema: any; // Zod schema
  execute: (params: any) => Promise<any>;
  requiredTools?: string[];
  requiredEntities?: string[];
}

class ActionRegistry {
  private actions: Map<string, ActionDefinition> = new Map();

  /**
   * Register an action
   */
  register(action: ActionDefinition): void {
    if (this.actions.has(action.name)) {
      throw new Error(`Action "${action.name}" is already registered`);
    }
    this.actions.set(action.name, action);
  }

  /**
   * Get an action by name
   */
  get(name: string): ActionDefinition | undefined {
    return this.actions.get(name);
  }

  /**
   * List all registered actions
   */
  list(): ActionDefinition[] {
    return Array.from(this.actions.values());
  }

  /**
   * List actions by domain
   */
  listByDomain(domain: string): ActionDefinition[] {
    return this.list().filter((action) => action.name.startsWith(`${domain}.`));
  }
}

// Create singleton instance
export const actionRegistry = new ActionRegistry();

// Register actions
actionRegistry.register({
  name: "compute.create_vm",
  description: "Create a new VM on a Proxmox node using Terraform",
  schema: CreateVmSchema,
  execute: createVm,
  requiredTools: ["terraform"],
  requiredEntities: ["compute_node"],
});

actionRegistry.register({
  name: "compute.destroy_vm",
  description: "Destroy a VM on a Proxmox node using Terraform",
  schema: DestroyVmSchema,
  execute: destroyVm,
  requiredTools: ["terraform"],
  requiredEntities: ["compute_node"],
});

actionRegistry.register({
  name: "network.create_dns_record",
  description: "Create a DNS A record in Pi-hole for a hostname and IP address",
  schema: CreateDnsRecordSchema,
  execute: createDnsRecord,
  requiredTools: ["pihole"],
  requiredEntities: [],
});

actionRegistry.register({
  name: "network.sync_dhcp_to_dns",
  description: "Sync OPNsense DHCP leases to Pi-hole DNS records. Bridges the gap between OPNsense DHCP (Unbound) and Pi-hole (forwarder).",
  schema: SyncDhcpToDnsSchema,
  execute: syncDhcpToDns,
  requiredTools: ["opnsense", "pihole"],
  requiredEntities: [],
});

