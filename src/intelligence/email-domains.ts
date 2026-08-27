import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { domainFromEmail, normalizeDomain, normalizeEmail } from "../domain/normalize-identity.js";

export type PublicDomainConfig = {
  domains: string[];
};

const DEFAULT_PUBLIC_DOMAINS = [
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
];

export const GENERIC_MAILBOXES = new Set([
  "info",
  "admin",
  "accounts",
  "support",
  "hello",
  "enquiries",
  "sales",
  "office",
  "contact",
]);

export function loadPublicEmailDomains(cwd = process.cwd()): Set<string> {
  const filePath = resolve(cwd, "config/public-email-domains.json");
  if (!existsSync(filePath)) {
    return new Set(DEFAULT_PUBLIC_DOMAINS);
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as PublicDomainConfig;
    return new Set((parsed.domains ?? []).map((domain) => normalizeDomain(domain)).filter(Boolean));
  } catch {
    return new Set(DEFAULT_PUBLIC_DOMAINS);
  }
}

export function isPublicEmailDomain(domain: string | undefined, publicDomains: Set<string>): boolean {
  if (!domain) return false;
  return publicDomains.has(normalizeDomain(domain));
}

export function mailboxLocalPart(email: string): string {
  return normalizeEmail(email).split("@")[0] ?? "";
}

export function isGenericMailbox(email: string): boolean {
  return GENERIC_MAILBOXES.has(mailboxLocalPart(email));
}

export function organisationDomainFromEmail(
  email: string,
  publicDomains: Set<string>,
): string | undefined {
  const domain = domainFromEmail(email);
  if (!domain || isPublicEmailDomain(domain, publicDomains)) return undefined;
  return domain;
}
