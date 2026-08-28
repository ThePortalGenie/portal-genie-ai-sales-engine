import { classifyHttpRetrieval } from "../../domain/retrieval-state.js";
import { M365ReadOnlyViolationError } from "./errors.js";
import type { Logger } from "../../logging/logger.js";
import type { GraphHttpResult } from "./types.js";

export type Fetcher = typeof fetch;

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const SEND_PATH = /\/send(?:$|\?)/i;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function assertGraphReadOnly(method: string, url: string): void {
  const upper = method.toUpperCase();
  if (WRITE_METHODS.has(upper)) {
    throw new M365ReadOnlyViolationError(upper, url);
  }
  if (SEND_PATH.test(url)) {
    throw new M365ReadOnlyViolationError(upper, url);
  }
}

export class GraphHttp {
  constructor(
    private readonly options: {
      getAccessToken: () => Promise<string>;
      logger: Logger;
      fetchImpl?: Fetcher;
      maxRetries?: number;
      baseUrl?: string;
    },
  ) {}

  async get(
    path: string,
    query: Record<string, string | undefined> = {},
  ): Promise<GraphHttpResult> {
    const base = (this.options.baseUrl ?? "https://graph.microsoft.com/v1.0").replace(/\/$/, "");
    const url = new URL(path.startsWith("/") ? path : `/${path}`, `${base}/`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, value);
      }
    }

    assertGraphReadOnly("GET", url.toString());

    const fetchImpl = this.options.fetchImpl ?? fetch;
    const maxRetries = this.options.maxRetries ?? 3;
    let attempt = 0;

    while (true) {
      const token = await this.options.getAccessToken();
      const started = Date.now();
      const response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const durationMs = Date.now() - started;
      const noContent = response.status === 204;
      let json: unknown = null;
      const text = noContent ? "" : await response.text();
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = { parseError: true, rawLength: text.length };
        }
      }

      this.options.logger.info("m365.graph.get", {
        path: url.pathname,
        status: response.status,
        durationMs,
      });

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < maxRetries) {
        attempt += 1;
        const retryAfter = Number(response.headers.get("retry-after"));
        const delayMs =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 400 * attempt;
        this.options.logger.warn("m365.graph.retry", {
          path: url.pathname,
          status: response.status,
          attempt,
          delayMs,
        });
        await sleep(delayMs);
        continue;
      }

      const retrieval = classifyHttpRetrieval(response.status, json);
      return {
        ok: response.ok || noContent,
        status: response.status,
        noContent,
        json,
        retrieval,
      };
    }
  }
}
