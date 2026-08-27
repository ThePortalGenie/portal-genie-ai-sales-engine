import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCommercialProfile, openaiStatus, recordOperatorFeedback, runCommercialAnalysis } from "../services/intelligence-runtime.js";
import { zohoRuntime } from "../services/zoho-runtime.js";
import { SalesEventValidationError } from "../domain/sales-event.js";
import { createSalesEvent, deleteSalesEvent, listSalesEvents, updateSalesEvent } from "../intelligence/sales-event-store.js";
import { buildRelationshipView } from "../web/relationship-view.js";
import { usageOverlayForDiagnostic } from "../web/usage-overlay.js";
import { publicErrorMessage, redactSecrets } from "../security/redact.js";
import { PRIMARY_MODULES } from "../integrations/zoho/constants.js";
import { parseCsv } from "../ingestion/usage/parse-csv.js";
import { normalizeUsageRecords, rowsToRawRecords } from "../ingestion/usage/normalize.js";
import { combineAccountIntelligence } from "../domain/account-intelligence.js";
import { loadActivationThresholds } from "../config/activation-thresholds.js";

const PUBLIC_DIR = resolve(fileURLToPath(new URL("../web/public", import.meta.url)));
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const hits = new Map<string, { count: number; windowStart: number }>();

function rateLimit(req: IncomingMessage): boolean {
  const ip = req.socket.remoteAddress ?? "local";
  const now = Date.now();
  const current = hits.get(ip);
  if (!current || now - current.windowStart > 60_000) {
    hits.set(ip, { count: 1, windowStart: now });
    return true;
  }
  current.count += 1;
  return current.count <= 60;
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8"): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, error: unknown): void {
  send(res, status, { error: publicErrorMessage(error) });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) {
      throw new Error("Request too large");
    }
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON object required");
  }
  return parsed as Record<string, unknown>;
}

function queryOf(url: URL): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    output[key] = value;
  }
  return output;
}

