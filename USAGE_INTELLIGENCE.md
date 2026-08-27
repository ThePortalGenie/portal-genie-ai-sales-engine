# Usage Intelligence & Leading Indicators

The Sales Engine must prioritise from **both** Zoho CRM relationship intelligence and actual Portal Genie product usage.

Journey (registration is not the final conversion event):

**Lead → Registration → Setup → Activation → Usage → Habit → Paying → Expansion → Partner → Referrals**

Governing KPI remains **800 paying Portal Genie registrations by February 2027.**

## Systems of record

- **Zoho CRM:** leads, contacts, accounts, deals, notes, activities, accessible email, sales conversations, lead source, roadshow history, follow-up, sales and Partner sales lifecycle.
- **Portal Genie database:** registration, account creation, user activity, accounting connections, portal activity, documents, payments, product emails/actions, engagement, activation, usage.
- **Sales Engine:** calculated metrics, aggregates, lifecycle state, intelligence, scores, trends, recommended actions, relevant event history, external IDs. Do not duplicate operational databases.

## Leading vs lagging

Lagging (already happened): paying, subscription, revenue, Partner created, referral received, churn, cancellation.

Leading (likely next): registered, accounting connected, returned, visit frequency, documents, payments, emails, important functionality, repeat action, increasing/decreasing usage, dormancy.

Use leading indicators early enough to know whether February 2027 is achievable.

## Interim usage ingestion

Do **not** require a live Portal Genie database or API for the initial Sales Engine.

Supported sources (interchangeable):

1. Manual CSV/XLSX upload (initial)
2. Scheduled file import
3. Portal Genie API (later)
4. Direct database/reporting connection (later)

All sources must pass through a usage import adapter into `NormalizedUsageProfile`. Downstream scoring must not depend on the ingestion method.

Prefer the fastest reliable method that produces useful sales intelligence. Identity matching is deterministic first; uncertain matches are flagged, never auto-merged.

## Architecture constraint

Do **not** build the Portal Genie usage integration before the Zoho Discovery Connector is validated.

When Milestone 3 begins: sample 20–50 representative accounts, determine which product signals actually distinguish groups, then define the permanent activation model. Do not hard-code illustrative usage-score weights as permanent truth.

Prefer meaningful product events over scanning the entire Portal Genie database.

Connecting accounting software is a major activation signal.

Partner registration is not success. Track through first referral, referred-client paying, and active referring Partner.

Human attention is optimised for **commercial impact per minute**.
