import { createHash } from "node:crypto";
import type { Parser, ParserContext, ParserResult } from "../types";
import type { TwinEntity, FirewallRuleEntity } from "../../twin/models/entities";
import type { TwinRelationship } from "../../twin/models/relationships";
import { TwinEntityType } from "../../twin/models/entities";
import { TwinRelationshipType } from "../../twin/models/relationships";

/**
 * Input format from opnsense_readonly firewall_rules_list:
 * {
 *   rules: string[],  // pfctl -sr output lines
 *   nat: string[],    // pfctl -sn output lines
 *   source: "ssh_pfctl",
 *   timestamp: string
 * }
 */
interface PfctlInput {
  rules?: string[];
  nat?: string[];
  source?: string;
  timestamp?: string;
}

/**
 * Parses pfctl output into canonical FirewallRule entities.
 * 
 * pfctl -sr format examples:
 *   pass in quick on em0 proto tcp from any to 192.168.1.0/24 port 22
 *   block in quick on em1 from 10.0.0.0/8 to any
 *   pass out on em0 from 192.168.1.0/24 to any
 * 
 * pfctl -sn format examples:
 *   nat on em0 from 192.168.1.0/24 to any -> (em0)
 *   rdr on em0 proto tcp from any to 1.2.3.4 port 80 -> 192.168.1.10 port 8080
 */
export class PfctlFirewallParser implements Parser<PfctlInput> {
  name = "pfctl-firewall-parser";
  domain = "security";

  async parse(input: PfctlInput, context: ParserContext): Promise<ParserResult> {
    const entities: TwinEntity[] = [];
    const relationships: TwinRelationship[] = [];

    // Parse filter rules (pfctl -sr)
    if (input.rules && Array.isArray(input.rules)) {
      for (const ruleLine of input.rules) {
        if (!ruleLine || typeof ruleLine !== "string") continue;
        const parsed = this.parseFilterRule(ruleLine, context);
        if (parsed) {
          entities.push(parsed.entity);
          if (parsed.relationships) {
            relationships.push(...parsed.relationships);
          }
        }
      }
    }

    // Parse NAT rules (pfctl -sn)
    if (input.nat && Array.isArray(input.nat)) {
      for (const natLine of input.nat) {
        if (!natLine || typeof natLine !== "string") continue;
        const parsed = this.parseNatRule(natLine, context);
        if (parsed) {
          entities.push(parsed.entity);
          if (parsed.relationships) {
            relationships.push(...parsed.relationships);
          }
        }
      }
    }

    return { entities, relationships };
  }

  /**
   * Parse a filter rule line (pfctl -sr).
   * Format: [action] [direction] [flags] on [interface] [proto] from [source] to [dest] [port]
   */
  private parseFilterRule(
    line: string,
    context: ParserContext
  ): { entity: FirewallRuleEntity; relationships?: TwinRelationship[] } | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    // Tokenize: split on whitespace but preserve quoted strings
    const tokens = this.tokenize(trimmed);
    if (tokens.length < 3) return null;

    let idx = 0;
    const actionToken = tokens[idx++];
    if (!actionToken) return null;
    let action = actionToken;
    // Handle "block drop" or "block return" - normalize to "block"
    if (action === "block" && idx < tokens.length && (tokens[idx] === "drop" || tokens[idx] === "return")) {
      idx++; // Skip "drop" or "return"
    }
    if (!["pass", "block", "reject"].includes(action)) return null;

    // Parse direction (optional) - check BEFORE "log" since direction can come before log
    let direction: "in" | "out" | "any" = "any";
    if (idx < tokens.length && (tokens[idx] === "in" || tokens[idx] === "out")) {
      direction = tokens[idx++] as "in" | "out";
    }

    // Skip "log" if present (can appear after direction)
    if (idx < tokens.length && tokens[idx] === "log") {
      idx++;
    }

