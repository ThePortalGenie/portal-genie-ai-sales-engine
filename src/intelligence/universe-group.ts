import { organisationKey } from "../domain/sales-event.js";
import type { OrganisationCluster, UniverseRecord } from "../domain/commercial-watch.js";
import { organisationDomainFromEmail } from "./email-domains.js";
import { normalizeCompanyName } from "../domain/normalize-identity.js";

function latest(values: Array<string | undefined>): string | undefined {
  return values
    .filter((item): item is string => Boolean(item) && !Number.isNaN(Date.parse(item!)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}

class UnionFind {
  private parent = new Map<string, string>();

  id(key: string): string {
    if (!this.parent.has(key)) this.parent.set(key, key);
    return key;
  }

  find(key: string): string {
    this.id(key);
    const parent = this.parent.get(key)!;
    if (parent !== key) {
      const root = this.find(parent);
      this.parent.set(key, root);
      return root;
    }
    return key;
  }

  union(left: string, right: string): void {
    const a = this.find(left);
    const b = this.find(right);
    if (a !== b) this.parent.set(a, b);
  }
}

function recordKey(record: UniverseRecord): string {
  return `${record.module}:${record.recordId}`;
}

function preferredRepresentative(records: UniverseRecord[]): OrganisationCluster["representative"] {
  const people = records.filter((item) => item.module === "Contacts" || item.module === "Leads");
  const accounts = records.filter((item) => item.module === "Accounts");
  const sorted = [...(people.length ? people : accounts.length ? accounts : records.filter((item) => item.module !== "Deals"))].sort((left, right) => {
    if (left.module === "Contacts" && right.module !== "Contacts") return -1;
    if (right.module === "Contacts" && left.module !== "Contacts") return 1;
    return Date.parse(right.lastActivityAt ?? right.modifiedAt ?? "1970-01-01") - Date.parse(left.lastActivityAt ?? left.modifiedAt ?? "1970-01-01");
  });
  const pick = sorted[0] ?? records[0]!;
  if (pick.module === "Deals") {
    if (pick.accountId) return { module: "Accounts", recordId: pick.accountId, name: pick.accountName ?? pick.name };
    if (pick.contactId) return { module: "Contacts", recordId: pick.contactId, name: pick.name };
  }
  return {
    module: pick.module === "Deals" ? "Contacts" : pick.module,
    recordId: pick.recordId,
    name: pick.name,
  };
}

/**
 * Strong associations only. Same Account, same non-public domain, Deal→Account,
 * Deal→Contact, exact email. Exact company name is review-only and does not merge.
 */
export function groupUniverseRecords(
  records: UniverseRecord[],
  publicDomains: Set<string>,
): OrganisationCluster[] {
  const usable = records.filter((item) => item.retrieval === "RETRIEVED");
  const uf = new UnionFind();
  const byEmail = new Map<string, string>();
  const byDomain = new Map<string, string>();
  const byAccount = new Map<string, string>();

  for (const record of usable) {
    const key = recordKey(record);
    uf.id(key);
    if (record.accountId) {
      const existing = byAccount.get(record.accountId);
      if (existing) uf.union(existing, key);
      byAccount.set(record.accountId, key);
    }
    if (record.contactId) {
      const contactKey = usable.find((item) => item.module !== "Deals" && item.recordId === record.contactId);
      if (contactKey) uf.union(key, recordKey(contactKey));
    }
    const email = record.email?.trim().toLowerCase();
    if (email) {
      const existing = byEmail.get(email);
      if (existing) uf.union(existing, key);
      byEmail.set(email, key);
      const domain = organisationDomainFromEmail(email, publicDomains) ?? undefined;
      if (domain) {
        const prior = byDomain.get(domain);
        if (prior) uf.union(prior, key);
        byDomain.set(domain, key);
      }
    }
  }

  const buckets = new Map<string, UniverseRecord[]>();
  for (const record of usable) {
    const root = uf.find(recordKey(record));
    const list = buckets.get(root) ?? [];
    list.push(record);
    buckets.set(root, list);
  }

  const clusters: OrganisationCluster[] = [];
  const possibleByCompany = new Map<string, OrganisationCluster[]>();

  for (const members of buckets.values()) {
    const domains = [
      ...new Set(
        members
          .map((item) => (item.email ? organisationDomainFromEmail(item.email, publicDomains) : undefined))
          .filter((item): item is string => Boolean(item)),
      ),
    ].sort();
    const accountIds = [...new Set(members.map((item) => item.accountId).filter((item): item is string => Boolean(item)))];
    const representative = preferredRepresentative(members);
    const organisationId = organisationKey({
      domains,
      zohoAccountId: accountIds[0],
      selectedModule: representative.module,
      selectedRecordId: representative.recordId,
    });
    const names = members.map((item) => item.company || (item.module === "Accounts" ? item.name : undefined)).filter(Boolean);
    const organisationName =
      members.find((item) => item.accountName)?.accountName ||
      names[0] ||
      representative.name;
    const cluster: OrganisationCluster = {
      organisationId,
      organisationName: String(organisationName),
      domains,
      accountIds,
      records: members,
      possibleMatchReviews: [],
      representative,
      lastActivityAt: latest(members.map((item) => item.lastActivityAt)),
      lastModifiedAt: latest(members.map((item) => item.modifiedAt)),
    };
    clusters.push(cluster);
    const company = normalizeCompanyName(String(organisationName));
    if (company.length >= 4) {
      const list = possibleByCompany.get(company) ?? [];
      list.push(cluster);
      possibleByCompany.set(company, list);
    }
  }

  for (const [company, list] of possibleByCompany) {
    if (list.length < 2) continue;
    const domainSets = list.map((item) => item.domains.join(","));
    const distinct = new Set(domainSets.filter(Boolean));
    if (distinct.size <= 1 && list.every((item) => item.domains[0] && item.domains[0] === list[0]?.domains[0])) {
      continue;
    }
    for (const cluster of list) {
      for (const other of list) {
        if (other === cluster) continue;
        if (cluster.organisationId === other.organisationId) continue;
        cluster.possibleMatchReviews.push({
          recordId: other.representative.recordId,
          name: other.organisationName,
          reason: `Exact company name "${company}" also appears on another organisation cluster. POSSIBLE_MATCH_REVIEW — not merged.`,
        });
      }
    }
  }

  return clusters.sort((left, right) => left.organisationName.localeCompare(right.organisationName));
}
