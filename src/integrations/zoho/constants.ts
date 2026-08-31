/**
 * Official Zoho CRM API v8 references used by this connector.
 * Do not invent endpoints. If an endpoint is missing here, look it up first.
 */
export const ZOHO_CRM_API_VERSION = "v8";

export const ZOHO_DOCS = {
  oauthOverview: "https://www.zoho.com/crm/developer/docs/api/v8/oauth-overview.html",
  accessRefresh: "https://www.zoho.com/crm/developer/docs/api/v8/access-refresh.html",
  refreshToken: "https://www.zoho.com/crm/developer/docs/api/v8/refresh.html",
  scopes: "https://www.zoho.com/crm/developer/docs/api/v8/scopes.html",
  getRecords: "https://www.zoho.com/crm/developer/docs/api/v8/get-records.html",
  searchRecords: "https://www.zoho.com/crm/developer/docs/api/v8/search-records.html",
  fields: "https://www.zoho.com/crm/developer/docs/api/v8/field-meta.html",
  relatedLists: "https://www.zoho.com/crm/developer/docs/api/v8/related-list-meta.html",
  relatedRecords: "https://www.zoho.com/crm/developer/docs/api/v8/get-related-records.html",
  notes: "https://www.zoho.com/crm/developer/docs/api/v8/get-notes.html",
  createNotes: "https://www.zoho.com/crm/developer/docs/api/v8/create-notes.html",
  emails: "https://www.zoho.com/crm/developer/docs/api/v8/get-email-rel-list.html",
  viewEmail: "https://www.zoho.com/crm/developer/docs/api/v8/view-email.html",
  tags: "https://www.zoho.com/crm/developer/docs/api/v8/get-tag-list.html",
  modules: "https://www.zoho.com/crm/developer/docs/api/v8/modules-api.html",
  org: "https://www.zoho.com/crm/developer/docs/api/v8/get-org-data.html",
} as const;

export const READ_ONLY_SCOPES = [
  "ZohoCRM.modules.READ",
  "ZohoCRM.settings.READ",
  "ZohoCRM.modules.emails.READ",
  "ZohoCRM.modules.notes.READ",
  "ZohoSearch.securesearch.READ",
  "ZohoCRM.org.READ",
] as const;

/** Minimum additional scope for Sales Engine write-back (Notes only). */
export const NOTES_CREATE_SCOPE = "ZohoCRM.modules.notes.CREATE" as const;

export const WRITE_BACK_SCOPES = [...READ_ONLY_SCOPES, NOTES_CREATE_SCOPE] as const;

export const SALES_ENGINE_NOTE_TITLES = {
  interaction: "Sales Engine interaction",
  context: "Sales Engine context",
} as const;

export const ACCOUNTS_URLS = {
  US: "https://accounts.zoho.com",
  AU: "https://accounts.zoho.com.au",
  EU: "https://accounts.zoho.eu",
  IN: "https://accounts.zoho.in",
  CN: "https://accounts.zoho.com.cn",
  JP: "https://accounts.zoho.jp",
  SA: "https://accounts.zoho.sa",
  CA: "https://accounts.zohocloud.ca",
} as const;

export const PRIMARY_MODULES = ["Contacts", "Leads", "Accounts"] as const;

export type PrimaryModule = (typeof PRIMARY_MODULES)[number];

export const EMAIL_SEARCH_MODULES = ["Contacts", "Leads"] as const;

export const RELATED_LISTS_SKIP_GENERIC_FETCH = new Set(["Emails"]);

/** Documented Emails list `type` values tried when the default list is empty. */
export const EMAIL_LIST_TYPES = [undefined, "sent_from_crm", "user_emails"] as const;

export const MAX_EMAIL_LIST_PAGES = 5;

/**
 * Related-list field fallbacks used only when Fields Metadata is unavailable
 * for that module. Names come from official v8 docs / related-list examples.
 */
export const FALLBACK_RELATED_FIELDS: Record<string, string[]> = {
  Notes: [
    "Note_Title",
    "Note_Content",
    "Created_Time",
    "Modified_Time",
    "Owner",
    "Parent_Id",
    "Created_By",
    "Modified_By",
  ],
  Tasks: ["Subject", "Status", "Due_Date", "Priority", "Owner", "Description", "Created_Time"],
  Calls: [
    "Subject",
    "Call_Start_Time",
    "Call_Type",
    "Call_Duration",
    "Owner",
    "Description",
    "Created_Time",
  ],
  Events: [
    "Event_Title",
    "Start_DateTime",
    "End_DateTime",
    "All_day",
    "Owner",
    "Description",
    "Created_Time",
  ],
  Deals: ["Deal_Name", "Stage", "Amount", "Closing_Date", "Owner", "Pipeline", "Created_Time"],
  Contacts: ["Full_Name", "Email", "Phone", "Account_Name", "Created_Time"],
  Accounts: ["Account_Name", "Website", "Industry", "Billing_Country", "Created_Time"],
  Attachments: ["File_Name", "Size", "Owner", "Created_Time"],
  Campaigns: ["Campaign_Name", "Status", "Type", "Start_Date", "Created_Time"],
  Activities_Chronological_View: [
    "Subject",
    "Status",
    "Owner",
    "Call_Start_Time",
    "Due_Date",
    "Event_Title",
    "Start_DateTime",
  ],
  Activities_Chronological_View_History: [
    "Subject",
    "Status",
    "Owner",
    "Call_Start_Time",
    "Due_Date",
    "Event_Title",
    "Start_DateTime",
  ],
};

export const MAX_RELATED_FIELDS = 50;
export const DEFAULT_RELATED_PAGE_SIZE = 50;
export const DEFAULT_EMAIL_BODY_FETCH_LIMIT = 20;
export const EMAIL_PREVIEW_CHARS = 500;
export const TOKEN_EXPIRY_SKEW_MS = 60_000;