function isPrimaryModule(value: string): value is (typeof PRIMARY_MODULES)[number] {
  return (PRIMARY_MODULES as readonly string[]).includes(value);
}

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const host = req.headers.host ?? "127.0.0.1";
  const url = new URL(req.url ?? "/", `http://${host}`);
  const method = req.method ?? "GET";

  if (!rateLimit(req)) {
    send(res, 429, { error: "Too many requests" });
    return;
  }

  try {
    if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      servePublic(res, "index.html");
      return;
    }
    if (method === "GET" && url.pathname.startsWith("/assets/")) {
      servePublic(res, url.pathname.slice("/assets/".length));
      return;
    }

    if (method === "GET" && url.pathname === "/api/zoho/status") {
      send(res, 200, await zohoRuntime.connectionStatus());
      return;
    }

    if (method === "POST" && url.pathname === "/api/zoho/test") {
      send(res, 200, await zohoRuntime.connectionStatus());
      return;
    }

    if (method === "POST" && url.pathname === "/api/zoho/connect") {
      const body = await readJson(req);
      const code = typeof body.grantCode === "string" ? body.grantCode.trim() : "";
      if (!code) {
        send(res, 400, { error: "grantCode is required" });
        return;
      }
      send(res, 200, await zohoRuntime.connectWithGrantCode(code));
      return;
    }

    if (method === "GET" && url.pathname === "/api/zoho/oauth/start") {
      res.writeHead(302, { Location: zohoRuntime.oauthStartUrl(), "Cache-Control": "no-store" });
      res.end();
      return;
    }

    if (method === "GET" && url.pathname === "/api/zoho/oauth/callback") {
      const state = url.searchParams.get("state") ?? "";
      const code = url.searchParams.get("code") ?? "";
      if (!zohoRuntime.consumeOAuthState(state) || !code) {
        res.writeHead(302, { Location: "/#settings?oauth=error", "Cache-Control": "no-store" });
        res.end();
        return;
      }
      try {
        await zohoRuntime.connectWithGrantCode(code);
        res.writeHead(302, { Location: "/#settings?oauth=connected", "Cache-Control": "no-store" });
        res.end();
      } catch {
        res.writeHead(302, { Location: "/#settings?oauth=error", "Cache-Control": "no-store" });
        res.end();
      }
      return;
    }

    if (method === "GET" && url.pathname === "/api/crm/search") {
      const q = queryOf(url).q ?? "";
      send(res, 200, await zohoRuntime.search(q));
      return;
    }

    if (method === "GET" && url.pathname === "/api/crm/relationship") {
      const moduleName = queryOf(url).module ?? "";
      const id = queryOf(url).id ?? "";
      if (!isPrimaryModule(moduleName) || !/^\d{10,}$/.test(id)) {
        send(res, 400, { error: "Valid module and Zoho record id are required." });
        return;
      }
      const diagnostic = await zohoRuntime.discover(moduleName, id);
      send(res, 200, {
        view: buildRelationshipView(diagnostic),
        usage: usageOverlayForDiagnostic(diagnostic),
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/crm/diagnostic") {
      const moduleName = queryOf(url).module ?? "";
      const id = queryOf(url).id ?? "";
      if (!isPrimaryModule(moduleName) || !/^\d{10,}$/.test(id)) {
        send(res, 400, { error: "Valid module and Zoho record id are required." });
        return;
      }
      const diagnostic = await zohoRuntime.discover(moduleName, id);
      send(res, 200, redactSecrets(diagnostic));
      return;
    }

    if (method === "GET" && url.pathname === "/api/crm/email") {
      const { module: moduleName, id, messageId, userId } = queryOf(url);
      if (!moduleName || !isPrimaryModule(moduleName) || !id || !messageId) {
        send(res, 400, { error: "module, id and messageId are required." });
        return;
      }
      send(res, 200, await zohoRuntime.emailBody(moduleName, id, messageId, userId));
      return;
    }

    if (method === "GET" && url.pathname === "/api/usage/status") {
      send(res, 200, usageStatus());
      return;
    }

    if (method === "POST" && url.pathname === "/api/usage/import-csv") {
      const body = await readJson(req);
      const csv = typeof body.csv === "string" ? body.csv : "";
      const fileName = typeof body.fileName === "string" ? body.fileName : "upload.csv";
      if (!csv.trim()) {
        send(res, 400, { error: "csv text is required" });
        return;
      }
      send(res, 200, importCsvText(csv, fileName));
      return;
    }

    if (method === "GET" && url.pathname === "/api/intelligence/status") {
      send(res, 200, openaiStatus());
      return;
    }

    if (method === "GET" && url.pathname === "/api/intelligence/profile") {
      const moduleName = queryOf(url).module ?? "";
      const id = queryOf(url).id ?? "";
      if (!isPrimaryModule(moduleName) || !/^\d{10,}$/.test(id)) {
        send(res, 400, { error: "Valid module and Zoho record id are required." });
        return;
      }
      const stored = loadCommercialProfile(moduleName, id);
      send(res, 200, stored ? { analysed: true, analysis: stored } : { analysed: false });
      return;
    }

    if (method === "POST" && url.pathname === "/api/intelligence/analyse") {
      const body = await readJson(req);
      const moduleName = typeof body.module === "string" ? body.module : "";
      const id = typeof body.id === "string" ? body.id : "";
      if (!isPrimaryModule(moduleName) || !/^\d{10,}$/.test(id)) {
        send(res, 400, { error: "Valid module and Zoho record id are required." });
        return;
      }
      const analysis = await runCommercialAnalysis({
        module: moduleName,
        recordId: id,
        force: body.force === true,
      });
      send(res, 200, { analysed: analysis.success, analysis });
      return;
    }

    if (method === "POST" && url.pathname === "/api/intelligence/feedback") {
      const body = await readJson(req);
      const moduleName = typeof body.module === "string" ? body.module : "";
      const id = typeof body.id === "string" ? body.id : "";
      const verdict = typeof body.verdict === "string" ? body.verdict : "";
      const notes = typeof body.notes === "string" ? body.notes : undefined;
      if (!isPrimaryModule(moduleName) || !/^\d{10,}$/.test(id)) {
        send(res, 400, { error: "Valid module and Zoho record id are required." });
        return;
      }
      send(res, 200, recordOperatorFeedback({ module: moduleName, recordId: id, verdict, notes }));
      return;
    }

    if (method === "GET" && url.pathname === "/api/sales-events") {
      const organisationIds = (queryOf(url).organisationId ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      const contactIds = (queryOf(url).contactIds ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      send(res, 200, {
        events: listSalesEvents({ organisationIds, contactIds }),
        writtenToZoho: false,
      });
      return;
    }

    if (method === "POST" && url.pathname === "/api/sales-events") {
      const body = await readJson(req);
      try {
        const event = createSalesEvent(body);
        send(res, 201, { event, writtenToZoho: false });
      } catch (error) {
        if (error instanceof SalesEventValidationError) {
          send(res, 400, { error: error.message });
          return;
        }
        throw error;
      }
      return;
    }

    const salesEventMatch = url.pathname.match(/^\/api\/sales-events\/([^/]+)$/);
    if (salesEventMatch) {
      const eventId = decodeURIComponent(salesEventMatch[1] ?? "");
      if (method === "PATCH") {
        const body = await readJson(req);
        try {
          const event = updateSalesEvent(eventId, body);
          send(res, 200, { event, writtenToZoho: false });
        } catch (error) {
          if (error instanceof SalesEventValidationError) {
            send(res, 400, { error: error.message });
            return;
          }
          throw error;
        }
        return;
      }
      if (method === "DELETE") {
        try {
          const event = deleteSalesEvent(eventId);
          send(res, 200, { event, writtenToZoho: false, deleted: true });
        } catch (error) {
          if (error instanceof SalesEventValidationError) {
            send(res, 400, { error: error.message });
            return;
          }
          throw error;
        }
        return;
      }
    }

    send(res, 404, { error: "Not found" });
  } catch (error) {
    sendError(res, 500, error);
  }
}

function servePublic(res: ServerResponse, relativePath: string): void {
  const safe = normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = join(PUBLIC_DIR, safe);
  const rel = relative(PUBLIC_DIR, filePath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    send(res, 404, { error: "Not found" });
    return;
  }
  const type = MIME[extname(filePath)] ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'",
  });
  createReadStream(filePath).pipe(res);
}

