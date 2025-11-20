/**
 * Knowledge Graph Foundation - Minimal Ontology Schema
 * Task 5.1: Define Minimal Ontology Schema
 */

import type { ACLGroup } from "../../types";

/**
 * Core Node Types
 */
export enum NodeType {
  HOST = "Host",
  VM = "VM",
  CONTAINER = "Container",
  SERVICE = "Service",
  VLAN = "VLAN",
  ALERT = "Alert",
  USER = "User",
  NETWORK = "Network",
  DEPENDENCY = "Dependency",
  FIREWALL_RULE = "FirewallRule",
  CONFIG = "Config",
  // Proxmox-specific node types (TL-2A.6.B)
  PVE_NODE = "PVE_NODE",
  VM_INSTANCE = "VM_INSTANCE",
  PVE_STORAGE = "PVE_STORAGE",
}

/**
 * Core Relationship Types
 */
export enum RelationshipType {
  CONNECTS_TO = "CONNECTS_TO",
  AFFECTS = "AFFECTS",
  CONFIGURED_BY = "CONFIGURED_BY",
  OWNS = "OWNS",
  LOGGED_BY = "LOGGED_BY",
  RUNS_ON = "RUNS_ON",
  DEPENDS_ON = "DEPENDS_ON",
  BELONGS_TO = "BELONGS_TO",
  TRIGGERS = "TRIGGERS",
  ACCESSES = "ACCESSES",
  HOSTS = "HOSTS", // Node HOSTS VM/Container (host provides resources)
  // Proxmox-specific relationship types (TL-2A.6.B)
  USES = "USES", // VM USES Storage
  CONNECTED_TO = "CONNECTED_TO", // Storage CONNECTED_TO Node
  HOSTS_ON = "HOSTS_ON", // VM HOSTS_ON Node (VM is hosted on Node)
}

/**
 * Entity Attribute Schema
 * Task 7.7: Define required attributes for each ontology entity
 */
export interface EntityAttributes {
  [NodeType.HOST]: {
    hostname: string;
    ip?: string | string[];
    os?: string;
    role?: string;
    status?: string;
  };
  [NodeType.SERVICE]: {
    name: string;
    port?: number;
    protocol?: string;
    status?: string;
    version?: string;
  };
  [NodeType.VLAN]: {
    id: number;
    cidr?: string;
    name?: string;
    description?: string;
  };
  [NodeType.ALERT]: {
    severity: string;
    message: string;
    timestamp: Date | string;
    source?: string;
  };
  [NodeType.USER]: {
    username: string;
    role?: string;
    email?: string;
    status?: string;
  };
  [NodeType.NETWORK]: {
    cidr: string;
    name?: string;
    gateway?: string;
  };
  [NodeType.FIREWALL_RULE]: {
    rule_id: string;
    action: string;
    protocol?: string;
    source?: string;
    destination?: string;
  };
  [NodeType.CONFIG]: {
    config_key: string;
    config_value: string;
    config_type?: string;
  };
  // Proxmox-specific entity attributes (TL-2A.6.B)
  [NodeType.PVE_NODE]: {
    node: string; // Node name (e.g., "pve1")
    status?: string;
    cpu?: number;
    maxcpu?: number;
    memory?: number;
    maxmem?: number;
    uptime?: number;
  };
  [NodeType.VM_INSTANCE]: {
    vmid: number;
    name?: string;
    node: string; // Node where VM runs
    type?: "qemu" | "lxc";
    status?: string;
    cpu?: number;
    memory?: number;
    maxmem?: number;
    uptime?: number;
  };
  [NodeType.PVE_STORAGE]: {
    storage: string; // Storage name
    type?: string; // Storage type (dir, lvm, ceph, etc.)
    content?: string; // Content types (images, iso, etc.)
    nodes?: string[]; // Nodes where storage is available
  };
  [NodeType.CONTAINER]: {
    name: string;
    type?: string; // Container type (docker, lxc, podman, etc.)
    host?: string; // Host where container runs
    image?: string; // Container image
    status?: string;
  };
  [NodeType.DEPENDENCY]: {
    name: string;
    depends_on?: string; // What this depends on
    type?: string; // Dependency type (service, resource, network, etc.)
    critical?: boolean; // Whether this is a critical dependency
  };
  [NodeType.VM]: {
    name: string;
    host?: string; // Host where VM runs
    type?: string; // VM type (qemu, kvm, etc.)
    status?: string;
  };
}

/**
 * Graph Node Structure
 */
