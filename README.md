# Portal Genie AI Sales Engine

AI-assisted sales intelligence for a one-person sales operation.

**Governing KPI:** 800 paying Portal Genie registrations by February 2027.

Zoho CRM remains the CRM system of record. The Portal Genie remains the product/account system of record. This application is the intelligence and orchestration layer.

Read `PROJECT_BRIEF.md` and `USAGE_INTELLIGENCE.md` before proposing architectural changes.

## Current milestone

**Commercial Intelligence Engine V1** on top of the existing read-only CRM Explorer.

Open a relationship and choose **ANALYSE COMMERCIAL OPPORTUNITY**. The engine builds deterministic Contact and Organisation evidence (including imported Portal Genie usage when a match exists), then asks OpenAI for a structured commercial profile: what the relationship means, the primary/secondary opportunity, next action, unknowns, and whether enrichment would help.

Analysis runs only when requested. It does not write to Zoho, send email, or scrape the web.

```bash
npm start
```

Then open `http://127.0.0.1:8787/`

Add `OPENAI_API_KEY` to `.env` (server-side only). Optional `OPENAI_MODEL` defaults to `gpt-5.6`.

Navigation is intentionally small:

- **CRM Explorer** — search Contacts, Leads, and Accounts; inspect one relationship
- **Usage Data** — import a Portal Genie CSV (no live product database)
- **Settings** — Zoho connection status, Connect Zoho, Test Connection

The browser talks only to this localhost server. The server uses the existing Discovery Connector. Tokens never leave the server.

### Connect Zoho from the UI

1. Keep `ZOHO_CLIENT_ID` and `ZOHO_CLIENT_SECRET` in `.env` (never in the browser).
2. Open **Settings → Zoho CRM**.
3. Paste a Self Client grant token into **Connect Zoho**. The server exchanges it and stores `ZOHO_REFRESH_TOKEN` in `.env`.
4. Click **Test Connection**.

Optional browser OAuth: register `http://127.0.0.1:8787/api/zoho/oauth/callback` on the Zoho client, set that as `ZOHO_REDIRECT_URI`, then use **Start OAuth redirect**. The authorization code is consumed on the server; the browser is sent back to `/#settings` without the code.

### Inspect a relationship

Search by email, name, company, or Zoho record ID. Matching Contacts, Leads, and Accounts are listed separately — they are not merged. Select the intended record.

The relationship page shows overview, notes, emails, deals, tasks/calls/meetings, custom fields, and a chronological timeline of dated events only. Each capability is marked **retrieved**, **empty**, **unavailable**, or **error**. **ANALYSE COMMERCIAL OPPORTUNITY** builds a Commercial Intelligence Profile for that one record. **View Diagnostic** downloads the same non-secret JSON the CLI connector writes.

Zoho remains **read-only**. There are no edit, create, send, or delete controls. Operator feedback (CORRECT / PARTIALLY_CORRECT / WRONG) is stored locally for later calibration; it does not retrain anything.

## What this connector checks

