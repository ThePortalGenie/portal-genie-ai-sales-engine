const TRUE_VALUES = new Set(["yes", "y", "true", "1", "connected", "paying", "paid", "partner", "active"]);
const FALSE_VALUES = new Set(["no", "n", "false", "0", "notconnected", "none", "unpaid", "notpaying"]);

export function parseBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (!value || value === "unknown" || value === "n/a" || value === "na" || value === "null") return undefined;
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  return undefined;
}

export type ParsedField<T> = {
  presence: "present" | "zero" | "unknown" | "invalid";
  value?: T;
  warning?: string;
};

const UNKNOWN_TOKENS = new Set(["", "unknown", "n/a", "na", "null", "-"]);

export function parseNumericField(raw: string | undefined, label: string): ParsedField<number> {
  if (raw === undefined) return { presence: "unknown" };
  const value = raw.trim().replace(/,/g, "");
  if (UNKNOWN_TOKENS.has(value.toLowerCase())) return { presence: "unknown" };
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return { presence: "invalid", warning: `${label} value "${raw.trim()}" is not a number and was not converted to zero.` };
  }
  if (parsed === 0) return { presence: "zero", value: 0 };
  return { presence: "present", value: parsed };
}

export function parseDateField(raw: string | undefined, label: string): ParsedField<string> {
  if (raw === undefined) return { presence: "unknown" };
  const value = raw.trim();
  if (UNKNOWN_TOKENS.has(value.toLowerCase())) return { presence: "unknown" };
  const parsed = parseDate(value);
  if (!parsed) {
    return { presence: "invalid", warning: `${label} value "${value}" is not a usable date.` };
  }
  return { presence: "present", value: parsed };
}

export function parseAccountingPlatform(raw: string | undefined): ParsedField<string> {
  if (raw === undefined) return { presence: "unknown" };
  const value = raw.trim();
  if (UNKNOWN_TOKENS.has(value.toLowerCase())) return { presence: "unknown" };
  const normalised = value.toLowerCase().replace(/[\s_-]+/g, "");
  if (normalised === "xero") return { presence: "present", value: "xero" };
  if (normalised.includes("quick")) return { presence: "present", value: "quickbooks" };
  if (normalised.includes("sage")) return { presence: "present", value: "sage_business_cloud" };
  if (normalised === "other") return { presence: "present", value: "other" };
  if (normalised === "none" || normalised === "notconnected") return { presence: "present", value: "none" };
  return { presence: "present", value: "other" };
}

const UNIT_MULTIPLIERS: Record<string, number> = {
  b: 1,
  byte: 1,
  bytes: 1,
  kb: 1024,
  kib: 1024,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
  tb: 1024 ** 4,
};

export function parseQuantityField(
  raw: string | undefined,
  label: string,
): ParsedField<{ value: number; unit: string; original: string; bytes?: number }> {
  if (raw === undefined) return { presence: "unknown" };
  const original = raw.trim();
  if (UNKNOWN_TOKENS.has(original.toLowerCase())) return { presence: "unknown" };
  const match = original.match(/^(-?[\d,.]+)\s*([a-zA-Z]+)?$/);
  if (!match) {
    return { presence: "invalid", warning: `${label} value "${original}" is not a quantity and was not converted to zero.` };
  }
  const amount = Number(match[1]!.replace(/,/g, ""));
  if (!Number.isFinite(amount)) {
    return { presence: "invalid", warning: `${label} value "${original}" is not a number and was not converted to zero.` };
  }
  const unitRaw = (match[2] ?? "").trim();
  const unit = unitRaw || "unknown";
  const multiplier = unitRaw ? UNIT_MULTIPLIERS[unitRaw.toLowerCase()] : undefined;
  const parsed = {
    value: amount,
    unit,
    original,
    bytes: multiplier !== undefined ? amount * multiplier : undefined,
  };
  if (amount === 0) return { presence: "zero", value: parsed };
  return { presence: "present", value: parsed };
}

export function parseNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().replace(/,/g, "");
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseDate(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!value) return undefined;

  const serial = Number(value);
  if (Number.isFinite(serial) && serial > 20000 && serial < 80000 && !value.includes("-") && !value.includes("/")) {
    const utc = Date.UTC(1899, 11, 30) + serial * 86_400_000;
    return new Date(utc).toISOString().slice(0, 10);
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed).toISOString().slice(0, 10);
}

export function parseText(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}