    // Parse flags (quick, keep state, etc.)
    let flags: string | null = null;
    while (idx < tokens.length) {
      const flagToken = tokens[idx];
      if (!flagToken || !["quick", "keep", "state"].includes(flagToken)) {
        break;
      }
      if (!flags) flags = "";
      flags += (flags ? " " : "") + flagToken;
      idx++;
      if (flagToken === "keep" && tokens[idx] === "state") {
        const stateToken = tokens[idx];
        if (!stateToken) {
          break;
        }
        flags += ` ${stateToken}`;
        idx++;
      }
    }

    // Skip "inet" or "inet6" if present
    if (idx < tokens.length && (tokens[idx] === "inet" || tokens[idx] === "inet6")) {
      idx++;
    }

    // Parse "on [interface]" - handle "!" negation prefix
    let interfaceName: string | null = null;
    if (idx < tokens.length && tokens[idx] === "on") {
      idx++;
      if (idx < tokens.length) {
        // Handle "! vtnet1" - skip the "!" and take the interface
        if (tokens[idx] === "!") {
          idx++;
        }
        if (idx < tokens.length) {
          interfaceName = tokens[idx] ?? null;
          idx++;
        }
      }
    }

    // Skip "inet" or "inet6" if present (can appear after interface)
    if (idx < tokens.length && (tokens[idx] === "inet" || tokens[idx] === "inet6")) {
      idx++;
    }

    // Parse protocol
    let protocol: string | null = null;
    if (idx < tokens.length && tokens[idx] === "proto") {
      idx++;
      if (idx < tokens.length) {
        protocol = tokens[idx] ?? null;
        idx++;
      }
    }

    // Parse "from [source]"
    let source: string | null = null;
    if (idx < tokens.length && tokens[idx] === "from") {
      idx++;
      const parsed = this.parseAddressSpec(tokens, idx);
      source = parsed.spec;
      idx = parsed.nextIdx;
    }

    // Parse "to [destination]"
    let destination: string | null = null;
    if (idx < tokens.length && tokens[idx] === "to") {
      idx++;
      const parsed = this.parseAddressSpec(tokens, idx);
      destination = parsed.spec;
      idx = parsed.nextIdx;
    }

    // Parse port (optional)
    let sourcePort: string | null = null;
    let destinationPort: string | null = null;
    if (idx < tokens.length && tokens[idx] === "port") {
      idx++;
      const parsedPort = this.parsePortSpec(tokens, idx);
      destinationPort = parsedPort.port;
      idx = parsedPort.nextIdx;
    }

    // Generate rule ID
    const ruleId = this.normalizeRuleId(
      interfaceName,
      action,
      direction,
      source,
      destination,
      protocol,
      destinationPort,
      trimmed
    );

    // Determine chain (interface-based grouping)
    const chain = interfaceName ? `chain:${interfaceName}` : "chain:default";

    const entity: FirewallRuleEntity = {
      id: ruleId,
      type: TwinEntityType.FIREWALL_RULE,
      displayName: `${action} ${direction} on ${interfaceName || "any"}`,
      source: context.source,
      collectedAt: context.collectedAt,
      data: {
        action: action as "pass" | "block" | "reject",
        direction,
        interface: interfaceName,
        protocol,
        source,
        destination,
        sourcePort,
        destinationPort,
        flags,
        ruleType: "filter",
        chain,
        enabled: true,
      },
    };

    // Create relationships to interfaces/subnets if we can resolve them
    const relationships: TwinRelationship[] = [];
    
    // Link to interface if we have one
    if (interfaceName) {
      const ifaceId = `network-if:opnsense:${interfaceName.toLowerCase()}`;
      // We'll create the relationship during ingestion when we have the full graph
    }

    // Link to source subnet if source is a CIDR
    if (source && this.isCidr(source)) {
      const subnetId = `network-subnet:${source.toLowerCase()}`;
      // Relationship will be created during ingestion
    }

    // Link to destination subnet if destination is a CIDR
    if (destination && this.isCidr(destination)) {
      const subnetId = `network-subnet:${destination.toLowerCase()}`;
      // Relationship will be created during ingestion
    }

