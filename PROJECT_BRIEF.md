# Portal Genie AI Sales Engine — Project Brief

**Project:** Portal Genie AI Sales Engine  
**Primary Business Target:** 800 paying Portal Genie registrations by February 2027  
**Primary User:** One-person sales operation  
**CRM System of Record:** Zoho CRM  
**Product System of Record:** The Portal Genie

This file is the source of truth for product intent. Cursor rules in `.cursor/rules/` are concise operating constraints derived from it.

## Mission

Build an AI-assisted Sales Engine that enables one person to operate new-business, activation, reactivation, and Partner-development functions.

Every feature must contribute to at least one of:

1. Generating new paying registrations
2. Increasing conversion of existing leads
3. Increasing activation/usage of registered accounts
4. Creating and activating referral Partners
5. Generating qualified sales conversations
6. Improving conversion rates
7. Reducing manual sales administration

Principle: **AI handles volume. Human handles value.**

## Architecture

- Zoho CRM = relationship and CRM system of record
- The Portal Genie = account, registration, and product-usage system of record
- Sales Engine = intelligence, prioritisation, orchestration, and automation layer
- Human = high-value sales and commercial decision layer

Do not replace Zoho CRM. Do not duplicate The Portal Genie.

The Sales Engine must eventually combine CRM relationship signals and Portal Genie usage signals after identity resolution. Registration is not the final conversion event.

**Lead → Registration → Setup → Activation → Usage → Habit → Paying → Expansion → Partner → Referrals**

See `USAGE_INTELLIGENCE.md` for leading indicators, activation milestones, Partner usage signals, and the 800-paying funnel. Do not implement Portal Genie database access until the Zoho Discovery Connector is validated.

## Sales motions

1. Historical lead reactivation (especially 2024–2026 roadshow leads)
2. Existing Portal Genie account activation
3. Partner growth (success = active referring Partners, not Partner registrations alone)
4. New business acquisition (after existing opportunities are processed effectively)

## Current build sequence

Do not skip ahead because later functionality is exciting.

1. **Zoho Discovery Connector** — read-only authenticate and retrieve one record
2. **CRM Explorer UI** (current) — inspect Zoho relationship history in the browser
3. **Sales Intelligence Profile** from retrieved Zoho context plus imported usage
4. **Portal Genie Usage Discovery** — sample 20–50 accounts; do not assume schema
5. **Unified Account Intelligence** — CRM + usage after identity resolution
6. **Leading Indicators + Activation Model** — thresholds from real product data
7. **Next-Best-Action Engine**
8. **Human Priority Queue**
9. **Controlled Outreach** (AI prepares, human approves)
10. **New Prospect Generation**

## Non-goals for this milestone

- Dashboard / command centre UI (CRM Explorer is in scope; Sales Command Centre is not)
- Autonomous or bulk outreach
- Prospect generation
- CRM writes
- Portal Genie integration
- AI relationship scoring

## Initial Zoho rule

READ ONLY. First technical milestone: authenticate → retrieve one known record → retrieve all useful related context.

API capabilities must be verified against current official Zoho documentation. Do not assume UI-visible data is available through the API.

## Outreach safety (later)

AI prepares → human reviews → human approves. No LLM decision may override suppression/compliance rules.

## AI vs deterministic code

Deterministic: exact matching, dates, suppression, frequency limits, registration checks, activity calculations, CRM IDs, lifecycle, permissions, audit logging.

AI: summaries, note/email interpretation, classification, interests/objections, relevance, personalisation, recommended next action.

When uncertain: escalate rather than invent.

## Guiding question

> What is the highest-leverage thing we can build now that increases the probability of reaching 800 paying Portal Genie registrations by February 2027 while minimising the human sales workload?
