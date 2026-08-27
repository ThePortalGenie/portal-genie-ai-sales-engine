import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  parseSalesEventInput,
  SalesEventValidationError,
  type SalesEvent,
  type SalesEventInput,
} from "../domain/sales-event.js";

const FILE = () =>
  resolve(process.env.SALES_EVENTS_STORE?.trim() || resolve(process.cwd(), "diagnostics/sales-events.json"));

type StoreShape = { events: SalesEvent[] };

function readStore(): StoreShape {
  const filePath = FILE();
  if (!existsSync(filePath)) return { events: [] };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as StoreShape;
    return { events: Array.isArray(parsed.events) ? parsed.events : [] };
  } catch {
    return { events: [] };
  }
}

function writeStore(store: StoreShape): void {
  const filePath = FILE();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

export function listSalesEvents(filter: { organisationIds?: string[]; contactIds?: string[] } = {}): SalesEvent[] {
  const events = readStore().events;
  const orgIds = new Set(filter.organisationIds ?? []);
  const contactIds = new Set(filter.contactIds ?? []);
  return events
    .filter((event) => {
      if (orgIds.size === 0 && contactIds.size === 0) return true;
      if (orgIds.has(event.organisation_id)) return true;
      if (event.contact_id && contactIds.has(event.contact_id)) return true;
      return false;
    })
    .sort((left, right) => Date.parse(right.occurred_at) - Date.parse(left.occurred_at));
}

export function getSalesEvent(id: string): SalesEvent | undefined {
  return readStore().events.find((event) => event.id === id);
}

export function createSalesEvent(input: SalesEventInput): SalesEvent {
  const event = parseSalesEventInput(input);
  const store = readStore();
  store.events.push(event);
  writeStore(store);
  return event;
}

export function updateSalesEvent(id: string, input: SalesEventInput): SalesEvent {
  const store = readStore();
  const index = store.events.findIndex((event) => event.id === id);
  if (index < 0) throw new SalesEventValidationError("Sales Event not found");
  const existing = store.events[index]!;
  if (existing.source !== "OPERATOR_ENTERED_SALES_EVENT") {
    throw new SalesEventValidationError("Only operator-entered Sales Events can be edited");
  }
  const updated = parseSalesEventInput({ ...input, organisation_id: input.organisation_id ?? existing.organisation_id }, existing);
  store.events[index] = updated;
  writeStore(store);
  return updated;
}

export function deleteSalesEvent(id: string): SalesEvent {
  const store = readStore();
  const index = store.events.findIndex((event) => event.id === id);
  if (index < 0) throw new SalesEventValidationError("Sales Event not found");
  const existing = store.events[index]!;
  if (existing.source !== "OPERATOR_ENTERED_SALES_EVENT") {
    throw new SalesEventValidationError("Only operator-entered Sales Events can be deleted");
  }
  store.events.splice(index, 1);
  writeStore(store);
  return existing;
}
