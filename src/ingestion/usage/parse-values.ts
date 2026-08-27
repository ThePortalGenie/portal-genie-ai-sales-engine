const TRUE_VALUES = new Set(["yes", "y", "true", "1", "connected", "paying", "paid", "partner", "active"]);
const FALSE_VALUES = new Set(["no", "n", "false", "0", "notconnected", "none", "unpaid", "notpaying"]);

export function parseBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (!value) return undefined;
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  return undefined;
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
