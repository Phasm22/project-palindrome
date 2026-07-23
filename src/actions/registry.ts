import { createVm, CreateVmSchema } from "./compute/create-vm";
import { destroyVm, DestroyVmSchema } from "./compute/destroy-vm";
import { createDnsRecord, CreateDnsRecordSchema } from "./network/create-dns-record";
import { syncDhcpToDns, SyncDhcpToDnsSchema } from "./network/sync-dhcp-to-dns";
import { setInterfaceVlan, SetInterfaceVlanSchema } from "./network/set-interface-vlan";
import { bootstrap, BootstrapSchema } from "./services/bootstrap";
import { installDocker, InstallDockerSchema } from "./services/install-docker";
import { installNginx, InstallNginxSchema } from "./services/install-nginx";
import { configureFirewall, ConfigureFirewallSchema } from "./services/configure-firewall";
import { setStaticIp, SetStaticIpSchema } from "./services/set-static-ip";

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
  acl?: string[];
  risk?: "low" | "medium" | "high";
  requiresConfirmation?: boolean;
  requiredTools?: string[];
  requiredEntities?: string[];
}

const ACTION_SECURITY = {
  "compute.create_vm": {
    acl: ["admin"],
    risk: "high",
    requiresConfirmation: false,
  },
  "compute.destroy_vm": {
    acl: ["admin"],
    risk: "high",
    requiresConfirmation: false,
  },
  "network.create_dns_record": {
    acl: ["admin", "ops"],
    risk: "medium",
    requiresConfirmation: false,
  },
  "network.sync_dhcp_to_dns": {
    acl: ["admin", "ops"],
    risk: "medium",
    requiresConfirmation: false,
  },
  "network.set_interface_vlan": {
    acl: ["admin"],
    risk: "high",
    requiresConfirmation: false,
  },
  "services.bootstrap": {
    acl: ["admin", "ops"],
    risk: "medium",
    requiresConfirmation: false,
  },
  "services.install_docker": {
    acl: ["admin", "ops"],
    risk: "medium",
    requiresConfirmation: false,
  },
  "services.install_nginx": {
    acl: ["admin", "ops"],
    risk: "medium",
    requiresConfirmation: false,
  },
  "services.configure_firewall": {
    acl: ["admin"],
    risk: "high",
    requiresConfirmation: false,
  },
  "services.set_static_ip": {
    acl: ["admin"],
    risk: "high",
    requiresConfirmation: false,
  },
} as const satisfies Record<
  string,
  Pick<ActionDefinition, "acl" | "risk" | "requiresConfirmation">
>;

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
  ...ACTION_SECURITY["compute.create_vm"],
  requiredTools: ["terraform"],
  requiredEntities: ["compute_node"],
});

actionRegistry.register({
  name: "compute.destroy_vm",
  description: "Destroy a VM on a Proxmox node using Terraform",
  schema: DestroyVmSchema,
  execute: destroyVm,
  ...ACTION_SECURITY["compute.destroy_vm"],
  requiredTools: ["terraform"],
  requiredEntities: ["compute_node"],
});

actionRegistry.register({
  name: "network.create_dns_record",
  description: "Create a DNS A record in Pi-hole for a hostname and IP address",
  schema: CreateDnsRecordSchema,
  execute: createDnsRecord,
  ...ACTION_SECURITY["network.create_dns_record"],
  requiredTools: ["pihole"],
  requiredEntities: [],
});

actionRegistry.register({
  name: "network.sync_dhcp_to_dns",
  description: "Sync OPNsense DHCP leases to Pi-hole DNS records. Bridges the gap between OPNsense DHCP (Unbound) and Pi-hole (forwarder).",
  schema: SyncDhcpToDnsSchema,
  execute: syncDhcpToDns,
  ...ACTION_SECURITY["network.sync_dhcp_to_dns"],
  requiredTools: ["opnsense", "pihole"],
  requiredEntities: [],
});

actionRegistry.register({
  name: "network.set_interface_vlan",
  description: "Assign a VM to an existing VLAN by updating its network configuration. Validates VLAN exists in OPNsense and twin before assignment.",
  schema: SetInterfaceVlanSchema,
  execute: setInterfaceVlan,
  ...ACTION_SECURITY["network.set_interface_vlan"],
  requiredTools: ["proxmox", "opnsense"],
  requiredEntities: ["compute_vm", "network_interface"],
});

actionRegistry.register({
  name: "services.bootstrap",
  description: "Run Ansible bootstrap playbook (common.yml) on a VM to perform complete system setup (security hardening, Docker, etc.)",
  schema: BootstrapSchema,
  execute: bootstrap,
  ...ACTION_SECURITY["services.bootstrap"],
  requiredTools: ["ansible"],
  requiredEntities: ["compute_vm"],
});

actionRegistry.register({
  name: "services.install_docker",
  description: "Install Docker CE, Docker Compose, and Portainer on a VM using Ansible",
  schema: InstallDockerSchema,
  execute: installDocker,
  ...ACTION_SECURITY["services.install_docker"],
  requiredTools: ["ansible"],
  requiredEntities: ["compute_vm"],
});

actionRegistry.register({
  name: "services.install_nginx",
  description: "Install and configure nginx web server on a VM using Ansible",
  schema: InstallNginxSchema,
  execute: installNginx,
  ...ACTION_SECURITY["services.install_nginx"],
  requiredTools: ["ansible"],
  requiredEntities: ["compute_vm"],
});

actionRegistry.register({
  name: "services.configure_firewall",
  description: "Configure UFW (Uncomplicated Firewall) rules on a VM using Ansible",
  schema: ConfigureFirewallSchema,
  execute: configureFirewall,
  ...ACTION_SECURITY["services.configure_firewall"],
  requiredTools: ["ansible"],
  requiredEntities: ["compute_vm"],
});

actionRegistry.register({
  name: "services.set_static_ip",
  description: "Configure a static IP address on a VM using netplan via Ansible",
  schema: SetStaticIpSchema,
  execute: setStaticIp,
  ...ACTION_SECURITY["services.set_static_ip"],
  requiredTools: ["ansible"],
  requiredEntities: ["compute_vm"],
});
