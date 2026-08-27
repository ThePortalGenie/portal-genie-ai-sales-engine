export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    ?.replace(/:\d+$/, "") ?? "";
}

export function domainFromEmail(email: string): string | undefined {
  const at = normalizeEmail(email).split("@")[1];
  return at || undefined;
}

export function normalizeCompanyName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[.,'"()/\\]/g, " ")
    .replace(/\b(ltd|limited|pty|llc|inc|incorporated|co|company|plc|llp)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function levenshteinRatio(left: string, right: string): number {
  if (left === right) return 1;
  if (!left.length || !right.length) return 0;
  const a = left;
  const b = right;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix: number[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 0));
  for (let i = 0; i < rows; i += 1) {
    matrix[i]![0] = i;
  }
  for (let j = 0; j < cols; j += 1) {
    matrix[0]![j] = j;
  }
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1,
        matrix[i]![j - 1]! + 1,
        matrix[i - 1]![j - 1]! + cost,
      );
    }
  }
  const distance = matrix[a.length]![b.length]!;
  return 1 - distance / Math.max(a.length, b.length);
}
