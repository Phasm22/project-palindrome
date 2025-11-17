/**
 * Knowledge Graph Foundation - Minimal Ontology Schema
 * Task 5.1: Define Minimal Ontology Schema
 */

/**
 * Core Node Types
 */
export enum NodeType {
  HOST = "Host",
  SERVICE = "Service",
  VLAN = "VLAN",
  ALERT = "Alert",
  USER = "User",
  NETWORK = "Network",
  FIREWALL_RULE = "FirewallRule",
  CONFIG = "Config",
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
  BELONGS_TO = "BELONGS_TO",
  TRIGGERS = "TRIGGERS",
  ACCESSES = "ACCESSES",
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
    case NodeType.HOST:
      if (!attributes.hostname) {
        errors.push("Host requires 'hostname' attribute");
      }
      break;
    case NodeType.SERVICE:
      if (!attributes.name) {
        errors.push("Service requires 'name' attribute");
      }
      break;
    case NodeType.VLAN:
      if (!attributes.id && attributes.id !== 0) {
        errors.push("VLAN requires 'id' attribute");
      }
      break;
    case NodeType.ALERT:
      if (!attributes.severity) {
        errors.push("Alert requires 'severity' attribute");
      }
      if (!attributes.message) {
        errors.push("Alert requires 'message' attribute");
      }
      if (!attributes.timestamp) {
        errors.push("Alert requires 'timestamp' attribute");
      }
      break;
    case NodeType.USER:
      if (!attributes.username) {
        errors.push("User requires 'username' attribute");
      }
      break;
    case NodeType.NETWORK:
      if (!attributes.cidr) {
        errors.push("Network requires 'cidr' attribute");
      }
      break;
    case NodeType.FIREWALL_RULE:
      if (!attributes.rule_id) {
        errors.push("FirewallRule requires 'rule_id' attribute");
      }
      if (!attributes.action) {
        errors.push("FirewallRule requires 'action' attribute");
      }
      break;
    case NodeType.CONFIG:
      if (!attributes.config_key) {
        errors.push("Config requires 'config_key' attribute");
      }
      if (!attributes.config_value === undefined) {
        errors.push("Config requires 'config_value' attribute");
      }
      break;
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