export interface GraphNode<T extends NodeType = NodeType> {
  id: string; // Canonical ID (normalized)
  type: T;
  attributes: EntityAttributes[T];
  aliases?: string[]; // Alternative names/identifiers
  versionHash?: string; // Source document version hash
  sourcePath?: string; // Source document path
  aclGroup?: ACLGroup;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Graph Relationship Structure
 */
export interface GraphRelationship {
  id: string;
  type: RelationshipType;
  from: string; // Source node ID
  to: string; // Target node ID
  properties?: Record<string, any>; // Additional relationship properties
  versionHash?: string; // Source document version hash
  sourcePath?: string; // Source document path
  aclGroup?: ACLGroup;
  createdAt: Date;
}

/**
 * Ontology Schema Version
 * Task 5.4: Schema versioning
 */
export interface OntologySchema {
  version: string;
  nodeTypes: NodeType[];
  relationshipTypes: RelationshipType[];
  createdAt: Date;
}

export const CURRENT_ONTOLOGY_VERSION = "1.0.0";

export const DEFAULT_ONTOLOGY: OntologySchema = {
  version: CURRENT_ONTOLOGY_VERSION,
  nodeTypes: Object.values(NodeType),
  relationshipTypes: Object.values(RelationshipType),
  createdAt: new Date(),
};

/**
 * Validate node attributes against schema
 */
export function validateNodeAttributes<T extends NodeType>(
  type: T,
  attributes: Partial<EntityAttributes[T]>
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  switch (type) {
    case NodeType.HOST: {
      const hostAttrs = attributes as Partial<EntityAttributes[NodeType.HOST]>;
      if (!hostAttrs.hostname) {
        errors.push("Host requires 'hostname' attribute");
      }
      break;
    }
    case NodeType.SERVICE: {
      const serviceAttrs = attributes as Partial<EntityAttributes[NodeType.SERVICE]>;
      if (!serviceAttrs.name) {
        errors.push("Service requires 'name' attribute");
      }
      break;
    }
    case NodeType.VLAN: {
      const vlanAttrs = attributes as Partial<EntityAttributes[NodeType.VLAN]>;
      if (vlanAttrs.id === undefined || vlanAttrs.id === null) {
        errors.push("VLAN requires 'id' attribute");
      }
      break;
    }
    case NodeType.ALERT: {
      const alertAttrs = attributes as Partial<EntityAttributes[NodeType.ALERT]>;
      if (!alertAttrs.severity) {
        errors.push("Alert requires 'severity' attribute");
      }
      if (!alertAttrs.message) {
        errors.push("Alert requires 'message' attribute");
      }
      if (!alertAttrs.timestamp) {
        errors.push("Alert requires 'timestamp' attribute");
      }
      break;
    }
    case NodeType.USER: {
      const userAttrs = attributes as Partial<EntityAttributes[NodeType.USER]>;
      if (!userAttrs.username) {
        errors.push("User requires 'username' attribute");
      }
      break;
    }
    case NodeType.NETWORK: {
      const networkAttrs = attributes as Partial<EntityAttributes[NodeType.NETWORK]>;
      if (!networkAttrs.cidr) {
        errors.push("Network requires 'cidr' attribute");
      }
      break;
    }
    case NodeType.FIREWALL_RULE: {
      const firewallAttrs = attributes as Partial<EntityAttributes[NodeType.FIREWALL_RULE]>;
      if (!firewallAttrs.rule_id) {
        errors.push("FirewallRule requires 'rule_id' attribute");
      }
      if (!firewallAttrs.action) {
        errors.push("FirewallRule requires 'action' attribute");
      }
      break;
    }
    case NodeType.CONFIG: {
      const configAttrs = attributes as Partial<EntityAttributes[NodeType.CONFIG]>;
      if (!configAttrs.config_key) {
        errors.push("Config requires 'config_key' attribute");
      }
      if (configAttrs.config_value === undefined) {
        errors.push("Config requires 'config_value' attribute");
      }
      break;
    }
    case NodeType.CONTAINER: {
      const containerAttrs = attributes as Partial<EntityAttributes[NodeType.CONTAINER]>;
      if (!containerAttrs.name) {
        errors.push("Container requires 'name' attribute");
      }
      break;
    }
    case NodeType.DEPENDENCY: {
      const dependencyAttrs = attributes as Partial<EntityAttributes[NodeType.DEPENDENCY]>;
      if (!dependencyAttrs.name) {
        errors.push("Dependency requires 'name' attribute");
      }
      break;
    }
    case NodeType.VM: {
      const vmAttrs = attributes as Partial<EntityAttributes[NodeType.VM]>;
      if (!vmAttrs.name) {
        errors.push("VM requires 'name' attribute");
      }
      break;
    }
    default:
      break;
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

