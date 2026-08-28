import type { ZohoCrmReader } from "../integrations/zoho/client.js";
import type { ZohoHttpResult } from "../integrations/zoho/types.js";

export type RequestCacheStats = { hits: number; misses: number };

/**
 * Request-level cache for one commercial analysis. Not a distributed cache.
 */
export function createRequestCachedClient(client: ZohoCrmReader): { client: ZohoCrmReader; stats: RequestCacheStats } {
  const cache = new Map<string, Promise<ZohoHttpResult>>();
  const stats: RequestCacheStats = { hits: 0, misses: 0 };

  function cachedKey(key: string, run: () => Promise<ZohoHttpResult>): Promise<ZohoHttpResult> {
    const existing = cache.get(key);
    if (existing) {
      stats.hits += 1;
      return existing;
    }
    stats.misses += 1;
    const pending = run();
    cache.set(key, pending);
    return pending;
  }

  function cached<Args extends unknown[]>(
    name: string,
    fn: (...args: Args) => Promise<ZohoHttpResult>,
  ): (...args: Args) => Promise<ZohoHttpResult> {
    return (...args: Args) => cachedKey(`${name}:${JSON.stringify(args)}`, () => fn(...args));
  }

  return {
    stats,
    client: {
      getRecord: cached("getRecord", client.getRecord.bind(client)),
      searchByEmail: cached("searchByEmail", client.searchByEmail.bind(client)),
      getFields: cached("getFields", client.getFields.bind(client)),
      getRelatedLists: cached("getRelatedLists", client.getRelatedLists.bind(client)),
      getRelatedRecords: (moduleApiName, recordId, relatedListApiName, fields, perPage) =>
        cachedKey(`getRelatedRecords:${moduleApiName}:${recordId}:${relatedListApiName}`, () =>
          client.getRelatedRecords(moduleApiName, recordId, relatedListApiName, fields, perPage),
        ),
      getEmails: cached("getEmails", client.getEmails.bind(client)),
      getEmail: cached("getEmail", client.getEmail.bind(client)),
      getTags: cached("getTags", client.getTags.bind(client)),
      searchByWord: cached("searchByWord", client.searchByWord.bind(client)),
      getOrg: cached("getOrg", client.getOrg.bind(client)),
      getRecords: cached("getRecords", client.getRecords.bind(client)),
    },
  };
}
