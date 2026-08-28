import { createHash } from "node:crypto";

export function evidenceFingerprint(parts: Array<string | number | boolean | undefined | null>): string {
  const hash = createHash("sha256");
  hash.update(
    parts
      .map((part) => (part === undefined || part === null ? "" : String(part)))
      .join("\n"),
  );
  return hash.digest("hex").slice(0, 32);
}

export function clusterFingerprint(input: {
  organisationId: string;
  recordKeys: string[];
  lastModifiedAt?: string;
  lastActivityAt?: string;
  salesEventStamp?: string;
  usageImportedAt?: string;
}): string {
  return evidenceFingerprint([
    input.organisationId,
    ...[...input.recordKeys].sort(),
    input.lastModifiedAt,
    input.lastActivityAt,
    input.salesEventStamp,
    input.usageImportedAt,
  ]);
}
