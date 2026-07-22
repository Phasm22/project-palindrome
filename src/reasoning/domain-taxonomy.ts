/**
 * The only declaration of classification domains in the repository.
 *
 * Consumers must derive schemas, records, and coverage checks from this tuple.
 * Adding a domain here intentionally causes the completeness tests and typed
 * domain-policy records to fail until the new domain is reviewed everywhere.
 */
export const DOMAINS = [
  "compute",
  "network",
  "firewall",
  "metrics",
  "dns",
  "general",
] as const;

export type Domain = (typeof DOMAINS)[number];

const DOMAIN_SET: ReadonlySet<string> = new Set(DOMAINS);

export function isDomain(value: string): value is Domain {
  return DOMAIN_SET.has(value);
}

