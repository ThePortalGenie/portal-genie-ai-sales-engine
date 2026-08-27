import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

export function upsertEnvValue(filePath: string, key: string, value: string): void {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n]/.test(value)) {
    throw new Error("Refusing to write an unsafe environment value.");
  }
  if (!existsSync(filePath)) {
    writeFileSync(filePath, `${key}=${value}\n`, "utf8");
    return;
  }
  const current = readFileSync(filePath, "utf8");
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(current)) {
    writeFileSync(filePath, current.replace(pattern, `${key}=${value}`), "utf8");
    return;
  }
  appendFileSync(filePath, `\n${key}=${value}\n`, "utf8");
}