    return { entity, relationships };
  }

  /**
   * Parse a NAT rule line (pfctl -sn).
   * Format: nat on [interface] from [source] to [dest] -> [target]
   * Format: rdr on [interface] proto [proto] from [source] to [dest] port [port] -> [target] port [port]
   */
  private parseNatRule(
    line: string,
    context: ParserContext
  ): { entity: FirewallRuleEntity; relationships?: TwinRelationship[] } | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    const tokens = this.tokenize(trimmed);
    if (tokens.length < 4) return null;

    let idx = 0;
    const ruleType = tokens[idx++];
    if (!ruleType) return null;
    if (!["nat", "rdr"].includes(ruleType)) return null;

    // Parse "on [interface]"
    let interfaceName: string | null = null;
    if (idx < tokens.length && tokens[idx] === "on") {
      idx++;
      if (idx < tokens.length) {
        interfaceName = tokens[idx] ?? null;
        idx++;
      }
    }

    // Parse protocol (for rdr)
    let protocol: string | null = null;
    if (idx < tokens.length && tokens[idx] === "proto") {
      idx++;
      if (idx < tokens.length) {
        protocol = tokens[idx] ?? null;
        idx++;
      }
    }

    // Parse "from [source]"
    let source: string | null = null;
    if (idx < tokens.length && tokens[idx] === "from") {
      idx++;
      const parsed = this.parseAddressSpec(tokens, idx);
      source = parsed.spec;
      idx = parsed.nextIdx;
    }

    // Parse "to [destination]"
    let destination: string | null = null;
    if (idx < tokens.length && tokens[idx] === "to") {
      idx++;
      const parsed = this.parseAddressSpec(tokens, idx);
      destination = parsed.spec;
      idx = parsed.nextIdx;
    }

    // Parse port (for rdr)
    let destinationPort: string | null = null;
    if (idx < tokens.length && tokens[idx] === "port") {
      idx++;
      const parsedPort = this.parsePortSpec(tokens, idx);
      destinationPort = parsedPort.port;
      idx = parsedPort.nextIdx;
    }

    // Parse "-> [target]"
    let target: string | null = null;
    if (idx < tokens.length && tokens[idx] === "->") {
      idx++;
      const parsed = this.parseAddressSpec(tokens, idx);
      target = parsed.spec;
      idx = parsed.nextIdx;
    }

    // Parse target port (for rdr)
    let translationPort: string | null = null;
    if (idx < tokens.length && tokens[idx] === "port") {
      idx++;
      const parsedPort = this.parsePortSpec(tokens, idx);
      translationPort = parsedPort.port;
      idx = parsedPort.nextIdx;
    }

    const ruleId = this.normalizeRuleId(
      interfaceName,
      ruleType,
      "any",
      source,
      destination || target,
      protocol,
      destinationPort,
      trimmed
    );

    const chain = interfaceName ? `chain:${interfaceName}` : "chain:default";

    const entity: FirewallRuleEntity = {
      id: ruleId,
      type: TwinEntityType.FIREWALL_RULE,
      displayName: `${ruleType} on ${interfaceName || "any"}`,
      source: context.source,
      collectedAt: context.collectedAt,
      data: {
        action: ruleType === "nat" ? "nat" : "rdr",
        direction: "any",
        interface: interfaceName,
        protocol,
        source,
        destination,
        destinationPort,
        translationTarget: target,
        translationPort,
        ruleType: ruleType === "nat" ? "nat" : "rdr",
        chain,
        enabled: true,
      },
    };

    return { entity };
  }

  /**
   * Tokenize a pfctl rule line, handling quoted strings and special characters.
   */
  private tokenize(line: string): string[] {
    const tokens: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === undefined) {
        continue;
      }
      if (char === '"' || char === "'") {
        inQuotes = !inQuotes;
        continue;
      }
      if (!inQuotes && /\s/.test(char)) {
        if (current) {
          tokens.push(current);
          current = "";
        }
        continue;
      }
      current += char;
    }
    if (current) {
      tokens.push(current);
    }
    return tokens;
  }

  /**
   * Parse a pfctl address spec starting at `startIdx`.
   *
   * pfctl can emit single tokens (e.g. "any", "192.168.1.0/24", "(em0)", "<alias>")
   * or sets like "{ 10.0.0.0/8, 172.16.0.0/22 }" which span multiple tokens.
   *
   * We return a string that preserves the full spec (so later stages can extract CIDRs),
   * and the next token index after the spec.
   */
  private parseAddressSpec(
    tokens: string[],
    startIdx: number
  ): { spec: string | null; nextIdx: number } {
    if (startIdx >= tokens.length) return { spec: null, nextIdx: startIdx };

    const first = tokens[startIdx];
    if (!first) return { spec: null, nextIdx: startIdx + 1 };

    // Multi-token set: "{ ... }" (sometimes "{foo" or "bar}" depending on spacing)
    if (first === "{" || first.startsWith("{")) {
      const parts: string[] = [];
      let i = startIdx;
      while (i < tokens.length) {
        const t = tokens[i];
        if (!t) {
          i++;
          continue;
        }
        parts.push(t);
        if (t.includes("}")) {
          i++;
          break;
        }
        i++;
      }
      return { spec: parts.join(" "), nextIdx: i };
    }

    // Default: single token
    return { spec: first, nextIdx: startIdx + 1 };
  }

  /**
   * Parse a pfctl port spec after the "port" token.
   *
   * Handles:
   * - "port 22"
   * - "port = ssh"
   * - "port = { ssh domain http }"
   */
  private parsePortSpec(
    tokens: string[],
    startIdx: number
  ): { port: string | null; nextIdx: number } {
    let idx = startIdx;

    // Optional comparators/equality symbols.
    while (
      idx < tokens.length &&
      ["=", "==", "!=", "<", ">", "<=", ">="].includes(tokens[idx] ?? "")
    ) {
      idx++;
    }

    if (idx >= tokens.length) {
      return { port: null, nextIdx: idx };
    }

    const token = tokens[idx];
    if (!token) {
      return { port: null, nextIdx: idx + 1 };
    }

    // Handle sets: "{ ssh domain http }"
    if (token === "{" || token.startsWith("{")) {
      const values: string[] = [];
      while (idx < tokens.length) {
        const current = tokens[idx];
        if (!current) {
          idx++;
          continue;
        }
        const cleaned = current.replace(/[{},]/g, "").trim();
        if (cleaned.length > 0) {
          values.push(cleaned);
        }
        idx++;
        if (current.includes("}")) {
          break;
        }
      }
      return {
        port: values.length > 0 ? values.join(",") : null,
        nextIdx: idx,
      };
    }

    // Single value (numeric or service alias)
    return {
      port: token.replace(/[,]/g, "").trim() || null,
      nextIdx: idx + 1,
    };
  }

  /**
   * Normalize a rule ID from its components.
   */
  private normalizeRuleId(
    interfaceName: string | null,
    action: string,
    direction: string,
    source: string | null,
    destination: string | null,
    protocol: string | null,
    port: string | null,
    rawLine?: string
  ): string {
    const parts = [
      "fw-rule",
      interfaceName || "any",
      action,
      direction,
      source || "any",
      destination || "any",
      protocol || "any",
      port || "any",
    ];
    const base = parts.join(":").toLowerCase().replace(/[^a-z0-9:._-]/g, "_");
    const hashInput = rawLine?.trim() || base;
    const hash = createHash("sha256").update(hashInput).digest("hex").slice(0, 10);
    return `${base}:${hash}`;
  }

  /**
   * Check if a string is a CIDR notation.
   */
  private isCidr(str: string): boolean {
    return /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(str) || /^[0-9a-f:]+::\/\d+$/i.test(str);
  }
}
