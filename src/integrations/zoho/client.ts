import { ZOHO_CRM_API_VERSION, MAX_RELATED_FIELDS } from "./constants.js";
import { ZohoHttp } from "./http.js";
import type { ZohoHttpResult } from "./types.js";

export type ZohoCrmReader = {
  getRecord(moduleApiName: string, recordId: string): Promise<ZohoHttpResult>;
  searchByEmail(moduleApiName: string, email: string): Promise<ZohoHttpResult>;
  getFields(moduleApiName: string): Promise<ZohoHttpResult>;
  getRelatedLists(moduleApiName: string): Promise<ZohoHttpResult>;
  getRelatedRecords(
    moduleApiName: string,
    recordId: string,
    relatedListApiName: string,
    fields: string[],
    perPage: number,
  ): Promise<ZohoHttpResult>;
  getEmails(
    moduleApiName: string,
    recordId: string,
    query?: { index?: string; type?: string },
  ): Promise<ZohoHttpResult>;
  getEmail(
    moduleApiName: string,
    recordId: string,
    messageId: string,
    userId?: string,
  ): Promise<ZohoHttpResult>;
  getTags(moduleApiName: string): Promise<ZohoHttpResult>;
  searchByWord(moduleApiName: string, word: string): Promise<ZohoHttpResult>;
  getOrg(): Promise<ZohoHttpResult>;
};

export class ZohoCrmReadClient implements ZohoCrmReader {
  constructor(private readonly http: ZohoHttp) {}

  getRecord(moduleApiName: string, recordId: string): Promise<ZohoHttpResult> {
    return this.http.get(`/crm/${ZOHO_CRM_API_VERSION}/${moduleApiName}/${recordId}`);
  }

  searchByEmail(moduleApiName: string, email: string): Promise<ZohoHttpResult> {
    return this.http.get(`/crm/${ZOHO_CRM_API_VERSION}/${moduleApiName}/search`, { email });
  }

  getFields(moduleApiName: string): Promise<ZohoHttpResult> {
    return this.http.get(`/crm/${ZOHO_CRM_API_VERSION}/settings/fields`, {
      module: moduleApiName,
    });
  }

  getRelatedLists(moduleApiName: string): Promise<ZohoHttpResult> {
    return this.http.get(`/crm/${ZOHO_CRM_API_VERSION}/settings/related_lists`, {
      module: moduleApiName,
    });
  }

  getRelatedRecords(
    moduleApiName: string,
    recordId: string,
    relatedListApiName: string,
    fields: string[],
    perPage: number,
  ): Promise<ZohoHttpResult> {
    const limited = fields.slice(0, MAX_RELATED_FIELDS);
    return this.http.get(
      `/crm/${ZOHO_CRM_API_VERSION}/${moduleApiName}/${recordId}/${relatedListApiName}`,
      {
        fields: limited.join(","),
        per_page: String(perPage),
        page: "1",
      },
    );
  }

  getEmails(
    moduleApiName: string,
    recordId: string,
    query: { index?: string; type?: string } = {},
  ): Promise<ZohoHttpResult> {
    return this.http.get(`/crm/${ZOHO_CRM_API_VERSION}/${moduleApiName}/${recordId}/Emails`, {
      index: query.index,
      type: query.type,
    });
  }

  getEmail(
    moduleApiName: string,
    recordId: string,
    messageId: string,
    userId?: string,
  ): Promise<ZohoHttpResult> {
    return this.http.get(
      `/crm/${ZOHO_CRM_API_VERSION}/${moduleApiName}/${recordId}/Emails/${messageId}`,
      { user_id: userId },
    );
  }

  getTags(moduleApiName: string): Promise<ZohoHttpResult> {
    return this.http.get(`/crm/${ZOHO_CRM_API_VERSION}/settings/tags`, {
      module: moduleApiName,
    });
  }

  searchByWord(moduleApiName: string, word: string): Promise<ZohoHttpResult> {
    return this.http.get(`/crm/${ZOHO_CRM_API_VERSION}/${moduleApiName}/search`, { word });
  }

  getOrg(): Promise<ZohoHttpResult> {
    return this.http.get(`/crm/${ZOHO_CRM_API_VERSION}/org`);
  }
}