function usageStatus(): { imported: boolean; rowCount: number; file?: string } {
  const filePath = resolve(process.cwd(), "diagnostics/usage-import.json");
  if (!existsSync(filePath)) return { imported: false, rowCount: 0 };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { counts?: { rows?: number }; source?: string };
    return { imported: true, rowCount: parsed.counts?.rows ?? 0, file: parsed.source };
  } catch {
    return { imported: false, rowCount: 0 };
  }
}

function importCsvText(csv: string, fileName: string) {
  const parsed = parseCsv(csv);
  const records = rowsToRawRecords(parsed.headers, parsed.rows);
  const profiles = normalizeUsageRecords(records, { kind: "csv", fileName });
  const thresholds = loadActivationThresholds();
  const accounts = profiles.map((profile) => combineAccountIntelligence({ usage: profile, thresholds }));
  const payload = {
    source: fileName,
    importedAt: new Date().toISOString(),
    counts: { rows: profiles.length },
    accounts,
  };
  mkdirSync(resolve(process.cwd(), "diagnostics"), { recursive: true });
  writeFileSync(resolve(process.cwd(), "diagnostics/usage-import.json"), `${JSON.stringify(payload, null, 2)}\n`);
  return { imported: true, rowCount: profiles.length, file: fileName };
}
