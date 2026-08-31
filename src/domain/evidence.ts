export const EVIDENCE_TYPES = [
  "crm_fact",
  "usage_fact",
  "derived_signal",
  "ai_inference",
  "external_evidence",
  "operator_sales_event",
  "operator_context",
  "unknown",
] as const;

export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export type EvidenceItem = {
  id: string;
  type: EvidenceType;
  claim: string;
  source: string;
  recordId?: string;
  field?: string;
  derivedFrom?: string[];
  observedAt?: string;
};

let evidenceSeq = 0;

export function evidence(item: Omit<EvidenceItem, "id"> & { id?: string }): EvidenceItem {
  evidenceSeq += 1;
  return { id: item.id ?? `ev-${evidenceSeq}`, ...item };
}

export function resetEvidenceIds(): void {
  evidenceSeq = 0;
}
