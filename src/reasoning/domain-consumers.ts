import type { Domain } from "./domain-taxonomy";

export type DomainConsumer =
  | "llmSchema"
  | "toolRegistration"
  | "fallbackClassifier"
  | "toolFirstRouting"
  | "retrievalDomainMatch"
  | "directQueryHandler"
  | "twinFirstChain"
  | "clarificationSuggestion"
  | "compositeQueries";

export type CoverageDecision =
  | { status: "supported" }
  | { status: "opt_out"; reason: string };

const supported = (): CoverageDecision => ({ status: "supported" });
const optOut = (reason: string): CoverageDecision => ({ status: "opt_out", reason });

/**
 * Reviewed coverage decisions for consumers that cannot be generated directly
 * from tool metadata. This record is deliberately exhaustive: a new Domain
 * cannot compile until every consumer has an explicit decision.
 */
export const DOMAIN_CONSUMER_COVERAGE = {
  compute: {
    llmSchema: supported(),
    toolRegistration: supported(),
    fallbackClassifier: supported(),
    toolFirstRouting: supported(),
    retrievalDomainMatch: supported(),
    directQueryHandler: supported(),
    twinFirstChain: supported(),
    clarificationSuggestion: supported(),
    compositeQueries: supported(),
  },
  network: {
    llmSchema: supported(),
    toolRegistration: supported(),
    fallbackClassifier: supported(),
    toolFirstRouting: supported(),
    retrievalDomainMatch: supported(),
    directQueryHandler: supported(),
    twinFirstChain: supported(),
    clarificationSuggestion: supported(),
    compositeQueries: supported(),
  },
  firewall: {
    llmSchema: supported(),
    toolRegistration: supported(),
    fallbackClassifier: supported(),
    toolFirstRouting: supported(),
    retrievalDomainMatch: supported(),
    directQueryHandler: supported(),
    twinFirstChain: supported(),
    clarificationSuggestion: supported(),
    compositeQueries: supported(),
  },
  metrics: {
    llmSchema: supported(),
    toolRegistration: supported(),
    fallbackClassifier: supported(),
    toolFirstRouting: supported(),
    retrievalDomainMatch: supported(),
    directQueryHandler: optOut("Metrics use LLM reasoning with live Proxmox tools."),
    twinFirstChain: optOut("Live metrics are intentionally fetched through tools, not the twin."),
    clarificationSuggestion: supported(),
    compositeQueries: supported(),
  },
  dns: {
    llmSchema: supported(),
    toolRegistration: supported(),
    fallbackClassifier: supported(),
    toolFirstRouting: supported(),
    retrievalDomainMatch: supported(),
    directQueryHandler: optOut("DNS dispatches through the LLM to pihole_readonly."),
    twinFirstChain: optOut("DNS is live Pi-hole data and has no digital-twin chain."),
    clarificationSuggestion: supported(),
    compositeQueries: supported(),
  },
  general: {
    llmSchema: supported(),
    toolRegistration: optOut("General conversation is not owned by an infrastructure tool."),
    fallbackClassifier: supported(),
    toolFirstRouting: optOut("General requests may use retrieval or reasoning."),
    retrievalDomainMatch: optOut("General retrieval accepts any source domain."),
    directQueryHandler: optOut("General requests use LLM reasoning."),
    twinFirstChain: optOut("General requests have no domain-specific twin chain."),
    clarificationSuggestion: optOut("General clarification uses the generic prompt."),
    compositeQueries: optOut("Composite infrastructure planning requires a concrete domain."),
  },
} satisfies Record<Domain, Record<DomainConsumer, CoverageDecision>>;

export const DOMAIN_CLARIFICATION_SUGGESTIONS = {
  compute: "Are you asking about VMs, containers, or nodes?",
  network: "Are you asking about network interfaces, subnets, or connectivity?",
  firewall: "Are you asking about firewall rules, chains, or exposure?",
  metrics: "Are you asking about temperature, CPU, memory, or status?",
  dns: "Are you asking about DNS records, query activity, clients, or blocking?",
  general: null,
} satisfies Record<Domain, string | null>;

