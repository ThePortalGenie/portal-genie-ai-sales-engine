import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeDomain } from "../domain/normalize-identity.js";
import type { OrganisationCluster } from "../domain/commercial-watch.js";

export type FirstPartyDomainConfig = {
  domains: string[];
  notes?: string;
};

export const DEFAULT_FIRST_PARTY_DOMAINS = ["theportalgenie.com", "naggingpanda.com"] as const;

export function loadFirstPartyDomains(cwd = process.cwd()): Set<string> {
  const filePath = resolve(cwd, "config/first-party-domains.json");
  if (!existsSync(filePath)) {
    return new Set(DEFAULT_FIRST_PARTY_DOMAINS);
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as FirstPartyDomainConfig;
    const domains = (parsed.domains?.length ? parsed.domains : [...DEFAULT_FIRST_PARTY_DOMAINS])
      .map((domain) => normalizeDomain(domain))
      .filter(Boolean);
    return new Set(domains);
  } catch {
    return new Set(DEFAULT_FIRST_PARTY_DOMAINS);
  }
}

export function isFirstPartyDomain(domain: string | undefined, firstPartyDomains: Set<string>): boolean {
  if (!domain) return false;
  return firstPartyDomains.has(normalizeDomain(domain));
}

/**
 * True when every non-public business domain on the cluster is first-party.
 * Does not discard records; used to keep internal organisations out of the customer queue.
 */
export function isFirstPartyOrganisation(
  cluster: OrganisationCluster,
  firstPartyDomains: Set<string>,
  publicDomains: Set<string>,
): boolean {
  const businessDomains = cluster.domains.filter(
    (domain) => domain && !publicDomains.has(normalizeDomain(domain)) && isFirstPartyDomain(domain, firstPartyDomains),
  );
  if (businessDomains.length === 0) return false;
  const nonPublicDomains = cluster.domains.filter((domain) => domain && !publicDomains.has(normalizeDomain(domain)));
  return nonPublicDomains.length > 0 && nonPublicDomains.every((domain) => isFirstPartyDomain(domain, firstPartyDomains));
}
