import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_COMMAND_CENTRE_THRESHOLDS,
  type CommandCentreThresholds,
} from "../domain/commercial-watch.js";

export function loadCommandCentreThresholds(cwd = process.cwd()): CommandCentreThresholds {
  const filePath = resolve(cwd, "config/command-centre.json");
  if (!existsSync(filePath)) return DEFAULT_COMMAND_CENTRE_THRESHOLDS;
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<CommandCentreThresholds>;
  return { ...DEFAULT_COMMAND_CENTRE_THRESHOLDS, ...parsed };
}
