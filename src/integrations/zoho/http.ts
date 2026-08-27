import { ReadOnlyViolationError } from "./errors.js";
import type { Logger } from "../../logging/logger.js";
import type { ZohoHttpResult } from "./types.js";

export type Fetcher = typeof fetch;

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function assertCrmReadOnly(method: string, url: string): void {
  if (WRITE_METHODS.has(method.toUpperCase())) {
    throw new ReadOnlyViolationError(method.toUpperCase(), url);
  }
}

export function asJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function readZohoError(json: unknown): { code?: string; message?: string } {
  const object = asJsonObject(json);
  if (!object) {
    return {};
  }
  return {
    code: typeof object.code === "string" ? object.code : undefined,
    message: typeof object.message === "string" ? object.message : undefined,
  };
}

export class ZohoHttp {
  constructor(
    private readonly options: {
      getAccessToken: () => Promise<string>;
      getApiDomain: () => Promise<string>;
      logger: Logger;
      fetchImpl?: Fetcher;
      maxRetries?: number;
    },
  ) {}

  async get(
    path: string,
    query: Record<string, string | undefined> = {},
  ): Promise<ZohoHttpResult> {
    const apiDomain = await this.options.getApiDomain();
    const url = new URL(path.startsWith("/") ? path : `/${path}`, `${apiDomain}/`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, value);
      }
    }

    assertCrmReadOnly("GET", url.toString());

    const fetchImpl = this.options.fetchImpl ?? fetch;
    const maxRetries = this.options.maxRetries ?? 3;
    let attempt = 0;

    while (true) {
      const token = await this.options.getAccessToken();
      const started = Date.now();
      const response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
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

      this.options.logger.info("zoho.crm.get", {
        path: url.pathname,
        status: response.status,
        durationMs,
      });

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < maxRetries) {
        attempt += 1;
        const retryAfter = Number(response.headers.get("retry-after"));
        const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 400 * attempt;
        this.options.logger.warn("zoho.crm.retry", { path: url.pathname, status: response.status, attempt, delayMs });
        await sleep(delayMs);
        continue;
      }

      return {
        ok: response.ok || noContent,
        status: response.status,
        noContent,
        json,
      };
    }
  }
}
