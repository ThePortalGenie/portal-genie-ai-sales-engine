import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { mapHeader } from "./column-map.js";
import { parseCsv } from "./parse-csv.js";
import { normalizeUsageRecords, rowsToRawRecords } from "./normalize.js";
import type { NormalizedUsageProfile, UsageIngestionKind } from "../../domain/normalized-usage.js";

export type UsageImportResult = {
  profiles: NormalizedUsageProfile[];
  accepted: NormalizedUsageProfile[];
  rejected: NormalizedUsageProfile[];
  headers: string[];
  mappedHeaders: string[];
  unmappedHeaders: string[];
  rowCount: number;
  acceptedCount: number;
  rejectedCount: number;
  warnings: string[];
};

function kindFromPath(filePath: string): UsageIngestionKind {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".csv") return "csv";
  if (extension === ".xlsx" || extension === ".xls") return "xlsx";
  throw new Error(`Unsupported usage file type '${extension}'. Use .csv or .xlsx.`);
}

export async function readUsageTable(filePath: string): Promise<{ headers: string[]; rows: string[][] }> {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".csv") {
    return parseCsv(readFileSync(filePath, "utf8"));
  }
  if (extension === ".xlsx" || extension === ".xls") {
    const { readXlsxTable } = await import("./read-xlsx.js");
    return readXlsxTable(filePath);
  }
  throw new Error(`Unsupported usage file type '${extension}'. Use .csv or .xlsx.`);
}

export async function importUsageFile(filePath: string): Promise<UsageImportResult> {
  const { headers, rows } = await readUsageTable(filePath);
  const records = rowsToRawRecords(headers, rows);
  const profiles = normalizeUsageRecords(records, {
    kind: kindFromPath(filePath),
    fileName: filePath,
  });
  const mappedHeaders = headers.filter((header) => mapHeader(header));
  const unmappedHeaders = headers.filter((header) => !mapHeader(header));
  const accepted = profiles.filter((profile) => profile.accepted);
  const rejected = profiles.filter((profile) => !profile.accepted);
  const warnings = profiles.flatMap((profile) => profile.warnings);
  return {
    profiles,
    accepted,
    rejected,
    headers,
    mappedHeaders,
    unmappedHeaders,
    rowCount: profiles.length,
    acceptedCount: accepted.length,
    rejectedCount: rejected.length,
    warnings,
  };
}
