import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { PortfolioSnapshot, ScanEstimate } from "../domain/commercial-watch.js";

const FILE = () =>
  resolve(process.env.COMMAND_CENTRE_STORE?.trim() || resolve(process.cwd(), "diagnostics/command-centre.json"));

type StoreShape = {
  snapshot?: PortfolioSnapshot;
  lastScan?: ScanEstimate;
};

function readStore(): StoreShape {
  if (!existsSync(FILE())) return {};
  try {
    return JSON.parse(readFileSync(FILE(), "utf8")) as StoreShape;
  } catch {
    return {};
  }
}

function writeStore(store: StoreShape): void {
  mkdirSync(dirname(FILE()), { recursive: true });
  writeFileSync(FILE(), `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

export function readPortfolioSnapshot(): PortfolioSnapshot | undefined {
  return readStore().snapshot;
}

export function readLastScan(): ScanEstimate | undefined {
  return readStore().lastScan;
}

export function writePortfolioSnapshot(snapshot: PortfolioSnapshot): PortfolioSnapshot {
  const store = readStore();
  store.snapshot = snapshot;
  writeStore(store);
  return snapshot;
}

export function writeLastScan(scan: ScanEstimate): ScanEstimate {
  const store = readStore();
  store.lastScan = scan;
  writeStore(store);
  return scan;
}
