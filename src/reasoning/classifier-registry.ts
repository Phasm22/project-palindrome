import type { BaseTool } from "../tools/BaseTool";
import { loadTools } from "../agent/tool-loader";
import { DOMAINS, type Domain } from "./domain-taxonomy";

export interface DomainClassificationRegistration {
  domain: Domain;
  toolNames: readonly string[];
  triggerPatterns: readonly RegExp[];
  classificationExamples: readonly string[];
  retrievalKeywords: readonly string[];
  toolFirst: boolean;
  compositeEligible: boolean;
  priority: number;
}

export type ToolClassificationRegistry = Readonly<
  Record<Domain, DomainClassificationRegistration>
>;

/** Assemble classification behavior solely from loaded tool metadata. */
export function buildToolClassificationRegistry(
  tools: readonly BaseTool[]
): ToolClassificationRegistry {
  const mutable = Object.fromEntries(
    DOMAINS.map((domain) => [
      domain,
      {
        domain,
        toolNames: [] as string[],
        triggerPatterns: [] as RegExp[],
        classificationExamples: [] as string[],
        retrievalKeywords: [] as string[],
        toolFirst: false,
        compositeEligible: false,
        priority: 0,
      },
    ])
  ) as Record<Domain, {
    domain: Domain;
    toolNames: string[];
    triggerPatterns: RegExp[];
    classificationExamples: string[];
    retrievalKeywords: string[];
    toolFirst: boolean;
    compositeEligible: boolean;
    priority: number;
  }>;

  for (const tool of tools) {
    for (const declaration of tool.metadata.classification ?? []) {
      const registration = mutable[declaration.domain];
      registration.toolNames.push(tool.metadata.name);
      registration.triggerPatterns.push(...(declaration.triggerPatterns ?? []));
      registration.classificationExamples.push(...(declaration.classificationExamples ?? []));
      registration.retrievalKeywords.push(...(declaration.retrievalKeywords ?? []));
      registration.toolFirst ||= declaration.toolFirst === true;
      registration.compositeEligible ||= declaration.compositeEligible === true;
      registration.priority = Math.max(registration.priority, declaration.priority ?? 0);
    }
  }

  for (const domain of DOMAINS) {
    const registration = mutable[domain];
    registration.toolNames = [...new Set(registration.toolNames)];
    registration.retrievalKeywords = [...new Set(registration.retrievalKeywords)];
    registration.classificationExamples = [...new Set(registration.classificationExamples)];
  }

  return mutable;
}

let cachedRegistry: ToolClassificationRegistry | undefined;

/** The startup registry used by classification and routing consumers. */
export function getToolClassificationRegistry(): ToolClassificationRegistry {
  cachedRegistry ??= buildToolClassificationRegistry(loadTools());
  return cachedRegistry;
}

export function getToolFirstDomains(
  registry: ToolClassificationRegistry = getToolClassificationRegistry()
): Domain[] {
  return DOMAINS.filter((domain) => registry[domain].toolFirst);
}

export function getCompositeEligibleDomains(
  registry: ToolClassificationRegistry = getToolClassificationRegistry()
): Domain[] {
  return DOMAINS.filter((domain) => registry[domain].compositeEligible);
}

/**
 * Deterministic domain classification. Tool-defined priority resolves broad
 * overlaps (for example DNS terms before the broader network vocabulary).
 */
export function inferDomainFromToolRegistry(
  input: string,
  registry: ToolClassificationRegistry = getToolClassificationRegistry()
): Domain {
  const ordered = DOMAINS
    .map((domain, taxonomyOrder) => ({ ...registry[domain], taxonomyOrder }))
    .sort((left, right) => right.priority - left.priority || left.taxonomyOrder - right.taxonomyOrder);

  for (const registration of ordered) {
    for (const pattern of registration.triggerPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(input)) return registration.domain;
    }
  }
  return "general";
}