Verified against [Zoho CRM API v8](https://www.zoho.com/crm/developer/docs/api/v8/api-references.html):

| Context | Official endpoint |
| --- | --- |
| Record | `GET /crm/v8/{module}/{id}` |
| Email search | `GET /crm/v8/{module}/search?email=` |
| Fields (including custom) | `GET /crm/v8/settings/fields?module=` |
| Related lists catalog | `GET /crm/v8/settings/related_lists?module=` |
| Related records (notes, deals, tasks, calls, meetings, activities) | `GET /crm/v8/{module}/{id}/{related_list}` |
| Record emails | `GET /crm/v8/{module}/{id}/Emails` |
| Email body | `GET /crm/v8/{module}/{id}/Emails/{message_id}` |
| Module tags | `GET /crm/v8/settings/tags?module=` |
| Organisation | `GET /crm/v8/org` |
| Word search | `GET /crm/v8/{module}/search?word=` |

UI-visible data is not assumed to be API-available. Emails are fetched from the dedicated Emails API (`GET /crm/v8/{module}/{id}/Emails`), not the generic related-records endpoint. Related-list metadata is catalogued, but only sales-relevant lists (Notes, Deals, Tasks, Calls, Meetings, Activities, Campaigns, Contacts, Accounts) are retrieved. ChronologicalView, Social, and Voice of the Customer are skipped rather than expanding OAuth scopes.

## Human configuration required

1. A Zoho CRM user who can read Leads/Contacts and related records.
2. A [Zoho API Console](https://api-console.zoho.com/) **Self Client** (simplest for a one-person operation).
3. The correct data-centre accounts URL (UK orgs are often `https://accounts.zoho.eu`).
4. One known Contact or Lead ID, or an email that exists in CRM.

## Setup

```bash
copy .env.example .env
npm install
```

Fill `.env`:

- `ZOHO_CLIENT_ID`
- `ZOHO_CLIENT_SECRET`
- `ZOHO_REDIRECT_URI` (must match the API Console client)
- `ZOHO_ACCOUNTS_URL`
- `OPENAI_API_KEY` (server-side; never sent to the browser)
- Optional `OPENAI_MODEL` (default `gpt-5.6`)

### 1. Create a Self Client and grant token

In Zoho API Console, generate a grant token with these **read-only** scopes:

```text
ZohoCRM.modules.READ,ZohoCRM.settings.READ,ZohoCRM.modules.emails.READ,ZohoCRM.modules.notes.READ,ZohoSearch.securesearch.READ,ZohoCRM.org.READ
```

Do not request CREATE, UPDATE, DELETE, or ALL module scopes.

### 2. Exchange the grant token

```bash
npm run zoho:auth -- --code 1000.your_grant_token --write-env
```

This stores `ZOHO_REFRESH_TOKEN` in `.env`. Grant tokens expire quickly; exchange immediately.

### 3. Run discovery against one known record

```bash
npm run zoho:discover -- --module Contacts --id YOUR_RECORD_ID
npm run zoho:discover -- --email jane@example.com
```

A human-readable summary prints to the terminal. The full diagnostic JSON is written under `diagnostics/` (gitignored).

### 4. Import Portal Genie usage from a spreadsheet

Live Portal Genie database access is not required. Export one row per account and import it:

```bash
npm run usage:import -- --file data/usage-template.csv
```

Optional CRM identity matching:

```bash
npm run usage:import -- --file data/usage.xlsx --match-crm diagnostics/crm-identities.json
```

Activation thresholds live in `config/activation-thresholds.json` and are marked uncalibrated until real conversion analysis exists. Missing spreadsheet columns are allowed.

XLSX is supported. The same normalised usage profile is what a later API or database adapter would produce.

## Tests

```bash
npm test
npm run typecheck
```

Live Zoho and live OpenAI calls are not part of the automated tests. OpenAI is mocked. After configuring `.env`, analyse a mixed sample of real relationships from CRM Explorer and record CORRECT / PARTIALLY_CORRECT / WRONG.

## Security

- Secrets stay in `.env`. Never commit them.
- The CRM HTTP client only implements GET requests. The UI cannot edit CRM records.
- The UI binds to `127.0.0.1` by default.
- Logs do not include access tokens, refresh tokens, or full email bodies.
- Email content, notes, and other CRM text are treated as untrusted input and rendered as text. They are sent to OpenAI only inside a delimited evidence block and must not be followed as instructions.
- OpenAI requests are purpose-built (`CommercialReasoningContext`). OAuth tokens, API keys, and raw Zoho payloads are not sent.

## What comes next

Do not start bulk CRM analysis, outreach, external enrichment execution, or a Sales Command Centre dashboard until this one-record Commercial Intelligence Profile is reviewed against real relationships.
