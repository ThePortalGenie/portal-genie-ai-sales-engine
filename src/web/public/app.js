const $ = (id) => document.getElementById(id);

const PAGE_CONTEXT = {
  "command-centre": { kicker: "Daily queue", title: "Sales Command Centre" },
  overview: { kicker: "Mission control", title: "Overview" },
  explorer: { kicker: "Workspace", title: "CRM Explorer" },
  usage: { kicker: "Product evidence", title: "Usage Intelligence" },
  pipeline: { kicker: "Redirect", title: "Pipeline Intelligence" },
  settings: { kicker: "Connections", title: "Settings" },
};

function showPage() {
  const hash = (location.hash || "#command-centre").replace("#", "").split("?")[0];
  const page = PAGE_CONTEXT[hash] ? hash : "command-centre";
  for (const id of Object.keys(PAGE_CONTEXT)) {
    const node = $(`page-${id}`);
    if (node) node.classList.toggle("hidden", id !== page);
  }
  for (const link of document.querySelectorAll("[data-nav]")) {
    link.classList.toggle("active", link.getAttribute("data-nav") === page);
  }
  if (!relationshipOpen()) {
    $("context-kicker").textContent = PAGE_CONTEXT[page].kicker;
    $("context-title").textContent = PAGE_CONTEXT[page].title;
  }
  $("sidebar")?.classList.remove("open");
  $("nav-toggle")?.setAttribute("aria-expanded", "false");
  if (page === "command-centre") loadCommandCentre();
}

function relationshipOpen() {
  return Boolean($("relationship")?.childElementCount);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

function fieldValue(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return value.name || JSON.stringify(value);
  return String(value);
}

function words(value) {
  return String(value || "").replaceAll("_", " ");
}

function operatorMessage(error) {
  const message = error?.message || String(error || "Something went wrong.");
  if (/not_connected|not connected/i.test(message)) return "Zoho is not connected. Open Settings to connect.";
  if (/Too many requests/i.test(message)) return "Please wait a moment and try again.";
  if (/Missing OPENAI/i.test(message)) return "OpenAI is not configured. Add a server-side key in Settings.";
  if (/Valid module and Zoho record id/i.test(message)) return "That record could not be opened.";
  return message;
}

function formatWhen(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatDay(value) {
  if (!value) return "Undated";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    const today = new Date();
    if (date.toDateString() === today.toDateString()) return "Today";
    return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return "Today";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function localDateTimeValue(iso) {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  const tz = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return tz.toISOString().slice(0, 16);
}

function viewField(view, apiName) {
  const rows = [...(view.overview || []), ...(view.standardFields || []), ...(view.customFields || [])];
  const hit = rows.find((item) => item.apiName === apiName);
  return hit ? fieldValue(hit.value) : "";
}

function capCount(view, key) {
  const cap = (view.capabilities || []).find((item) => item.key === key || item.label === key);
  if (!cap) return "—";
  if (typeof cap.count === "number") return String(cap.count);
  if (cap.status === "empty") return "0";
  if (cap.status === "unavailable" || cap.status === "error") return "Unavailable";
  return words(cap.status);
}

const SALES_EVENT_TYPES = ["PHONE_CALL", "EMAIL", "MEETING", "DEMO", "WHATSAPP", "IN_PERSON", "ROADSHOW", "FOLLOW_UP", "NO_SHOW", "INTERNAL_NOTE", "OTHER"];
const SALES_EVENT_OUTCOMES = ["", "CONNECTED", "NO_ANSWER", "VOICEMAIL", "REPLIED", "NO_REPLY", "MEETING_COMPLETED", "MEETING_NO_SHOW", "MEETING_RESCHEDULED", "INTERESTED", "DECISION_PENDING", "FOLLOW_UP_REQUESTED", "NOT_INTERESTED", "REGISTERED", "ACTIVATED", "CUSTOMER", "PARTNER_CONFIRMED", "LOST", "OTHER"];
const SALES_EVENT_SCOPES = ["PORTAL_GENIE", "NAGGING_PANDA", "ORGANISATION_GENERAL", "BOTH"];

function capabilityLine(cap) {
  if (cap.status === "retrieved" && cap.count !== undefined) return `${cap.count} retrieved`;
  if (cap.status === "empty") return "Empty";
  if (cap.status === "unavailable") return cap.message || "Unavailable";
  if (cap.status === "error") return cap.message || "Error";
  return cap.message || cap.status;
}

function zohoLabel(status) {
  if (status === "connected") return { text: "Connected", cls: "ok" };
  if (status === "not_connected") return { text: "Not connected", cls: "warn" };
  return { text: "Error", cls: "bad" };
}

async function refreshStatus() {
  const zohoNode = $("zoho-status");
  const openaiNode = $("openai-status");
  const pill = $("zoho-pill");
  try {
    const status = await api("/api/zoho/status");
    const zoho = zohoLabel(status.status);
    zohoNode.textContent = zoho.text;
    zohoNode.className = `status-value ${zoho.cls}`;
    pill.textContent = `Zoho: ${zoho.text}`;
    pill.className = `pill ${zoho.cls}`;
    const explorer = $("explorer-status");
    if (explorer && !relationshipOpen()) {
      explorer.textContent = status.status === "connected"
        ? "Zoho is connected. Search stays read-only; records are not merged."
        : status.status === "not_connected"
          ? "Zoho is not connected. You can still open Settings without searching."
          : "Zoho connection needs attention. Open Settings.";
    }
    renderConnection(status);
  } catch {
    zohoNode.textContent = "Error";
    zohoNode.className = "status-value bad";
    pill.textContent = "Zoho: Error";
    pill.className = "pill bad";
    const explorer = $("explorer-status");
    if (explorer && !relationshipOpen()) explorer.textContent = "Zoho status could not be read. Open Settings.";
  }
  await renderM365Connections();
  try {
    const openai = await api("/api/intelligence/status");
    openaiNode.textContent = openai.configured ? "Ready" : "Not configured";
    openaiNode.className = `status-value ${openai.configured ? "ok" : "warn"}`;
  } catch {
    openaiNode.textContent = "Error";
    openaiNode.className = "status-value bad";
  }
}

function crmWritesStatusLabel(mode) {
  return mode === "notes_only" ? "Notes only" : "Disabled";
}

function renderConnection(status) {
  const card = $("connection-card");
  if (!card) return;
  card.replaceChildren();
  const zoho = zohoLabel(status.status);
  card.append(
    el("h3", { text: "Zoho CRM" }),
    el("p", {}, [el("span", { class: `pill ${zoho.cls}`, text: zoho.text })]),
    kv("Organisation", status.organisation || "Unavailable"),
    kv("Data centre", status.dataCentre || "—"),
    kv("API domain", status.apiDomain || "—"),
    kv("Last successful connection", status.lastSuccessfulConnection || "Never"),
    kv("API status", status.apiStatus || "—"),
    kv("Client ID", status.clientIdConfigured ? "Configured" : "Missing"),
    kv("Client secret", status.clientSecretConfigured ? "Configured" : "Missing"),
    kv("Refresh token", status.refreshTokenConfigured ? "Configured" : "Missing"),
    kv("Redirect URI", status.redirectUri || "—"),
    kv("CRM writes", crmWritesStatusLabel(status.crmWrites ?? "disabled")),
    el("p", {
      class: "muted",
      text: "Sales Engine cannot modify Contacts, Accounts, Deals, Leads, or pipeline data.",
    }),
  );
  if (status.error) card.append(el("p", { class: "muted", text: status.error }));
  api("/api/intelligence/status")
    .then((openai) => {
      card.append(
        el("h3", { text: "OpenAI" }),
        kv("Status", openai.configured ? "Ready" : "Not configured"),
        kv("API key", openai.configured ? "Configured on server" : "Missing"),
        kv("Model", openai.model || "—"),
      );
    })
    .catch(() => {
      card.append(el("p", { class: "muted", text: "OpenAI status unavailable." }));
    });
  card.append(el("h3", { text: "Granted/expected scopes" }));
  for (const scope of status.capabilities || []) {
    card.append(el("div", { class: "muted", text: scope }));
  }
}

function m365MailboxLabel(status) {
  if (status === "connected") return { text: "Connected", cls: "ok" };
  if (status === "connection_error") return { text: "Error", cls: "bad" };
  return { text: "Not connected", cls: "warn" };
}

function productScopeLabel(scope) {
  if (scope === "PORTAL_GENIE") return "Portal Genie";
  if (scope === "NAGGING_PANDA") return "Nagging Panda";
  return scope || "—";
}

function watchItemProductLabel(item) {
  const product = productScopeLabel(item.product_scope);
  if (item.product_registration_state === "REGISTERED") return `${product} · Registered`;
  if (item.product_registration_state === "NOT_REGISTERED") return `${product} · Prospect`;
  return product;
}

async function renderM365Connections() {
  const card = $("m365-connection-card");
  if (!card) return;
  card.replaceChildren();
  try {
    const status = await api("/api/m365/status");
    card.append(
      el("h3", { text: "Microsoft 365 mailboxes" }),
      el("p", { class: "muted", text: "Read-only delegated access. Tokens stay on the server; sync is operator-triggered only." }),
      kv("App configured", status.configured ? "Yes" : "Missing client credentials"),
      kv("Tenant", status.tenantId || "—"),
      kv("Redirect URI", status.redirectUri || "—"),
      kv("Access", "Read-only"),
    );
    card.append(el("h4", { text: "Granted/expected scopes" }));
    for (const scope of status.scopes || []) {
      card.append(el("div", { class: "muted", text: scope }));
    }
    for (const mailbox of status.mailboxes || []) {
      const label = m365MailboxLabel(mailbox.status);
      const block = el("div", { class: "card nested" });
      block.append(
        el("h4", { text: productScopeLabel(mailbox.product_scope) }),
        el("p", {}, [el("span", { class: `pill ${label.cls}`, text: label.text })]),
        kv("Connection id", mailbox.connection_id),
        kv("Mailbox", mailbox.mailbox_email || "—"),
        kv("Display name", mailbox.display_name || "—"),
        kv("Product scope", mailbox.product_scope),
        kv("Last successful connection", mailbox.last_successful_connection || "Never"),
        kv("Last sync attempt", mailbox.last_sync_attempt || "Never"),
        kv("Last successful sync", mailbox.last_successful_sync || "Never"),
        kv("Retrieval state", mailbox.retrieval_state || "UNAVAILABLE"),
      );
      if (mailbox.error) block.append(el("p", { class: "muted", text: mailbox.error }));
      const row = el("div", { class: "row" });
      const connect = el("a", {
        class: "button secondary",
        href: `/api/m365/oauth/start?connection_id=${encodeURIComponent(mailbox.connection_id)}`,
        text: "Connect",
      });
      const testBtn = el("button", { type: "button", class: "secondary", text: "Test" });
      testBtn.addEventListener("click", async () => {
        testBtn.disabled = true;
        try {
          await api("/api/m365/test", { method: "POST", body: JSON.stringify({ connectionId: mailbox.connection_id }) });
          await renderM365Connections();
        } catch (error) {
          alert(operatorMessage(error));
        } finally {
          testBtn.disabled = false;
        }
      });
      const syncBtn = el("button", { type: "button", class: "secondary", text: "Sync" });
      syncBtn.addEventListener("click", async () => {
        syncBtn.disabled = true;
        try {
          await api("/api/m365/sync", { method: "POST", body: JSON.stringify({ connectionId: mailbox.connection_id }) });
          await renderM365Connections();
        } catch (error) {
          alert(operatorMessage(error));
        } finally {
          syncBtn.disabled = false;
        }
      });
      row.append(connect, testBtn, syncBtn);
      block.append(row);
      card.append(block);
    }
  } catch {
    card.append(el("p", { class: "muted", text: "Microsoft 365 status unavailable." }));
  }
}

function kv(label, value) {
  const wrap = el("div", { class: "kv" });
  wrap.append(el("div", { class: "muted", text: label }), el("div", { text: value }));
  return wrap;
}

function appendKv(parent, label, value) {
  if (value == null || String(value).trim() === "") return;
  parent.append(kv(label, value));
}

function stat(label, value) {
  const node = el("div", { class: "stat" });
  node.append(el("div", { class: "label", text: label }), el("div", { class: "value", text: value }));
  return node;
}

$("search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const q = $("search-q").value.trim();
  $("search-status").textContent = "Searching…";
  $("search-results").replaceChildren();
  $("relationship").replaceChildren();
  $("explorer-home").classList.remove("hidden");
  try {
    const data = await api(`/api/crm/search?q=${encodeURIComponent(q)}`);
    $("search-status").textContent = `${data.hits.length} result(s) across Contacts, Leads, and Accounts. Ambiguous matches are listed separately.`;
    if (data.warnings?.length) $("search-status").textContent += ` ${data.warnings.join(" ")}`;
    for (const hit of data.hits) {
      const card = el("div", { class: "hit" });
      card.append(
        el("strong", { text: hit.name || hit.email || hit.id }),
        el("div", { class: "muted", text: `${hit.module}` }),
        el("div", { text: [hit.email, hit.company].filter(Boolean).join(" · ") }),
      );
      card.addEventListener("click", () => openRelationship(hit.module, hit.id));
      $("search-results").append(card);
    }
  } catch (error) {
    $("search-status").textContent = operatorMessage(error);
  }
});

async function openRelationship(moduleName, id) {
  $("explorer-home").classList.add("hidden");
  $("relationship").replaceChildren(el("p", { class: "muted", text: "Loading relationship…" }));
  try {
    const data = await api(`/api/crm/relationship?module=${encodeURIComponent(moduleName)}&id=${encodeURIComponent(id)}`);
    renderRelationship(data.view, data.usage, moduleName, id);
  } catch (error) {
    $("explorer-home").classList.remove("hidden");
    $("relationship").replaceChildren(el("p", { class: "warn-text", text: operatorMessage(error) }));
  }
}

function backToSearch() {
  $("relationship").replaceChildren();
  $("explorer-home").classList.remove("hidden");
  $("context-kicker").textContent = PAGE_CONTEXT.explorer.kicker;
  $("context-title").textContent = PAGE_CONTEXT.explorer.title;
}

function renderRelationship(view, usage, moduleName, id) {
  const root = $("relationship");
  root.replaceChildren();
  const orgName = view.header.company || view.header.name;
  $("context-kicker").textContent = "Organisation";
  $("context-title").textContent = orgName;

  const back = el("button", { type: "button", class: "secondary", text: "Back to search" });
  back.addEventListener("click", backToSearch);
  root.append(el("div", { class: "row" }, [back]));

  const title = viewField(view, "Title") || viewField(view, "Designation");
  const owner = viewField(view, "Owner");
  const identity = el("div", { class: "card identity-header" });
  identity.append(el("h2", { class: "identity-title", text: orgName }));
  identity.append(el("div", { class: "identity-meta" }, [
    el("span", { text: view.header.name || "—" }),
    view.header.email ? el("span", { text: view.header.email }) : el("span"),
    title ? el("span", { text: title }) : el("span"),
    owner && owner !== "—" ? el("span", { text: `CRM owner: ${owner}` }) : el("span"),
  ]));
  const badges = el("div", { class: "badge-row", id: "identity-badges" });
  badges.append(el("span", { class: "pill", text: "Selected contact" }));
  identity.append(badges);
  identity.append(el("p", { class: "muted", text: `${view.header.module} · read-only CRM record` }));
  root.append(identity);

  const intelligence = el("div", { id: "intelligence-panel" });
  const analyseRow = el("div", { class: "row" });
  const analyseButton = el("button", { type: "button", text: "ANALYSE COMMERCIAL OPPORTUNITY" });
  const reanalyseButton = el("button", { type: "button", class: "secondary", text: "Re-analyse" });
  reanalyseButton.hidden = true;
  const analyseStatus = el("p", { class: "muted", id: "analyse-status" });
  const analyseResult = el("div", { id: "analyse-result" });
  analyseRow.append(analyseButton, reanalyseButton);
  intelligence.append(analyseRow, analyseStatus, analyseResult);
  root.append(intelligence);

  const snapshotSection = el("section", { class: "section", id: "org-snapshot-section" }, [
    el("h2", { text: "Organisation snapshot" }),
  ]);
  const snapshot = el("div", { class: "snapshot", id: "org-snapshot" });
  snapshotSection.append(snapshot);
  root.append(snapshotSection);
  renderSnapshot(snapshot, view, usage, null);

  const salesPanel = el("div", { id: "sales-event-panel" });
  root.append(salesPanel);

  let latestAnalysis = null;
  async function showAnalysis(analysis, fromCache, usageStale) {
    latestAnalysis = analysis || latestAnalysis;
    reanalyseButton.hidden = !analysis;
    if (fromCache && analysis?.success) {
      analyseStatus.textContent = `Last analysis ${formatWhen(analysis.analysedAt)}. Nothing was written to Zoho.`;
    }
    let stale = usageStale;
    if (stale === undefined) {
      try {
        const usage = await api("/api/usage/status");
        stale = Boolean(usage.importedAt && analysis?.analysedAt && usage.importedAt > analysis.analysedAt);
      } catch {
        stale = false;
      }
    }
    renderSalesEventPanel(salesPanel, moduleName, id, latestAnalysis, runAnalysis);
    snapshotSection.hidden = Boolean(analysis?.profile);
    if (!snapshotSection.hidden) renderSnapshot(snapshot, view, usage, latestAnalysis);
    updateIdentityBadges(badges, view, latestAnalysis);
    if (!analysis) return;
    renderIntelligence(analyseResult, analysis, moduleName, id, view, usage);
    if (stale) {
      analyseResult.prepend(el("p", { class: "stale-banner", text: "USAGE DATA UPDATED — ANALYSIS MAY BE STALE" }));
      analyseStatus.textContent = `${analyseStatus.textContent} USAGE DATA UPDATED — ANALYSIS MAY BE STALE. Re-analyse to include the new usage evidence.`;
    }
  }

  async function runAnalysis(force) {
    analyseButton.disabled = true;
    reanalyseButton.disabled = true;
    analyseStatus.textContent = "Analysing commercial opportunity… this can take up to a minute.";
    try {
      const data = await api("/api/intelligence/analyse", {
        method: "POST",
        body: JSON.stringify({ module: moduleName, id, force: Boolean(force) }),
      });
      analyseStatus.textContent = data.analysis?.success
        ? "Analysis complete. Nothing was written to Zoho."
        : operatorMessage({ message: data.analysis?.error || "Analysis failed." });
      showAnalysis(data.analysis, false);
    } catch (error) {
      analyseStatus.textContent = operatorMessage(error);
    } finally {
      analyseButton.disabled = false;
      reanalyseButton.disabled = false;
    }
  }
  analyseButton.addEventListener("click", () => runAnalysis(false));
  reanalyseButton.addEventListener("click", () => runAnalysis(true));
  renderSalesEventPanel(salesPanel, moduleName, id, null, runAnalysis);

  api(`/api/intelligence/profile?module=${encodeURIComponent(moduleName)}&id=${encodeURIComponent(id)}`)
    .then((data) => {
      if (data.analysed) showAnalysis(data.analysis, true, data.usageStale);
    })
    .catch(() => {});

  root.append(renderCrmEvidence(view, usage, moduleName, id));
}

function updateIdentityBadges(root, view, analysis) {
  root.replaceChildren();
  const graph = analysis?.organisationGraph;
  const profile = analysis?.profile;
  const products = analysis?.productRelationships || [];
  root.append(el("span", { class: "pill", text: "Selected contact" }));
  if (profile?.best_contact && graph?.selectedContactName && profile.best_contact !== graph.selectedContactName) {
    root.append(el("span", { class: "pill", text: "Recommended contact differs — not a CRM field" }));
  }
  for (const item of products) {
    root.append(el("span", { class: "pill", text: `${words(item.product)} · ${words(item.relationship_state)}` }));
  }
  const owner = viewField(view, "Owner");
  if (owner && owner !== "—") root.append(el("span", { class: "pill", text: `CRM owner ${owner}` }));
}

function renderSnapshot(root, view, usage, analysis) {
  root.replaceChildren();
  const graph = analysis?.organisationGraph;
  const products = analysis?.productRelationships || [];
  const pg = products.find((item) => item.product === "PORTAL_GENIE");
  const np = products.find((item) => item.product === "NAGGING_PANDA");
  const emails = graph ? String((graph.emails || []).length) : capCount(view, "Emails");
  const last = graph?.emails?.length
    ? formatDay([...graph.emails].map((item) => item.at).filter(Boolean).sort().at(-1))
    : formatDay(view.timeline?.[view.timeline.length - 1]?.at || viewField(view, "Last_Activity_Time"));
  const openOpps = (graph?.productOpportunities || []).filter((item) => item.status === "current").length;
  const histOpps = (graph?.productOpportunities || []).filter((item) => String(item.status).startsWith("historical")).length;
  root.append(
    stat("Contacts", graph ? String((graph.contacts || []).length) : "1"),
    stat("Accounts", graph ? String((graph.accounts || []).length) : view.account ? "1" : "—"),
    stat("Open opportunities", graph ? String(openOpps) : capCount(view, "Deals")),
    stat("Historical opportunities", graph ? String(histOpps) : "—"),
    stat("Emails", emails),
    stat("Last interaction", last || "—"),
    stat("Portal Genie", pg ? words(pg.relationship_state) : "Unknown"),
    stat("Nagging Panda", np ? words(np.relationship_state) : "Unknown"),
  );
}

function renderHero(profile, graph) {
  const hero = el("div", { class: "hero" }, [el("h2", { text: "Commercial intelligence" })]);
  const grid = el("div", { class: "hero-grid" });
  const metrics = [
    ["Primary motion", words(profile.primary_opportunity?.motion)],
    ["Recommended next action", words(profile.recommended_action)],
    ["Decision", words(profile.decision_state)],
    ["Confidence", profile.confidence],
    ["Recommended contact", profile.best_contact || "—"],
  ];
  for (const [label, value] of metrics) {
    const item = el("div", { class: "hero-metric" });
    item.append(el("span", { class: "label", text: label }), el("span", { class: "value", text: value }));
    grid.append(item);
  }
  hero.append(grid);
  const why = el("div", { class: "why-block" }, [
    el("h3", { text: "Why this action" }),
    el("p", { text: profile.recommended_action_reason || "—" }),
  ]);
  if (profile.best_contact && graph?.selectedContactName && profile.best_contact !== graph.selectedContactName) {
    why.append(el("p", {
      class: "layer-note",
      text: `Selected contact remains ${graph.selectedContactName}. Recommended contact is an intelligence suggestion, not a CRM field, and identities were not switched.`,
    }));
  }
  why.append(el("p", {
    class: "layer-note",
    text: "The recommendation is AI inference over confirmed evidence. Confirmed CRM facts and operator-entered events stay labelled separately below.",
  }));
  hero.append(why);
  return hero;
}

function timelineKindPill(kind, source) {
  if (kind === "operator_sales_event" || source === "OPERATOR_ENTERED_SALES_EVENT") {
    return el("span", { class: "pill operator", text: "OPERATOR EVENT" });
  }
  if (kind === "inferred_real_world" || /INFERRED/i.test(source || "")) return el("span", { class: "pill inferred", text: "INFERRED" });
  if (kind === "usage" || source === "USAGE") return el("span", { class: "pill usage", text: "USAGE" });
  if (/email/i.test(source || "") || /email/i.test(kind || "")) return el("span", { class: "pill email", text: "EMAIL" });
  return el("span", { class: "pill zoho", text: "ZOHO" });
}

function renderCommercialStory(analysis) {
  const section = el("section", { class: "section" }, [el("h2", { text: "Commercial story" })]);
  const events = [...(analysis.reconstructedTimeline || [])].sort(
    (left, right) => (left.at ? Date.parse(left.at) : 0) - (right.at ? Date.parse(right.at) : 0),
  );
  if (!events.length) {
    section.append(el("p", { class: "muted", text: "No dated commercial events yet." }));
    return section;
  }
  const list = el("ol", { class: "story" });
  for (const event of events.slice(-16)) {
    const item = el("li", { class: "story-item" });
    item.append(el("time", { text: formatDay(event.at) }));
    const body = el("div", { class: "story-body" });
    body.append(timelineKindPill(event.kind, event.source), el("strong", { text: event.title || "" }));
    body.append(el("div", { class: "muted", text: `Provenance: ${event.source || event.kind || "unknown"}` }));
    item.append(body);
    list.append(item);
  }
  section.append(list);
  section.append(el("p", { class: "muted", text: "Inferred events are reconstructed from notes or emails. They are not Zoho Call or Meeting records unless also listed as CRM facts. Operator events are Sales Engine evidence." }));
  return section;
}

function renderPeople(graph, profile) {
  const section = el("section", { class: "section" }, [el("h2", { text: "People in this organisation" })]);
  section.append(el("p", { class: "muted", text: "Related contacts. Zoho records were not merged." }));
  const grid = el("div", { class: "people-grid" });
  const recommended = profile?.best_contact;
  for (const member of graph.contacts || []) {
    const isSelected = member.selected;
    const isRecommended = recommended && member.name === recommended && !isSelected;
    const card = el("div", { class: `person-card${isSelected ? " selected" : ""}${isRecommended ? " recommended" : ""}` });
    card.append(el("strong", { text: member.name || "Unnamed" }));
    const badges = el("div", { class: "badge-row" });
    if (isSelected) badges.append(el("span", { class: "pill", text: "Selected contact" }));
    if (recommended && member.name === recommended) badges.append(el("span", { class: "pill", text: "Recommended contact" }));
    card.append(badges);
    if (member.title) card.append(el("div", { class: "muted", text: `Job title (CRM fact): ${member.title}` }));
    if (member.email) card.append(el("div", { class: "muted", text: member.email }));
    if (member.accountName) card.append(el("div", { class: "muted", text: `Account: ${member.accountName}` }));
    card.append(el("div", { text: `Associated because: ${associationLine(member)}` }));
    if (member.commercial_role) {
      card.append(el("div", { class: "muted", text: `Commercial relevance (${member.commercial_role.layer}): ${words(member.commercial_role.role)}` }));
    }
    if (member.certainty === "possible") card.append(el("span", { class: "pill warn", text: "POSSIBLE MATCH — REVIEW" }));
    grid.append(card);
  }
  if (!(graph.contacts || []).length) section.append(el("p", { class: "muted", text: "No related contacts were associated." }));
  else section.append(grid);
  return section;
}

function renderFragmentation(graph) {
  if (!graph.fragmentation?.possible_crm_fragmentation) return null;
  const card = el("div", { class: "review-card section" });
  const names = graph.fragmentation.account_names || [];
  card.append(
    el("h2", { text: "CRM structure review" }),
    el("span", { class: "pill warn", text: "POSSIBLY RELATED — REVIEW" }),
    el("p", { text: `${names.length || graph.fragmentation.account_ids?.length || 0} possibly related Account records detected.` }),
    el("p", { text: names.join(" · ") || (graph.fragmentation.label || "POSSIBLY RELATED ACCOUNT RECORDS — REVIEW") }),
    el("p", { class: "muted", text: "These Zoho Account records were not merged and are not labelled as duplicates." }),
  );
  return card;
}

function appendSafe(root, factory) {
  try {
    const node = factory();
    if (node) root.append(node);
  } catch (error) {
    root.append(el("p", { class: "warn-text", text: `A section could not be shown: ${error.message}` }));
  }
}

function renderSnapshotSection(view, usage, analysis) {
  const section = el("section", { class: "section" }, [el("h2", { text: "Organisation snapshot" })]);
  const grid = el("div", { class: "snapshot" });
  renderSnapshot(grid, view, usage, analysis);
  section.append(grid);
  const graph = analysis?.organisationGraph;
  if (graph) {
    section.append(
      kv("Organisation", graph.organisationName || "Uncertain"),
      kv("Domains", (graph.domains || []).join(", ") || "None (public email domains are excluded)"),
      kv("Certainty", graph.certainty === "resolved" ? "Resolved from deterministic evidence" : "Uncertain"),
      kv("Zoho records merged", "No — intelligence graph only"),
    );
  }
  return section;
}

function renderActivityDistinction(profile) {
  const section = el("section", { class: "section" }, [
    el("h2", { text: "Confirmed CRM activity vs inferred real-world activity" }),
  ]);
  const split = el("div", { class: "activity-split" });
  const confirmed = el("div", { class: "activity-card confirmed" }, [
    el("h3", { text: "Confirmed CRM activity" }),
    el("p", { text: profile.confirmed_crm_activity || "—" }),
    el("p", { class: "muted", text: "Taken from Zoho records. These are CRM facts." }),
  ]);
  const inferred = el("div", { class: "activity-card inferred" }, [
    el("h3", { text: "Inferred real-world activity" }),
    el("p", { text: profile.inferred_real_world_activity || "—" }),
    el("p", { class: "muted", text: "Reconstructed from notes, emails, or operator events. Not Zoho Call or Meeting records unless also listed as CRM facts." }),
  ]);
  split.append(confirmed, inferred);
  section.append(split);
  return section;
}

function renderRelatedAccounts(graph) {
  const section = el("section", { class: "section" }, [el("h2", { text: "Related accounts" })]);
  const list = el("div", { class: "related-accounts" });
  let count = 0;
  for (const account of graph.accounts || []) {
    count += 1;
    const card = el("div", { class: "person-card" });
    card.append(el("strong", { text: account.name || "Unnamed account" }));
    card.append(el("div", { class: "muted", text: `Zoho Accounts ${account.recordId}` }));
    card.append(el("div", { text: `Associated because: ${associationLine(account)}` }));
    list.append(card);
  }
  for (const account of graph.possibleAccounts || []) {
    count += 1;
    const card = el("div", { class: "person-card" });
    card.append(el("strong", { text: account.name || "Unnamed account" }));
    card.append(el("div", { class: "muted", text: `Zoho Accounts ${account.recordId}` }));
    card.append(el("div", { text: `Associated because: ${associationLine(account)}` }));
    card.append(el("span", { class: "pill warn", text: "POSSIBLE MATCH — REVIEW" }));
    list.append(card);
  }
  if (!count) section.append(el("p", { class: "muted", text: "No related Account records were associated." }));
  else section.append(list);
  return section;
}

function renderOpportunities(graph) {
  const opps = graph?.productOpportunities || [];
  if (!opps.length) return null;
  const section = el("section", { class: "section" }, [el("h2", { text: "Opportunities / deal context" })]);
  for (const item of opps) {
    const historical = String(item.status || "").startsWith("historical");
    section.append(kv(
      `${words(item.product)} · ${historical ? "Historical" : "Current"}`,
      `${item.deal_name || item.deal_id || ""}${item.stage ? ` · ${item.stage}` : ""}${item.contact_name ? ` · ${item.contact_name}` : ""}${item.account_name ? ` · ${item.account_name}` : ""}`,
    ));
  }
  return section;
}

function renderRecommendationContext(profile, analysis) {
  const section = el("section", { class: "section" }, [el("h2", { text: "Recommendation context" })]);
  const relationship = [profile.relationship_state, ...(profile.additional_relationship_states || [])]
    .filter(Boolean)
    .map(words)
    .join(" · ");
  section.append(
    kv("Relationship", relationship || "—"),
    kv("Objective", profile.recommended_action_objective || "—"),
    kv("Message angle", profile.suggested_message_angle || "—"),
    kv("Recommended channel", profile.recommended_channel || "—"),
    kv("Relationship depth", profile.relationship_depth || "—"),
    kv("Confidence reason", profile.confidence_reason || "—"),
    kv("Recommended contact reason", profile.reason_for_best_contact || "—"),
  );
  if (analysis.organisationRelationship?.characterisation) {
    section.append(kv("Organisation relationship", analysis.organisationRelationship.characterisation));
  }
  return section;
}

function renderOpportunityAssessments(profile) {
  const section = el("section", { class: "section" }, [el("h2", { text: "Opportunity assessments" })]);
  for (const [label, item] of [
    ["Partner", profile.partner_potential],
    ["Registration", profile.registration_potential],
    ["Activation", profile.activation_potential],
    ["Paid conversion", profile.paid_conversion_potential],
    ["Reactivation", profile.reactivation_potential],
  ]) {
    section.append(kv(
      label,
      item ? `${words(item.motion)} (${item.confidence || "—"}) — ${item.rationale || ""}` : "Not assessed",
    ));
  }
  if (profile.secondary_opportunities?.length) {
    section.append(listBlock(
      "Secondary opportunities",
      profile.secondary_opportunities.map((item) => `${words(item.motion)} (${item.confidence}) — ${item.rationale}`),
    ));
  }
  return section;
}

function renderDataQuality(graph) {
  if (!(graph.dataQualitySignals || []).length && !(graph.omissions || []).length) return null;
  const section = el("section", { class: "section" }, [el("h2", { text: "Data-quality signals" })]);
  for (const signal of graph.dataQualitySignals || []) {
    section.append(el("p", { text: `${words(signal.code)} — ${signal.message}` }));
  }
  for (const omission of graph.omissions || []) {
    section.append(el("p", { class: "muted", text: `Retrieval limit: ${omission.kind} · ${omission.omitted} omitted (${omission.reason})` }));
  }
  return section;
}

function renderInferredInteractions(analysis) {
  if (!analysis.interactions?.length) return null;
  const inferred = el("section", { class: "section" }, [el("h2", { text: "Inferred real-world interactions" })]);
  inferred.append(el("p", { class: "muted", text: "These are reconstructed from notes/emails. They are not Zoho Call or Meeting records unless also listed as CRM facts." }));
  for (const item of analysis.interactions) {
    inferred.append(kv(
      words(item.interaction_type),
      `${item.direction} · ${item.confidence}${item.supporting_evidence_count > 1 ? ` · ${item.supporting_evidence_count} supporting evidence records` : ""} · ${item.summary}${item.follow_up_commitment ? ` · Follow-up: ${item.follow_up_commitment}` : ""} (${item.provenance})`,
    ));
  }
  return inferred;
}

function renderProducts(analysis) {
  const section = el("section", { class: "section" }, [el("h2", { text: "Product relationships" })]);
  const grid = el("div", { class: "product-grid" });
  for (const product of ["PORTAL_GENIE", "NAGGING_PANDA"]) {
    const rel = (analysis.productRelationships || []).find((item) => item.product === product);
    const card = el("div", { class: "product-card" });
    card.append(el("h3", { text: words(product) }));
    card.append(el("p", { text: rel ? words(rel.relationship_state) : "UNKNOWN" }));
    if (rel?.summary) card.append(el("p", { class: "muted", text: rel.summary }));
    const opps = (analysis.organisationGraph?.productOpportunities || []).filter((item) => item.product === product);
    if (!opps.length) card.append(el("p", { class: "muted", text: "No product-specific opportunities listed." }));
    for (const item of opps) {
      const historical = String(item.status).startsWith("historical");
      card.append(el("div", {
        class: historical ? "opp historical" : "opp",
        text: `${historical ? "Historical" : "Current"} · ${item.deal_name || item.deal_id}${item.stage ? ` · ${item.stage}` : ""}${item.contact_name ? ` · ${item.contact_name}` : ""}`,
      }));
    }
    grid.append(card);
  }
  section.append(grid);
  return section;
}

function displayUnknown(value) {
  if (value === undefined || value === null || value === "") return "UNKNOWN";
  return String(value);
}

function activationInterpretation(summary, usage) {
  const states = (usage?.profiles || []).map((profile) => profile.activationState).filter(Boolean);
  if (states.length) return states.map((state) => words(state)).join(" · ");
  if (!summary || summary.label === "USAGE UNKNOWN") return "USAGE UNKNOWN";
  if (summary.accountingConnectedCount && summary.clientPortalActivityPresent) return "Activation evidence present (AI interpretation is separate)";
  if (summary.accountingConnectedCount && !summary.clientPortalActivityPresent) return "Accounting connected; client portal activity limited or unknown";
  return "Matched usage present — see profiles";
}

function renderPortalGenieUsage(analysis) {
  const layer = analysis.organisationGraph?.portalGenieUsage;
  const usage = analysis.organisation?.usage;
  const section = el("section", { class: "section" }, [el("h2", { text: "Portal Genie usage" })]);
  section.append(el("span", { class: "pill usage", text: "USAGE" }));
  section.append(el("p", { class: "muted", text: "Portal visits = visits by the subscriber's clients. Last login is subscriber authentication. This is imported product evidence, not a Zoho CRM fact." }));
  const summary = layer?.summary || usage?.organisationSummary;
  const card = el("div", { class: "usage-summary card" });
  card.append(el("h3", { text: "Organisation summary" }));
  card.append(el("p", { text: summary?.message || usage?.message || "USAGE UNKNOWN — product usage was not assumed to be zero." }));
  const grid = el("div", { class: "snapshot" });
  grid.append(
    stat("Accounting integration", summary ? (summary.accountingConnectedCount ? `${summary.accountingConnectedCount} connected` : summary.accountingUnknownCount ? "UNKNOWN" : "Not connected") : "UNKNOWN"),
    stat("Last known login", displayUnknown(summary?.latestLoginAt)),
    stat("Client portal activity", summary?.clientPortalActivityPresent ? "Present" : summary?.clientPortalActivityUnknown ? "UNKNOWN" : "None recorded"),
    stat("Portal visit trend", displayUnknown(summary?.portalVisitTrend)),
    stat("Document upload usage", summary?.documentUploadPresent ? "Present" : summary?.documentUploadZero ? "Zero" : "UNKNOWN"),
    stat("Activation / adoption", activationInterpretation(summary, usage)),
    stat("Subscriber profiles", String(summary?.subscriberProfileCount ?? 0)),
  );
  card.append(grid);
  if ((usage?.contradictions || []).length) {
    const cons = el("div", { class: "callout" });
    cons.append(el("h4", { text: "CRM vs usage contradictions" }));
    for (const item of usage.contradictions) cons.append(el("p", { text: `${item.code}: ${item.message}` }));
    card.append(cons);
  }
  section.append(card);

  const profiles = layer
    ? [...layer.contactProfiles, ...layer.organisationDiscoveredProfiles]
    : usage?.profiles || [];
  if (!profiles.length) {
    section.append(el("p", { class: "muted", text: "USAGE UNKNOWN. No matching Portal Genie subscriber profile." }));
  } else {
    const list = el("div", { class: "people-grid" });
    for (const profile of profiles) {
      const person = el("div", { class: "person-card" });
      person.append(el("strong", { text: profile.name || profile.email || profile.clientId || "Subscriber" }));
      person.append(el("div", { class: "badge-row" }, [
        el("span", { class: "pill usage", text: "USAGE" }),
        el("span", { class: "pill", text: profile.layer === "organisation" ? "Organisation discovery" : "Contact-level" }),
      ]));
      person.append(kv("Email", displayUnknown(profile.email)));
      person.append(kv("Client ID", displayUnknown(profile.clientId)));
      person.append(kv("Accounting software connected", profile.accountingConnected === true ? "YES" : profile.accountingConnected === false ? "NO" : "UNKNOWN"));
      person.append(kv("Accounting platform", displayUnknown(profile.accountingPlatform || profile.accountingSoftware)));
      person.append(kv("Last login", displayUnknown(profile.lastLoginAt)));
      person.append(kv("Portal visits — current month", displayUnknown(profile.portalVisitsCurrentMonth)));
      person.append(kv("Portal visits — previous month", displayUnknown(profile.portalVisitsPreviousMonth)));
      person.append(kv("Portal visits — two months ago", displayUnknown(profile.portalVisitsTwoMonthsAgo)));
      person.append(kv("Portal visit trend", displayUnknown(profile.portalVisitTrend)));
      person.append(kv("Document upload usage", displayUnknown(profile.documentUploadUsage?.original || profile.documentUploadUsage)));
      person.append(kv("Match reason", displayUnknown(profile.matchReason || profile.matchMethod)));
      person.append(kv("Data-quality status", displayUnknown(profile.dataQualityStatus || (profile.dataQuality ? Object.entries(profile.dataQuality).map(([k, v]) => `${k}=${v}`).join(", ") : "UNKNOWN"))));
      if (profile.matchedContactName) person.append(kv("Matched CRM Contact", profile.matchedContactName));
      list.append(person);
    }
    section.append(list);
  }
  for (const contact of layer?.unmatchedContacts || usage?.unmatchedContacts || []) {
    section.append(el("p", { class: "muted", text: `${contact.name}: No matching usage profile.` }));
  }
  return section;
}

function optionList(values, selected) {
  return values.map((value) => {
    const label = value ? words(value) : "(unknown)";
    const node = el("option", { value, text: label });
    if (value === selected) node.selected = true;
    return node;
  });
}

function organisationIdFrom(analysis, moduleName, id) {
  return analysis?.organisationGraph?.organisationId || `contact:${moduleName}:${id}`;
}

function renderSalesEventPanel(root, moduleName, id, analysis, runAnalysis) {
  root.replaceChildren();
  const graph = analysis?.organisationGraph;
  const organisationId = organisationIdFrom(analysis, moduleName, id);
  const contacts = graph?.contacts || [];
  const section = el("section", { class: "card event-section" }, [
    el("h2", { text: "Record real-world event" }),
    el("p", { class: "muted", text: "Record activity that happened outside the CRM so it can inform the next recommendation." }),
  ]);
  const form = el("div", { class: "event-form" });
  const contactSelect = el("select", { id: "se-contact" });
  contactSelect.append(el("option", { value: "", text: "Organisation" }));
  const selectedId = graph?.selectedContactId || id;
  for (const contact of contacts) {
    const option = el("option", { value: contact.recordId, text: contact.name });
    option.dataset.name = contact.name || "";
    if (contact.recordId === selectedId || contact.selected) option.selected = true;
    contactSelect.append(option);
  }
  if (!contacts.length) {
    const option = el("option", { value: id, text: "Selected contact" });
    option.selected = true;
    contactSelect.append(option);
  }
  const productSelect = el("select", { id: "se-product" }, optionList(SALES_EVENT_SCOPES, "PORTAL_GENIE"));
  const typeSelect = el("select", { id: "se-type" }, optionList(SALES_EVENT_TYPES, "PHONE_CALL"));
  const outcomeSelect = el("select", { id: "se-outcome" }, optionList(SALES_EVENT_OUTCOMES, "NO_ANSWER"));
  const occurred = el("input", { type: "datetime-local", id: "se-occurred", value: localDateTimeValue() });
  const summary = el("input", { type: "text", id: "se-summary", placeholder: "What happened", maxlength: "4000" });
  const nextStep = el("input", { type: "text", id: "se-next", placeholder: "Agreed next step (optional)", maxlength: "500" });
  const followUp = el("input", { type: "date", id: "se-follow" });
  const status = el("p", { class: "muted", id: "se-status" });
  let editingId = null;

  function labeled(label, node, wide) {
    return el("label", { class: wide ? "wide" : "" }, [el("span", { text: label }), node]);
  }
  form.append(
    labeled("Contact", contactSelect),
    labeled("Product", productSelect),
    labeled("Event type", typeSelect),
    labeled("Outcome", outcomeSelect),
    labeled("Date/time", occurred),
    labeled("Follow-up date", followUp),
    labeled("What happened", summary, true),
    labeled("Agreed next step", nextStep, true),
  );

  function payloadFromForm() {
    const contactId = contactSelect.value;
    const contactName = contactSelect.selectedOptions[0]?.dataset?.name || contactSelect.selectedOptions[0]?.text || "";
    const organisationLevel = !contactId;
    return {
      organisation_id: organisationId,
      contact_id: organisationLevel ? "" : contactId,
      contact_name: organisationLevel ? "" : contactName,
      product_scope: productSelect.value,
      event_type: typeSelect.value,
      outcome: outcomeSelect.value,
      occurred_at: occurred.value ? new Date(occurred.value).toISOString() : new Date().toISOString(),
      summary: summary.value,
      next_step: nextStep.value,
      follow_up_date: followUp.value || "",
    };
  }

  function fillForm(event) {
    editingId = event?.id || null;
    if (!event) {
      contactSelect.value = selectedId;
      productSelect.value = "PORTAL_GENIE";
      typeSelect.value = "PHONE_CALL";
      outcomeSelect.value = "NO_ANSWER";
      occurred.value = localDateTimeValue();
      summary.value = "";
      nextStep.value = "";
      followUp.value = "";
      return;
    }
    contactSelect.value = event.contact_id || "";
    productSelect.value = event.product_scope;
    typeSelect.value = event.event_type;
    outcomeSelect.value = event.outcome || "";
    occurred.value = localDateTimeValue(event.occurred_at);
    summary.value = event.summary || "";
    nextStep.value = event.next_step || "";
    followUp.value = (event.follow_up_date || "").slice(0, 10);
  }

  async function loadEvents() {
    const orgIds = [...new Set([organisationId, `contact:${moduleName}:${id}`])].join(",");
    const contactIds = [...new Set([id, ...contacts.map((item) => item.recordId)])].join(",");
    const data = await api(
      `/api/sales-events?organisationId=${encodeURIComponent(orgIds)}&contactIds=${encodeURIComponent(contactIds)}`,
    );
    return data.events || [];
  }

  const list = el("div", { class: "event-list" });
  async function refreshList() {
    list.replaceChildren();
    try {
      const events = await loadEvents();
      if (!events.length) {
        list.append(el("p", { class: "muted", text: "No operator sales events yet." }));
        return;
      }
      for (const event of events) {
        const row = el("div", { class: "event-row" });
        row.append(
          el("strong", { text: `${formatDay(event.occurred_at)} · ${words(event.event_type)}${event.outcome ? ` — ${words(event.outcome)}` : ""}` }),
          el("div", { text: `${event.contact_name || "Organisation"} · ${words(event.product_scope)}` }),
          el("div", { class: "muted", text: event.summary }),
          el("span", { class: "pill operator", text: "OPERATOR EVENT" }),
        );
        const edit = el("button", { type: "button", class: "secondary", text: "Edit" });
        const remove = el("button", { type: "button", class: "secondary", text: "Delete" });
        edit.addEventListener("click", () => {
          fillForm(event);
          status.textContent = "Editing this operator event. Save to correct it.";
        });
        remove.addEventListener("click", async () => {
          if (!window.confirm("Delete this operator-entered sales event? Zoho records are not changed.")) return;
          await api(`/api/sales-events/${encodeURIComponent(event.id)}`, { method: "DELETE" });
          status.textContent = "Deleted locally. Re-analyse to refresh the recommendation.";
          fillForm(null);
          await refreshList();
        });
        row.append(el("div", { class: "row" }, [edit, remove]));
        list.append(row);
      }
    } catch (error) {
      list.append(el("p", { class: "warn-text", text: operatorMessage(error) }));
    }
  }

  async function saveEvent() {
    const body = payloadFromForm();
    if (!body.summary.trim()) {
      status.textContent = "What happened is required.";
      return null;
    }
    if (editingId) {
      const data = await api(`/api/sales-events/${encodeURIComponent(editingId)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      editingId = null;
      return data.event;
    }
    const data = await api("/api/sales-events", { method: "POST", body: JSON.stringify(body) });
    return data.event;
  }

  const saveAnalyse = el("button", { type: "button", text: "Save + re-analyse" });
  const save = el("button", { type: "button", class: "secondary", text: "Save event" });
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      await saveEvent();
      status.textContent = "Saved locally. Not written to Zoho. Analysis was not run.";
      fillForm(null);
      await refreshList();
    } catch (error) {
      status.textContent = operatorMessage(error);
    } finally {
      save.disabled = false;
    }
  });
  saveAnalyse.addEventListener("click", async () => {
    saveAnalyse.disabled = true;
    try {
      await saveEvent();
      status.textContent = "Saved. Re-analysing with the new evidence…";
      fillForm(null);
      await refreshList();
      await runAnalysis(true);
    } catch (error) {
      status.textContent = operatorMessage(error);
    } finally {
      saveAnalyse.disabled = false;
    }
  });

  section.append(form, el("div", { class: "action-row" }, [saveAnalyse, save]), status, list);
  root.append(section);
  refreshList();
}

function listBlock(title, items, empty) {
  const block = el("div", { class: "intel-section" }, [el("h4", { text: title })]);
  if (!items?.length) {
    block.append(el("p", { class: "muted", text: empty || "None recorded." }));
    return block;
  }
  const list = el("ul", { class: "facts" });
  for (const item of items) list.append(el("li", { text: item }));
  block.append(list);
  return block;
}

function reasonLabel(reason) {
  const labels = {
    SELECTED_CONTACT: "Selected contact",
    SAME_ZOHO_ACCOUNT: "Same Zoho Account",
    SAME_BUSINESS_DOMAIN: "Same business domain",
    PORTAL_GENIE_ORG_MATCH: "Portal Genie organisation match",
    RELATED_ACCOUNT: "Related Account",
    SELECTED_CONTACT_ACCOUNT: "Selected contact Account",
    CONTACT_ACCOUNT: "Contact Account",
    EXPLICIT_RELATIONSHIP: "Explicit relationship",
    EXACT_COMPANY_NAME: "Exact company name",
    POSSIBLE_MATCH: "Possible match — review",
    POSSIBLE_MATCH_REVIEW: "Possible match — review (not joined)",
  };
  return labels[reason] || words(reason);
}

function associationLine(item) {
  const reasons = (item.association_reasons || item.reasons || []).map(reasonLabel).join("; ");
  return reasons || "Association reason not recorded";
}

function renderIntelligence(root, analysis, moduleName, id, view, usageOverlay) {
  root.replaceChildren();
  if (!analysis) return;
  if (!analysis.success) {
    root.append(el("p", { class: "warn-text", text: operatorMessage({ message: analysis.error || "Analysis failed." }) }));
  }
  const profile = analysis.profile;
  const graph = analysis.organisationGraph;

  if (profile) appendSafe(root, () => renderHero(profile, graph));
  appendSafe(root, () => renderSnapshotSection(view, usageOverlay, analysis));
  if (profile) appendSafe(root, () => renderActivityDistinction(profile));
  if (profile) appendSafe(root, () => renderCommercialStory(analysis));
  if (graph) {
    appendSafe(root, () => renderPeople(graph, profile));
    appendSafe(root, () => renderRelatedAccounts(graph));
    appendSafe(root, () => renderFragmentation(graph));
  } else if (analysis.organisation?.members?.length) {
    appendSafe(root, () => {
      const members = el("section", { class: "section" }, [el("h2", { text: "People in this organisation" })]);
      members.append(el("p", { class: "muted", text: "Related contacts. Zoho records were not merged." }));
      for (const member of analysis.organisation.members) {
        const line = el("div", { class: member.certainty === "possible" ? "member possible" : "member" });
        line.append(el("strong", { text: member.name }));
        if (member.email) line.append(el("div", { class: "muted", text: member.email }));
        line.append(el("div", { text: `Associated because: ${(member.reasons || []).map(reasonLabel).join(", ") || "selected record"}` }));
        if (member.certainty === "possible") line.append(el("span", { class: "pill warn", text: "POSSIBLE MATCH — REVIEW" }));
        members.append(line);
      }
      return members;
    });
  }
  appendSafe(root, () => renderProducts(analysis));
  appendSafe(root, () => renderPortalGenieUsage(analysis));
  if (graph) appendSafe(root, () => renderOpportunities(graph));
  if (profile) appendSafe(root, () => renderRecommendationContext(profile, analysis));
  if (profile) appendSafe(root, () => renderOpportunityAssessments(profile));
  if (profile) {
    appendSafe(root, () => listBlock("Known facts", profile.known_facts, "No verified facts were asserted."));
    appendSafe(root, () => listBlock("Signals", profile.important_signals));
    appendSafe(root, () => listBlock("Inferences", profile.inferences, "No inferences."));
    appendSafe(root, () => listBlock("Unknowns", profile.unknowns));
    appendSafe(root, () => listBlock("Contradictions", profile.contradictions, "None noted."));
    appendSafe(root, () => renderInferredInteractions(analysis));
  }
  if (graph) appendSafe(root, () => renderDataQuality(graph));

  const usage = analysis.organisation?.usage;
  const usageBlock = el("details", { class: "panel" }, [el("summary", { text: "Portal Genie usage (imported evidence)" })]);
  usageBlock.append(el("p", { class: "muted", text: "Raw usage evidence is summarised above. This collapse keeps the import provenance for verification." }));
  usageBlock.append(el("p", { text: usage?.label || "USAGE UNKNOWN" }));
  usageBlock.append(el("p", { class: "muted", text: usage?.message || "Product usage is unknown, not assumed to be zero. This is not Zoho data." }));
  root.append(usageBlock);

  const enrich = el("details", { class: "panel" }, [el("summary", { text: "Enrichment" })]);
  enrich.append(kv("Recommended", profile?.enrichment_recommended ? "Yes" : "No"));
  enrich.append(el("p", { class: "muted", text: "No vendor is called. These questions are for a future enrichment step." }));
  if (profile?.enrichment_questions?.length) enrich.append(listBlock("Questions", profile.enrichment_questions));
  root.append(enrich);

  const evidence = el("details", { class: "panel" }, [el("summary", { text: "Evidence references" })]);
  for (const item of analysis.evidence || []) {
    evidence.append(el("p", { text: `${item.id} · ${item.type} · ${item.claim} (${item.source}${item.recordId ? ` · ${item.recordId}` : ""})` }));
  }
  if (profile?.evidence_references?.length) {
    evidence.append(el("p", { class: "muted", text: `AI cited: ${profile.evidence_references.join(", ")}` }));
  }
  if (analysis.model) {
    evidence.append(el("p", { class: "muted", text: `Model ${analysis.model} · ${analysis.usage?.totalTokens ?? "?"} tokens · ${analysis.latencyMs ?? "?"} ms` }));
  }
  root.append(evidence);

  const feedback = el("details", { class: "panel" }, [el("summary", { text: "Operator feedback" })]);
  feedback.append(el("p", { class: "muted", text: "Stored for later calibration. It does not retrain the model." }));
  const notes = el("textarea", { rows: "3", placeholder: "Optional notes" });
  const row = el("div", { class: "row" });
  for (const verdict of ["CORRECT", "PARTIALLY_CORRECT", "WRONG"]) {
    const button = el("button", { type: "button", class: "secondary", text: words(verdict) });
    button.addEventListener("click", async () => {
      try {
        await api("/api/intelligence/feedback", {
          method: "POST",
          body: JSON.stringify({ module: moduleName, id, verdict, notes: notes.value }),
        });
        feedback.append(el("p", { text: `Saved ${words(verdict)}.` }));
      } catch (error) {
        feedback.append(el("p", { text: operatorMessage(error) }));
      }
    });
    row.append(button);
  }
  feedback.append(notes, row);
  for (const item of analysis.feedback || []) {
    feedback.append(el("p", { class: "muted", text: `${formatWhen(item.at)} · ${item.verdict}${item.notes ? ` — ${item.notes}` : ""}` }));
  }
  root.append(feedback);
}

function renderCrmEvidence(view, usage, moduleName, id) {
  const wrap = el("section", { class: "section" }, [el("h2", { text: "Evidence / CRM details" })]);
  wrap.append(el("p", { class: "muted", text: "Raw CRM information is here for verification. It is not the commercial recommendation." }));

  if (usage) {
    const usageBlock = el("details", { class: "panel" }, [el("summary", { text: "Imported usage overlay" })]);
    if (!usage.available || usage.matchStatus !== "matched") {
      usageBlock.append(el("p", { class: "muted", text: usage.message || "No matched imported usage profile." }));
    } else {
      usageBlock.append(
        kv("Registered", usage.registered ? "Yes" : "No"),
        kv("Accounting connected", fieldValue(usage.accountingConnected)),
        kv("Activation", fieldValue(usage.activation)),
        kv("Last activity", fieldValue(usage.lastActivity)),
        kv("Paying", fieldValue(usage.paying)),
      );
    }
    wrap.append(usageBlock);
  }

  if (view.account) {
    const account = el("details", { class: "panel" }, [el("summary", { text: "Account" })]);
    for (const key of ["Account_Name", "Website", "Industry", "Billing_Country", "Phone", "Owner"]) {
      if (view.account[key] != null && view.account[key] !== "") {
        account.append(kv(words(key), fieldValue(view.account[key])));
      }
    }
    account.append(kv("Zoho ID", fieldValue(view.account.id)));
    wrap.append(account);
  }

  const timeline = el("details", { class: "panel" }, [el("summary", { text: "CRM timeline" })]);
  if (!view.timeline.length) {
    timeline.append(el("p", { class: "muted", text: "No dated CRM events were returned. Missing timestamps are not invented." }));
  } else {
    const list = el("ul", { class: "timeline" });
    for (const event of view.timeline) {
      const item = el("li");
      item.append(el("time", { text: formatWhen(event.at) }), el("strong", { text: ` ${words(event.type)}` }), el("div", { text: event.title }));
      if (event.preview) item.append(el("div", { class: "muted", text: event.preview }));
      const details = el("details", {}, [el("summary", { text: "Inspect" })]);
      const directionLabel = event.direction ? ` · ${event.direction}` : "";
      details.append(el("div", { class: "muted", text: `Source: ${event.sourceId || "n/a"} · ${event.moduleHint || ""}${directionLabel}` }));
      const matching = (view.normalizedEmails || []).find((email) => email.messageId === event.sourceId);
      if (matching?.bodyText) {
        details.append(el("pre", { text: matching.bodyText.slice(0, 4000) }));
      } else if (event.type.startsWith("email") && event.sourceId) {
        const button = el("button", { type: "button", class: "secondary", text: "Load email body" });
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            const email = await api(`/api/crm/email?module=${encodeURIComponent(moduleName)}&id=${encodeURIComponent(id)}&messageId=${encodeURIComponent(event.sourceId)}`);
            const content = email.normalized?.bodyText || "";
            details.append(el("pre", { text: content ? content.slice(0, 4000) : "No cleaned body was returned." }));
          } catch (error) {
            details.append(el("p", { text: operatorMessage(error) }));
          }
        });
        details.append(button);
      }
      item.append(details);
      list.append(item);
    }
    timeline.append(list);
  }
  wrap.append(timeline);

  const emailCap = view.capabilities.find((item) => item.key === "Emails");
  const emailRows = view.normalizedEmails?.length ? view.normalizedEmails : view.emails?.headers;
  renderCapabilityList(wrap, "Emails", emailCap, emailRows, (email) => {
    const direction = email.direction || (email.sent === false ? "inbound" : email.sent === true ? "outbound" : "unknown");
    const when = formatWhen(email.at || email.time) || "no timestamp";
    return `${email.subject || "Email"} · ${direction} · ${when}`;
  });
  renderCapabilityList(wrap, "Notes", view.capabilities.find((item) => item.key === "Notes"), view.notes, (note) => `${note.Note_Title || "Note"} — ${(note.Note_Content || "").toString().slice(0, 240)}`);
  renderCapabilityList(wrap, "Deals", view.capabilities.find((item) => item.key === "Deals"), view.deals, (deal) => `${deal.Deal_Name || "Deal"} · ${deal.Stage || ""}`);
  renderCapabilityList(wrap, "Tasks", view.capabilities.find((item) => item.key === "Tasks"), view.tasks, (task) => `${task.Subject || "Task"} · ${task.Status || ""}`);
  renderCapabilityList(wrap, "Calls", view.capabilities.find((item) => item.key === "Calls"), view.calls, (call) => call.Subject || "Call");
  renderCapabilityList(wrap, "Meetings", view.capabilities.find((item) => item.key === "Events" || item.key === "Meetings"), view.meetings, (meeting) => meeting.Event_Title || meeting.Subject || "Meeting");

  const custom = el("details", { class: "panel" }, [el("summary", { text: "Custom Fields" })]);
  if (!view.customFields.length) custom.append(el("p", { class: "muted", text: "No custom field values on this record." }));
  for (const field of view.customFields) custom.append(kv(field.label, fieldValue(field.value)));
  wrap.append(custom);

  const details = el("details", { class: "panel" }, [el("summary", { text: "CRM Details" })]);
  details.append(el("h4", { text: "Tags" }), el("p", { text: fieldValue(view.tags) }));
  details.append(el("h4", { text: "Standard fields" }));
  for (const field of view.standardFields.slice(0, 40)) details.append(kv(field.label, fieldValue(field.value)));
  wrap.append(details);

  const debug = el("details", { class: "panel" }, [el("summary", { text: "View diagnostic" })]);
  const button = el("button", { type: "button", class: "secondary", text: "Load diagnostic JSON" });
  const download = el("button", { type: "button", class: "secondary", text: "Download diagnostic" });
  const pre = el("pre");
  async function loadDiagnostic() {
    const diagnostic = await api(`/api/crm/diagnostic?module=${encodeURIComponent(moduleName)}&id=${encodeURIComponent(id)}`);
    const text = JSON.stringify(diagnostic, null, 2);
    pre.textContent = text;
    return text;
  }
  button.addEventListener("click", async () => {
    try { await loadDiagnostic(); } catch (error) { pre.textContent = operatorMessage(error); }
  });
  download.addEventListener("click", async () => {
    try {
      const text = await loadDiagnostic();
      const blob = new Blob([text], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `zoho-${moduleName}-${id}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (error) {
      pre.textContent = operatorMessage(error);
    }
  });
  debug.append(el("p", { class: "muted", text: "Development/verification only. Secrets are redacted." }), button, download, pre);
  wrap.append(debug);
  return wrap;
}

function renderCapabilityList(root, title, cap, records, line) {
  const block = el("details", { class: "panel" }, [el("summary", { text: title })]);
  if (cap && (cap.status === "unavailable" || cap.status === "error")) {
    block.append(el("p", { class: "muted", text: cap.message || `${title} unavailable.` }));
  } else if (!records?.length) {
    block.append(el("p", { class: "muted", text: cap?.message || `No ${title.toLowerCase()} in the retrieved payload.` }));
  } else {
    for (const record of records) block.append(el("p", { text: line(record) }));
  }
  root.append(block);
}

$("connect-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const grantCode = $("grant-code").value;
  $("grant-code").value = "";
  $("connect-status").textContent = "Connecting…";
  try {
    const status = await api("/api/zoho/connect", { method: "POST", body: JSON.stringify({ grantCode }) });
    renderConnection(status);
    await renderM365Connections();
    $("connect-status").textContent = status.status === "connected" ? "Connected." : status.error || status.status;
    await refreshStatus();
  } catch (error) {
    $("connect-status").textContent = operatorMessage(error);
  }
});

$("test-connection").addEventListener("click", async () => {
  $("connect-status").textContent = "Testing…";
  try {
    const status = await api("/api/zoho/test", { method: "POST", body: "{}" });
    renderConnection(status);
    await renderM365Connections();
    $("connect-status").textContent = status.status === "connected" ? "Test succeeded." : status.error || "Test failed.";
    await refreshStatus();
  } catch (error) {
    $("connect-status").textContent = operatorMessage(error);
  }
});

$("usage-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  $("usage-csv").value = await file.text();
});

$("usage-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await api("/api/usage/import-csv", {
      method: "POST",
      body: JSON.stringify({ csv: $("usage-csv").value, fileName: $("usage-file").files?.[0]?.name || "paste.csv" }),
    });
    $("usage-status").textContent = `Imported ${result.accepted ?? result.rowCount} accepted row(s), ${result.rejected ?? 0} rejected, from ${result.file}. OpenAI was not run.`;
    await renderUsageInspect();
  } catch (error) {
    $("usage-status").textContent = operatorMessage(error);
  }
});

async function renderUsageInspect() {
  const root = $("usage-import-result");
  if (!root) return;
  root.replaceChildren();
  try {
    const data = await api("/api/usage/rows");
    if (!data.imported) {
      root.append(el("p", { class: "muted", text: "No imported dataset to inspect yet." }));
      return;
    }
    root.append(el("h3", { text: "Imported dataset" }));
    root.append(el("p", { text: `Imported ${data.importedAt || "unknown time"} · ${data.file || "usage-import.json"}` }));
    root.append(el("p", { text: `${(data.rows || []).filter((row) => row.accepted).length} accepted · ${(data.rejected || []).length} rejected · ${(data.warnings || []).length} warning(s)` }));
    if ((data.warnings || []).length) {
      const list = el("ul");
      for (const warning of data.warnings.slice(0, 20)) list.append(el("li", { text: warning }));
      root.append(list);
    }
    const table = el("div", { class: "usage-inspect" });
    for (const row of data.rows || []) {
      table.append(el("div", { class: "person-card" }, [
        el("strong", { text: `${row.name || row.email || row.clientId || `Row ${row.rowNumber}`}${row.accepted ? "" : " · rejected"}` }),
        kv("Email", displayUnknown(row.email)),
        kv("Client ID", displayUnknown(row.clientId)),
        kv("Accounting connected", displayUnknown(row.accountingConnected)),
        kv("Last login", displayUnknown(row.lastLoginAt)),
        kv("Portal visits (current / previous / two months ago)", `${displayUnknown(row.portalVisitsCurrentMonth)} / ${displayUnknown(row.portalVisitsPreviousMonth)} / ${displayUnknown(row.portalVisitsTwoMonthsAgo)}`),
        kv("Document uploads", displayUnknown(row.documentUploadUsage)),
      ]));
    }
    root.append(table);
  } catch (error) {
    root.append(el("p", { class: "warn-text", text: operatorMessage(error) }));
  }
}

async function loadUsageStatus() {
  try {
    const status = await api("/api/usage/status");
    $("usage-status").textContent = status.imported
      ? `Last import ${status.importedAt || ""}: ${status.accepted ?? status.rowCount} accepted row(s) from ${status.file || "usage-import.json"}`
      : "No usage file imported yet.";
    if (status.imported) await renderUsageInspect();
  } catch (error) {
    $("usage-status").textContent = operatorMessage(error);
  }
}

$("nav-toggle")?.addEventListener("click", () => {
  const open = !$("sidebar").classList.contains("open");
  $("sidebar").classList.toggle("open", open);
  $("nav-toggle").setAttribute("aria-expanded", String(open));
});

let ccScan = null;
let ccSnapshot = null;
let ccDetailDialog = null;
let ccDetailItem = null;
let ccBucketView = "default";

const CC_SNAPSHOT_VIEWS = [
  { key: "actNow", bucket: "focus_now", label: "Act now" },
  { key: "next", bucket: "next", label: "Next" },
  { key: "later", bucket: "later", label: "Later" },
  { key: "waiting", bucket: "waiting", label: "Waiting" },
];

function setCcBucketView(key) {
  if (key === "default") {
    ccBucketView = "default";
  } else if (ccBucketView === key) {
    ccBucketView = "default";
  } else {
    ccBucketView = key;
  }
  renderCommandCentre();
}

function ccItemsForPresentationBucket(items, bucket) {
  return items.filter((item) => ccPresentationBucket(item) === bucket);
}

function isPrimaryQueueExcluded(item) {
  return ccPresentationBucket(item) === "excluded";
}

function ccPresentationBucket(item) {
  if (item.priority === "P5") return "excluded";
  if (item.effective_queue_state === "SYSTEM_NO_ACTION") return "excluded";
  if (item.next_best_action === "NO_ACTION" && item.action_timing === "NO_ACTION_REQUIRED") return "excluded";
  if (item.operator_control?.controlled && item.operator_control.actionable === false) return "excluded";

  if (
    item.effective_queue_state === "WAIT" ||
    item.executability === "WAITING_FOR_TIME" ||
    item.executability === "WAITING_FOR_CUSTOMER" ||
    item.next_best_action === "WAIT"
  ) {
    return "waiting";
  }

  if (
    (item.priority === "P0" || item.priority === "P1") &&
    item.executability === "EXECUTABLE_NOW" &&
    item.actionability_kind === "CUSTOMER_ACTION" &&
    item.customer_queue !== false
  ) {
    return "focus_now";
  }

  if (item.effective_queue_state === "REVIEW_REQUIRED") return "next";
  if (item.effective_queue_state === "RESEARCH" && item.actionability_kind === "INTERNAL_RESEARCH") return "next";
  if (
    (item.priority === "P2" || item.priority === "P3") &&
    item.actionability_kind === "CUSTOMER_ACTION" &&
    item.customer_queue !== false &&
    item.executability === "EXECUTABLE_NOW"
  ) {
    return "next";
  }

  return "later";
}

function isFocusNowItem(item) {
  return ccPresentationBucket(item) === "focus_now";
}

function isNextItem(item) {
  return ccPresentationBucket(item) === "next";
}

function urgencyLabel(item) {
  const bucket = ccPresentationBucket(item);
  if (bucket === "waiting") {
    const existing = whenLabel(item);
    if (/^WAIT UNTIL/i.test(existing)) return existing;
    return "WAITING";
  }
  if (bucket === "focus_now") {
    if (item.action_timing === "TODAY") return "TODAY";
    return "NOW";
  }
  if (bucket === "next") {
    if (item.action_timing === "TODAY") return "TODAY";
    if (item.action_timing === "SCHEDULED_DATE") return "THIS WEEK";
    if (item.action_due_at) {
      const due = Date.parse(item.action_due_at);
      if (!Number.isNaN(due)) {
        const days = (due - Date.now()) / 86400000;
        if (days <= 1) return "TODAY";
        if (days <= 7) return "THIS WEEK";
      }
    }
    return "NEXT";
  }
  if (bucket === "later") return "LATER";
  return "—";
}

function focusWatchItem(watchItemId) {
  if (!watchItemId || !ccSnapshot) return;
  const item = (ccSnapshot.watch_items || []).find((row) => row.id === watchItemId);
  if (item) openCcDetailDialog(item);
}

function appendSignalBlock(parent, label, signals) {
  if (!signals?.length) return;
  const text = signals.map((signal) => signal.message).filter(Boolean).join(" · ");
  if (!text) return;
  appendKv(parent, label, text);
}

function renderCcCompactCard(item) {
  const card = el("article", {
    class: "cc-item cc-item-compact",
    tabindex: "0",
    role: "button",
    "data-watch-id": item.id,
    "aria-label": `${item.organisation_name || "Unknown"} ${urgencyLabel(item)} ${words(item.next_best_action)}`,
  });
  const head = el("div", { class: "cc-item-head" });
  head.append(
    el("strong", { class: "cc-item-org", text: item.organisation_name || "Unknown" }),
    el("span", { class: "cc-item-urgency", text: urgencyLabel(item) }),
  );
  card.append(head);
  card.append(el("div", { class: "cc-item-product muted", text: watchItemProductLabel(item) }));
  const person = item.recommended_contact_name || item.primary_contact_name;
  if (person) card.append(el("div", { class: "cc-item-person", text: person }));
  card.append(el("div", { class: "cc-item-action", text: words(item.next_best_action) }));
  card.append(el("span", { class: "cc-item-chevron", "aria-hidden": "true", text: "›" }));
  const openDetail = () => openCcDetailDialog(item);
  card.addEventListener("click", openDetail);
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openDetail();
    }
  });
  return card;
}

function renderCcWorkSection(title, items, emptyMessage) {
  const section = el("section", { class: "cc-work-section" });
  section.append(el("div", { class: "cc-work-section-head" }, [
    el("h3", { text: title }),
    el("span", { class: "cc-work-count", text: `${items.length}` }),
  ]));
  if (!items.length) {
    section.append(el("p", { class: "cc-work-empty muted", text: emptyMessage }));
  } else {
    const list = el("div", { class: "cc-queue" });
    for (const item of items) list.append(renderCcCompactCard(item));
    section.append(list);
  }
  return section;
}

function isWorkingRecommendation(item) {
  const bucket = ccPresentationBucket(item);
  return bucket !== "excluded";
}

function ccQueueInsightCounts(items) {
  const counts = { actNow: 0, next: 0, later: 0, waiting: 0 };
  for (const item of items) {
    const bucket = ccPresentationBucket(item);
    if (bucket === "focus_now") counts.actNow += 1;
    else if (bucket === "next") counts.next += 1;
    else if (bucket === "later") counts.later += 1;
    else if (bucket === "waiting") counts.waiting += 1;
  }
  return counts;
}

function ccSystemSummary(snapshot, scan) {
  const monitored = scan?.universe_size ?? snapshot.organisations_discovered ?? 0;
  const analysed = (snapshot.analyses_reused ?? 0) + (snapshot.analyses_refreshed ?? 0);
  const warnings = (snapshot.failures?.length ?? 0) + (snapshot.brief?.warnings?.length ?? 0);
  return `${monitored} organisations monitored · ${analysed} analysed · ${warnings} warning${warnings === 1 ? "" : "s"}`;
}

function renderCcCommercialSnapshot(snapshot) {
  const counts = ccQueueInsightCounts(snapshot.watch_items || []);
  const panel = el("div", { class: "cc-snapshot" });
  const grid = el("div", { class: "cc-snapshot-counts" });
  for (const view of CC_SNAPSHOT_VIEWS) {
    const value = counts[view.key];
    const cell = el("button", {
      type: "button",
      class: `cc-snapshot-count${ccBucketView === view.key ? " is-active" : ""}`,
      "aria-pressed": ccBucketView === view.key ? "true" : "false",
      "aria-label": `${view.label}: ${value} recommendation${value === 1 ? "" : "s"}`,
    });
    cell.append(el("span", { class: "cc-snapshot-count-value", text: String(value) }));
    cell.append(el("span", { class: "cc-snapshot-count-label", text: view.label }));
    cell.addEventListener("click", () => setCcBucketView(view.key));
    grid.append(cell);
  }
  panel.append(grid);
  if (ccBucketView !== "default") {
    const active = CC_SNAPSHOT_VIEWS.find((view) => view.key === ccBucketView);
    const viewBar = el("div", { class: "cc-snapshot-viewbar row" });
    viewBar.append(
      el("span", {
        class: "cc-snapshot-view-label muted",
        text: `Viewing ${active?.label.toLowerCase() ?? "recommendations"} recommendations`,
      }),
    );
    const currentFocus = el("button", { type: "button", class: "secondary cc-snapshot-focus", text: "Current focus" });
    currentFocus.addEventListener("click", () => setCcBucketView("default"));
    viewBar.append(currentFocus);
    panel.append(viewBar);
  }
  panel.append(el("p", { class: "cc-snapshot-summary muted", text: ccSystemSummary(snapshot, ccScan) }));
  panel.append(el("p", { class: "cc-snapshot-asof muted", text: `As of ${formatWhen(snapshot.generated_at)}` }));

  const actions = el("div", { class: "row cc-snapshot-actions" });
  const check = el("button", { type: "button", class: "secondary", text: "Check for changes" });
  check.addEventListener("click", () => runCcScan());
  const refresh = el("button", { type: "button", class: "secondary", text: "Refresh changed items" });
  refresh.addEventListener("click", () => runCcBuild("build_changed"));
  const full = el("button", { type: "button", class: "secondary", text: "Full rebuild" });
  full.addEventListener("click", () => {
    if (confirm("Full rebuild may require many OpenAI calls. Continue?")) runCcBuild("full_rebuild");
  });
  actions.append(check, refresh, full);
  panel.append(actions);
  return panel;
}

function renderCcWorkQueue(snapshot) {
  const items = snapshot.watch_items || [];
  const wrap = el("div", { class: "cc-work" });
  if (ccBucketView !== "default") {
    const active = CC_SNAPSHOT_VIEWS.find((view) => view.key === ccBucketView);
    const filtered = ccItemsForPresentationBucket(items, active.bucket);
    wrap.append(
      renderCcWorkSection(
        active.label,
        filtered,
        `No ${active.label.toLowerCase()} recommendations right now.`,
      ),
    );
    return wrap;
  }
  const focusNow = items.filter(isFocusNowItem);
  const next = items.filter(isNextItem);
  wrap.append(renderCcWorkSection("Focus now", focusNow, "Nothing needs immediate customer contact."));
  wrap.append(renderCcWorkSection("Next", next, "No further queued recommendations right now."));
  return wrap;
}

function ensureCcDetailDialog() {
  if (ccDetailDialog) return ccDetailDialog;
  const dialog = el("dialog", { class: "cc-detail-dialog", id: "cc-detail-dialog" });
  const panel = el("div", { class: "cc-detail-panel" });
  const header = el("div", { class: "cc-detail-header" });
  const title = el("h3", { id: "cc-detail-title", text: "Recommendation" });
  const close = el("button", { type: "button", class: "secondary cc-detail-close", text: "Close", "aria-label": "Close" });
  header.append(title, close);
  const body = el("div", { class: "cc-detail-body", id: "cc-detail-body" });
  const actions = el("div", { class: "cc-detail-actions row", id: "cc-detail-actions" });
  panel.append(header, body, actions);
  dialog.append(panel);
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => {
    ccDetailItem = null;
    body.replaceChildren();
    actions.replaceChildren();
  });
  document.body.append(dialog);
  ccDetailDialog = dialog;
  return dialog;
}

function renderCcDetailContent(item) {
  const body = $("cc-detail-body");
  const actions = $("cc-detail-actions");
  if (!body || !actions) return;
  body.replaceChildren();
  actions.replaceChildren();

  $("cc-detail-title").textContent = item.organisation_name || "Unknown";
  body.append(el("p", { class: "cc-detail-lede muted", text: `${productScopeLabel(item.product_scope)} · ${urgencyLabel(item)} · ${item.priority}` }));

  if (item.commercial_summary) {
    body.append(el("h4", { class: "cc-detail-heading", text: "Why this client matters" }));
    body.append(el("p", { text: item.commercial_summary }));
  }

  body.append(el("h4", { class: "cc-detail-heading", text: "Recommended action" }));
  appendKv(body, "Action", words(item.next_best_action));
  appendKv(body, "Timing", whenLabel(item));
  if (item.why_this_action) appendKv(body, "Reasoning", item.why_this_action);
  if (item.recommended_contact_name || item.primary_contact_name) {
    appendKv(body, "Recommended person", item.recommended_contact_name || item.primary_contact_name);
  }
  if (item.recommended_contact_reason) appendKv(body, "Person rationale", item.recommended_contact_reason);

  if (item.last_meaningful_activity_at || item.next_commitment_at) {
    body.append(el("h4", { class: "cc-detail-heading", text: "Recent activity & commitments" }));
    appendKv(body, "Last meaningful activity", item.last_meaningful_activity_at ? formatWhen(item.last_meaningful_activity_at) : undefined);
    appendKv(body, "Next commitment", item.next_commitment_at ? formatWhen(item.next_commitment_at) : undefined);
  }

  if (item.relationship_state || item.product_registration_state) {
    body.append(el("h4", { class: "cc-detail-heading", text: "Product relationship" }));
    appendKv(body, "Relationship", item.relationship_state ? words(item.relationship_state) : undefined);
    appendKv(body, "Registration", item.product_registration_state ? words(item.product_registration_state) : undefined);
    if (item.product_registration_provenance?.stage) {
      appendKv(body, "Registration source", item.product_registration_provenance.stage);
    }
  }

  const crmSource =
    item.source_record?.module === "Leads"
      ? "Lead"
      : item.lead_ids?.length && !(item.deal_ids?.length)
        ? "Lead"
        : undefined;
  if (crmSource) appendKv(body, "CRM source", crmSource);

  appendSignalBlock(body, "Urgency signals", item.urgency_signals);
  appendSignalBlock(body, "Opportunity signals", item.opportunity_signals);
  appendSignalBlock(body, "Risk signals", item.risk_signals);
  appendSignalBlock(body, "Usage evidence", item.usage_signals);
  appendSignalBlock(body, "Data quality / unknowns", item.data_quality_signals);

  if (item.stalled_reasons?.length) appendKv(body, "Stalled explanation", item.stalled_reasons.join(" "));
  appendKv(body, "Confidence", item.confidence);
  appendKv(body, "System priority", item.system_priority_band || item.priority);
  if (item.why_ranked) appendKv(body, "Rank explanation", item.why_ranked);

  const badgeText = operatorControlBadgeText(item);
  if (badgeText || item.operator_control?.suppression_reason) {
    body.append(el("h4", { class: "cc-detail-heading", text: "Operator control" }));
    if (badgeText) body.append(el("p", { class: "cc-operator-badge", text: badgeText }));
    appendKv(body, "Control detail", item.operator_control?.suppression_reason);
    appendKv(body, "Reopen note", item.operator_control?.reopen_explanation);
  }

  if (item.recommendation_fingerprint || item.evidence_snapshot_ref || item.evidence_refs?.length) {
    body.append(el("h4", { class: "cc-detail-heading", text: "Evidence & provenance" }));
    appendKv(body, "Recommendation fingerprint", item.recommendation_fingerprint);
    appendKv(body, "Evidence snapshot", item.evidence_snapshot_ref);
    if (item.evidence_refs?.length) appendKv(body, "Evidence refs", item.evidence_refs.join(", "));
    appendKv(body, "Analysis generated", item.analysis_generated_at ? formatWhen(item.analysis_generated_at) : undefined);
    appendKv(body, "Reuse", item.reuse ? words(item.reuse) : undefined);
  }

  const manageBtn = el("button", { type: "button", class: "secondary cc-manage-btn", text: "Manage recommendation" });
  manageBtn.addEventListener("click", () => {
    ccDetailDialog?.close();
    openManageDialog(item);
  });
  actions.append(manageBtn);
  if (item.source_record?.module && item.source_record?.recordId) {
    const crmBtn = el("button", { type: "button", class: "secondary", text: "Open in CRM Explorer" });
    crmBtn.addEventListener("click", () => {
      ccDetailDialog?.close();
      location.hash = "explorer";
      openRelationship(item.source_record.module, item.source_record.recordId);
    });
    actions.append(crmBtn);
  }
}

function openCcDetailDialog(item) {
  ccDetailItem = item;
  const dialog = ensureCcDetailDialog();
  renderCcDetailContent(item);
  dialog.showModal();
}

function whenLabel(item) {
  if (item.action_timing === "WAIT_UNTIL" && item.action_due_at) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(item.action_due_at)) return `WAIT UNTIL ${formatDay(item.action_due_at)}`;
    return `WAIT UNTIL ${formatWhen(item.action_due_at)}`;
  }
  if (item.executability === "DATA_REQUIRED") return "USAGE DATA REQUIRED";
  if (item.action_timing === "OVERDUE") return "OVERDUE";
  if (item.action_timing === "TODAY") return "TODAY";
  if (item.executability === "WAITING_FOR_CUSTOMER" || item.stalled_state === "WAITING_ON_CUSTOMER") return "AWAITING CUSTOMER";
  if (item.next_best_action === "NO_ACTION" || item.action_timing === "NO_ACTION_REQUIRED") return "NO ACTION TODAY";
  return words(item.action_timing);
}

const OPERATOR_NOTE_MAX = 4000;
const WAITING_REASON_OPTIONS = [
  { value: "DO_NOT_CHASE", label: "Waiting on customer" },
  { value: "WAITING_ON_US", label: "Waiting on us" },
  { value: "BOARD_MEETING_PENDING", label: "Future commitment" },
  { value: "OTHER", label: "Other" },
];

let ccManageDialog = null;
let ccManageItem = null;

function isoDateDaysFromNow(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function zohoWriteContextFromWatchItem(item) {
  return {
    organisation_key: item.organisation_id,
    source_record: item.source_record,
    contact_ids: item.contact_ids || [],
    lead_ids: item.lead_ids || [],
    deal_ids: item.deal_ids || [],
  };
}

function zohoWriteSucceeded(result) {
  const write = result?.zohoWrite;
  if (!write?.attempted) return true;
  if (write.contact && write.deal) {
    if (write.contact.attempted && !write.contact.ok) return false;
    if (write.deal.attempted && !write.deal.ok) return false;
    return true;
  }
  return Boolean(write.ok);
}

function contextZohoWriteFeedback(result) {
  const write = result?.zohoWrite;
  if (!write?.attempted) {
    return { complete: true, message: null, retryLabel: null };
  }
  const contact = write.contact || {};
  const deal = write.deal || {};
  const contactWritten = Boolean(contact.ok && contact.noteId);
  const dealWritten = Boolean(deal.ok && deal.noteId);
  const contactFailed = Boolean(contact.attempted && !contact.ok);
  const dealFailed = Boolean(deal.attempted && !deal.ok);
  const dealSkipped = Boolean(deal.skipped);

  if (!contactFailed && !dealFailed) {
    return { complete: true, message: null, retryLabel: null };
  }
  if (contactFailed && dealFailed) {
    return {
      complete: false,
      message: "Saved · Contact and deal notes failed",
      retryLabel: "Retry Zoho notes",
    };
  }
  if (contactFailed && dealWritten) {
    return {
      complete: false,
      message: "Saved · Contact note failed — deal note written",
      retryLabel: "Retry contact note",
    };
  }
  if (contactFailed && dealSkipped) {
    return {
      complete: false,
      message: "Saved · Contact note failed — deal note not written",
      retryLabel: "Retry contact note",
    };
  }
  if (dealFailed && contactWritten) {
    return {
      complete: false,
      message: "Saved · Contact note written — deal note failed",
      retryLabel: "Retry deal note",
    };
  }
  if (dealFailed && !contact.attempted) {
    return {
      complete: false,
      message: "Saved · Deal note failed",
      retryLabel: "Retry deal note",
    };
  }
  if (contactFailed) {
    return {
      complete: false,
      message: "Saved · Contact note failed",
      retryLabel: "Retry contact note",
    };
  }
  return {
    complete: false,
    message: "Saved · Zoho note failed",
    retryLabel: "Retry",
  };
}

function contextZohoSuccessMessage(result) {
  const write = result?.zohoWrite;
  if (!write?.attempted) return "Context saved — queue unchanged.";
  const contactWritten = Boolean(write.contact?.ok && write.contact.noteId);
  const dealWritten = Boolean(write.deal?.ok && write.deal.noteId);
  if (contactWritten && dealWritten) return "Context saved · Contact and deal notes written.";
  if (contactWritten) return "Context saved · Contact note written.";
  if (dealWritten) return "Context saved · Deal note written.";
  return "Context saved and written to Zoho.";
}

const ZOHO_WRITE_FAILURE_MESSAGE = "Saved · Zoho note failed — Retry";

function zohoWriteFailureMessage() {
  return ZOHO_WRITE_FAILURE_MESSAGE;
}

function appendZohoRetryButton(body, status, retryFn, label = "Retry") {
  const existing = body.querySelector(".zoho-retry-btn");
  if (existing) existing.remove();
  const retry = el("button", { type: "button", class: "secondary zoho-retry-btn", text: label });
  retry.addEventListener("click", async () => {
    retry.disabled = true;
    try {
      await retryFn();
    } catch (error) {
      status.textContent = operatorMessage(error);
    } finally {
      retry.disabled = false;
    }
  });
  body.append(retry);
}

function decisionPayloadFromWatchItem(item, fields = {}) {
  if (!item.recommendation_fingerprint) {
    throw new Error("Recommendation fingerprint missing. Rebuild the Command Centre before managing this item.");
  }
  return {
    watch_item_id: item.id,
    organisation_key: item.organisation_id,
    product_scope: item.product_scope,
    recommendation_fingerprint: item.recommendation_fingerprint,
    evidence_snapshot_ref: item.evidence_snapshot_ref,
    decision_context_snapshot: item.decision_context_snapshot || {
      deal_ids: item.deal_ids || [],
      recommended_contact_id: item.recommended_contact_id,
      next_best_action: item.next_best_action,
    },
    zoho_write: zohoWriteContextFromWatchItem(item),
    ...fields,
  };
}

function operatorControlBadgeText(item) {
  const control = item.operator_control;
  if (!control?.controlled) return null;
  const type = control.primary_decision_type;
  const until = control.effective_until ? formatDay(control.effective_until) : null;
  const product = words(item.product_scope);
  switch (type) {
    case "SNOOZED":
      return until ? `Snoozed until ${until}` : "Snoozed";
    case "WAITING":
      return control.operator_summary?.toLowerCase().includes("customer")
        ? "Waiting on customer"
        : "Waiting";
    case "DISMISSED":
      return "Dismissed";
    case "RESEARCH_REQUIRED":
      return "Research required";
    case "NOT_AN_OPPORTUNITY":
      return `Not an opportunity — ${product}`;
    case "WRONG_ACTION":
      return "Review required — wrong action";
    case "WRONG_PERSON":
      return "Review required — wrong person";
    case "COMPLETED":
    case "ALREADY_HANDLED":
      return "Handled";
    default:
      return control.operator_summary ? words(control.operator_summary.split("—")[0].trim()) : "Under operator control";
  }
}

function knownPeopleForWatchItem(item) {
  const people = [];
  const seen = new Set();
  function add(id, name) {
    if (!id && !name) return;
    const key = id || name;
    if (seen.has(key)) return;
    seen.add(key);
    people.push({ id: id || "", name: name || "Unknown" });
  }
  add(item.recommended_contact_id, item.recommended_contact_name);
  add(item.primary_contact_id, item.primary_contact_name);
  return people;
}

function ensureManageDialog() {
  if (ccManageDialog) return ccManageDialog;
  const dialog = el("dialog", { class: "cc-manage-dialog", id: "cc-manage-dialog" });
  const panel = el("div", { class: "cc-manage-panel" });
  const header = el("div", { class: "cc-manage-header" });
  const title = el("h3", { id: "cc-manage-title", text: "Manage recommendation" });
  const close = el("button", { type: "button", class: "secondary cc-manage-close", text: "Close", "aria-label": "Close" });
  header.append(title, close);
  const summary = el("div", { class: "cc-manage-summary", id: "cc-manage-summary" });
  const body = el("div", { class: "cc-manage-body", id: "cc-manage-body" });
  const status = el("p", { class: "muted cc-manage-status", id: "cc-manage-status" });
  const provenance = el("details", { class: "cc-manage-provenance", id: "cc-manage-provenance" }, [
    el("summary", { text: "Control history" }),
    el("div", { id: "cc-manage-provenance-body" }),
  ]);
  panel.append(header, summary, body, status, provenance);
  dialog.append(panel);
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => {
    ccManageItem = null;
    body.replaceChildren();
    status.textContent = "";
  });
  document.body.append(dialog);
  ccManageDialog = dialog;
  return dialog;
}

function manageSummaryNodes(item) {
  const nodes = [
    el("div", { class: "cc-manage-kv" }, [el("span", { text: "Organisation" }), el("strong", { text: item.organisation_name || "Unknown" })]),
    el("div", { class: "cc-manage-kv" }, [el("span", { text: "Product" }), el("strong", { text: words(item.product_scope) })]),
    el("div", { class: "cc-manage-kv" }, [el("span", { text: "System priority" }), el("strong", { text: item.system_priority_band || item.priority })]),
    el("div", { class: "cc-manage-kv" }, [el("span", { text: "Recommended person" }), el("strong", { text: item.recommended_contact_name || "Unknown" })]),
    el("div", { class: "cc-manage-kv" }, [el("span", { text: "Recommended action" }), el("strong", { text: words(item.next_best_action) })]),
    el("div", { class: "cc-manage-kv" }, [el("span", { text: "Timing" }), el("strong", { text: whenLabel(item) })]),
  ];
  const badge = operatorControlBadgeText(item);
  if (badge) nodes.push(el("p", { class: "cc-operator-badge", text: badge }));
  return nodes;
}

async function loadManageProvenance(item) {
  const host = $("cc-manage-provenance-body");
  if (!host) return;
  host.replaceChildren(el("p", { class: "muted", text: "Loading…" }));
  try {
    const data = await api(`/api/operator-decisions?watch_item_id=${encodeURIComponent(item.id)}&active_only=false`);
    const decisions = (data.decisions || []).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    host.replaceChildren();
    if (!decisions.length) {
      host.append(el("p", { class: "muted", text: "No operator decisions for this recommendation yet." }));
      return;
    }
    for (const decision of decisions.slice(0, 12)) {
      const row = el("div", { class: "cc-provenance-row" });
      row.append(el("strong", { text: `${formatWhen(decision.created_at)} · ${words(decision.decision_type)}` }));
      row.append(el("div", { text: `Product: ${words(decision.product_scope)}` }));
      if (decision.operator_note) row.append(el("div", { class: "muted", text: decision.operator_note }));
      if (decision.effective_until) row.append(el("div", { class: "muted", text: `Until ${formatDay(decision.effective_until)}` }));
      if (decision.linked_sales_event_id) row.append(el("div", { class: "muted", text: `Linked sales event: ${decision.linked_sales_event_id}` }));
      if (decision.decision_type !== "REVOKED" && decision.id === item.operator_control?.active_decision_ids?.[0]) {
        const undo = el("button", { type: "button", class: "secondary", text: "Undo / Reopen" });
        undo.addEventListener("click", async () => {
          undo.disabled = true;
          try {
            await api(`/api/operator-decisions/${encodeURIComponent(decision.id)}/revoke`, { method: "POST", body: JSON.stringify({}) });
            await refreshCcControl();
            const refreshed = (ccSnapshot?.watch_items || []).find((entry) => entry.id === item.id) || item;
            openManageDialog(refreshed);
            $("cc-manage-status").textContent = "Decision reopened. Queue updated.";
          } catch (error) {
            $("cc-manage-status").textContent = operatorMessage(error);
          } finally {
            undo.disabled = false;
          }
        });
        row.append(undo);
      }
      host.append(row);
    }
  } catch (error) {
    host.replaceChildren(el("p", { class: "warn-text", text: operatorMessage(error) }));
  }
}

async function saveOperatorDecision(item, fields) {
  const body = decisionPayloadFromWatchItem(item, fields);
  if (body.operator_note && body.operator_note.length > OPERATOR_NOTE_MAX) {
    throw new Error(`Note must be ${OPERATOR_NOTE_MAX} characters or fewer.`);
  }
  const data = await api("/api/operator-decisions", { method: "POST", body: JSON.stringify(body) });
  await refreshCcControl();
  return data;
}

async function refreshCcControl() {
  const data = await api("/api/command-centre/refresh-control", { method: "POST", body: "{}" });
  ccSnapshot = data.snapshot || ccSnapshot;
  renderCommandCentre();
}

function manageNoteField(placeholder) {
  const input = el("textarea", { class: "cc-manage-note", rows: "3", maxlength: String(OPERATOR_NOTE_MAX), placeholder });
  return input;
}

function manageActions(buttons, back) {
  const row = el("div", { class: "cc-manage-actions row" });
  if (back) {
    const backBtn = el("button", { type: "button", class: "secondary", text: "Back" });
    backBtn.addEventListener("click", () => openManageDialog(ccManageItem, "menu"));
    row.append(backBtn);
  }
  row.append(...buttons);
  return row;
}

function renderManageMenu(body, item, status) {
  const choices = [
    ["done", "Done"],
    ["snooze", "Snooze"],
    ["waiting", "Waiting"],
    ["dismiss", "Dismiss"],
    ["not-opportunity", "Not an opportunity"],
    ["wrong-action", "Wrong action"],
    ["wrong-person", "Wrong person"],
    ["research", "Needs research"],
    ["already-handled", "Already handled"],
    ["context", "Add context"],
  ];
  const grid = el("div", { class: "cc-manage-menu" });
  for (const [step, label] of choices) {
    const btn = el("button", { type: "button", class: "secondary", text: label });
    btn.addEventListener("click", () => openManageDialog(item, step));
    grid.append(btn);
  }
  body.append(grid);
  if (item.operator_control?.active_decision_ids?.length) {
    const undo = el("button", { type: "button", text: "Undo active control" });
    undo.addEventListener("click", async () => {
      undo.disabled = true;
      status.textContent = "Reopening…";
      try {
        const id = item.operator_control.active_decision_ids[0];
        await api(`/api/operator-decisions/${encodeURIComponent(id)}/revoke`, { method: "POST", body: JSON.stringify({}) });
        await refreshCcControl();
        const refreshed = (ccSnapshot?.watch_items || []).find((entry) => entry.id === item.id) || item;
        openManageDialog(refreshed, "menu");
        status.textContent = "Control reopened. Queue updated.";
      } catch (error) {
        status.textContent = operatorMessage(error);
      } finally {
        undo.disabled = false;
      }
    });
    body.append(undo);
  }
}

function renderSalesEventCapture(body, item, status, completionDecisionType) {
  body.append(el("p", { class: "muted", text: "Record what actually happened with the customer. This saves locally and writes a Zoho Note when write-back is enabled." }));
  let lastSavedEvent = null;
  const dialog = ensureManageDialog();
  const contactSelect = el("select");
  contactSelect.append(el("option", { value: "", text: "Organisation level" }));
  for (const person of knownPeopleForWatchItem(item)) {
    const option = el("option", { value: person.id, text: person.name });
    option.dataset.name = person.name;
    if (person.id === item.recommended_contact_id) option.selected = true;
    contactSelect.append(option);
  }
  const productSelect = el("select", {}, optionList(SALES_EVENT_SCOPES, item.product_scope));
  const typeSelect = el("select", {}, optionList(SALES_EVENT_TYPES, "PHONE_CALL"));
  const outcomeSelect = el("select", {}, optionList(SALES_EVENT_OUTCOMES, "NO_ANSWER"));
  const occurred = el("input", { type: "datetime-local", value: localDateTimeValue() });
  const summary = el("input", { type: "text", placeholder: "What happened (required)", maxlength: "4000" });
  const nextStep = el("input", { type: "text", placeholder: "Agreed next step (optional)", maxlength: "500" });
  const followUp = el("input", { type: "date" });
  const form = el("div", { class: "event-form" });
  for (const [label, node, wide] of [
    ["Contact", contactSelect],
    ["Product", productSelect],
    ["Event type", typeSelect],
    ["Outcome", outcomeSelect],
    ["Date/time", occurred],
    ["Follow-up date", followUp],
    ["What happened", summary, true],
    ["Agreed next step", nextStep, true],
  ]) {
    form.append(el("label", { class: wide ? "wide" : "" }, [el("span", { text: label }), node]));
  }
  body.append(form);
  const save = el("button", { type: "button", text: "Save customer interaction" });
  save.addEventListener("click", async () => {
    if (!summary.value.trim()) {
      status.textContent = "What happened is required.";
      return;
    }
    save.disabled = true;
    status.textContent = "Saving…";
    try {
      const contactId = contactSelect.value;
      const contactName = contactSelect.selectedOptions[0]?.dataset?.name || contactSelect.selectedOptions[0]?.text || "";
      const eventBody = {
        organisation_id: item.organisation_id,
        contact_id: contactId,
        contact_name: contactId ? contactName : "",
        product_scope: productSelect.value,
        event_type: typeSelect.value,
        outcome: outcomeSelect.value,
        occurred_at: occurred.value ? new Date(occurred.value).toISOString() : new Date().toISOString(),
        summary: summary.value.trim(),
        next_step: nextStep.value.trim(),
        follow_up_date: followUp.value || "",
        zoho_write: zohoWriteContextFromWatchItem(item),
      };
      const data = await api("/api/sales-events", { method: "POST", body: JSON.stringify(eventBody) });
      lastSavedEvent = data.event;
      await saveOperatorDecision(item, {
        decision_type: completionDecisionType,
        linked_sales_event_id: data.event.id,
      });
      if (!zohoWriteSucceeded(data)) {
        status.textContent = zohoWriteFailureMessage();
        appendZohoRetryButton(body, status, async () => {
          const retried = await api(`/api/sales-events/${encodeURIComponent(lastSavedEvent.id)}/retry-zoho`, {
            method: "POST",
            body: JSON.stringify({ zoho_write: zohoWriteContextFromWatchItem(item) }),
          });
          lastSavedEvent = retried.event;
          if (!zohoWriteSucceeded(retried)) {
            status.textContent = zohoWriteFailureMessage();
            return;
          }
          dialog.close();
          $("cc-status").textContent = "Customer interaction saved and written to Zoho.";
        });
        return;
      }
      dialog.close();
      $("cc-status").textContent = data.writtenToZoho
        ? "Customer interaction saved and written to Zoho."
        : completionDecisionType === "ALREADY_HANDLED"
          ? "Customer interaction recorded. Recommendation marked already handled."
          : "Customer interaction saved and recommendation completed.";
    } catch (error) {
      status.textContent = operatorMessage(error);
    } finally {
      save.disabled = false;
    }
  });
  body.append(manageActions([save], true));
}

function openManageDialog(item, step = "menu") {
  ccManageItem = item;
  const dialog = ensureManageDialog();
  const summary = $("cc-manage-summary");
  const body = $("cc-manage-body");
  const status = $("cc-manage-status");
  summary.replaceChildren(...manageSummaryNodes(item));
  body.replaceChildren();
  status.textContent = "";
  void loadManageProvenance(item);

  if (step === "menu") {
    renderManageMenu(body, item, status);
    dialog.showModal();
    return;
  }

  if (step === "dismiss") {
    const note = manageNoteField("Optional reason");
    body.append(el("p", { text: "Dismiss this recommendation from your action queue." }), note);
    const save = el("button", { type: "button", text: "Save dismiss" });
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        await saveOperatorDecision(item, { decision_type: "DISMISSED", operator_note: note.value.trim() || undefined });
        dialog.close();
        $("cc-status").textContent = "Dismissed — removed from action queue. No CRM changes.";
      } catch (error) {
        status.textContent = operatorMessage(error);
      } finally {
        save.disabled = false;
      }
    });
    body.append(manageActions([save], true));
    dialog.showModal();
    return;
  }

  if (step === "snooze") {
    const dateInput = el("input", { type: "date" });
    const min = isoDateDaysFromNow(1);
    dateInput.min = min;
    dateInput.value = min;
    const quick = el("div", { class: "row cc-snooze-quick" });
    for (const [label, days] of [["Tomorrow", 1], ["3 days", 3], ["1 week", 7]]) {
      const btn = el("button", { type: "button", class: "secondary", text: label });
      btn.addEventListener("click", () => { dateInput.value = isoDateDaysFromNow(days); });
      quick.append(btn);
    }
    body.append(el("p", { text: "Snooze until a future date." }), quick, el("label", {}, [el("span", { text: "Resume date" }), dateInput]));
    const save = el("button", { type: "button", text: "Save snooze" });
    save.addEventListener("click", async () => {
      if (!dateInput.value || dateInput.value < isoDateDaysFromNow(0)) {
        status.textContent = "Choose a future date.";
        return;
      }
      save.disabled = true;
      try {
        await saveOperatorDecision(item, { decision_type: "SNOOZED", effective_until: dateInput.value });
        dialog.close();
        $("cc-status").textContent = `Snoozed until ${formatDay(dateInput.value)}.`;
      } catch (error) {
        status.textContent = operatorMessage(error);
      } finally {
        save.disabled = false;
      }
    });
    body.append(manageActions([save], true));
    dialog.showModal();
    return;
  }

  if (step === "waiting") {
    const reason = el("select", {}, WAITING_REASON_OPTIONS.map((option) => el("option", { value: option.value, text: option.label })));
    const followUp = el("input", { type: "date" });
    const note = manageNoteField("Optional note");
    body.append(el("p", { text: "Mark as waiting. This does not create a CRM task." }), reason, el("label", {}, [el("span", { text: "Optional follow-up date" }), followUp]), note);
    const save = el("button", { type: "button", text: "Save waiting" });
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        let reasonCode = reason.value;
        let operatorNote = note.value.trim() || undefined;
        if (reasonCode === "WAITING_ON_US") {
          reasonCode = "OTHER";
          operatorNote = operatorNote ? `Waiting on us: ${operatorNote}` : "Waiting on us.";
        }
        await saveOperatorDecision(item, {
          decision_type: "WAITING",
          reason_code: reasonCode,
          operator_note: operatorNote,
          effective_until: followUp.value || undefined,
        });
        dialog.close();
        $("cc-status").textContent = "Marked as waiting.";
      } catch (error) {
        status.textContent = operatorMessage(error);
      } finally {
        save.disabled = false;
      }
    });
    body.append(manageActions([save], true));
    dialog.showModal();
    return;
  }

  if (step === "not-opportunity") {
    const note = manageNoteField("Optional reason");
    const productLabel = words(item.product_scope);
    const other = item.product_scope === "PORTAL_GENIE" ? "Nagging Panda" : "Portal Genie";
    body.append(
      el("p", { class: "cc-manage-warning", text: `Not an opportunity for: ${item.organisation_name || "Unknown"} — ${productLabel}` }),
      el("p", { class: "muted", text: `This will NOT suppress ${other}.` }),
      note,
    );
    const save = el("button", { type: "button", text: "Confirm not an opportunity" });
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        await saveOperatorDecision(item, { decision_type: "NOT_AN_OPPORTUNITY", operator_note: note.value.trim() || undefined });
        dialog.close();
        $("cc-status").textContent = `Not an opportunity for ${productLabel}. Other products unaffected.`;
      } catch (error) {
        status.textContent = operatorMessage(error);
      } finally {
        save.disabled = false;
      }
    });
    body.append(manageActions([save], true));
    dialog.showModal();
    return;
  }

  if (step === "wrong-action") {
    const note = manageNoteField('Optional correction, e.g. "Email rather than call."');
    body.append(el("p", { text: "The recommended action is wrong. The opportunity stays visible for review." }), note);
    const save = el("button", { type: "button", text: "Save wrong action" });
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        await saveOperatorDecision(item, { decision_type: "WRONG_ACTION", operator_note: note.value.trim() || undefined, explicit_quality_feedback: "WRONG_ACTION" });
        dialog.close();
        $("cc-status").textContent = "Wrong action recorded — review required.";
      } catch (error) {
        status.textContent = operatorMessage(error);
      } finally {
        save.disabled = false;
      }
    });
    body.append(manageActions([save], true));
    dialog.showModal();
    return;
  }

  if (step === "wrong-person") {
    const people = knownPeopleForWatchItem(item);
    const personSelect = el("select");
    personSelect.append(el("option", { value: "", text: "Select known person (optional)" }));
    for (const person of people) {
      if (person.id === item.recommended_contact_id) continue;
      const option = el("option", { value: person.id, text: person.name });
      option.dataset.name = person.name;
      personSelect.append(option);
    }
    const note = manageNoteField('If not listed, add a short note, e.g. "Speak to Sarah in finance."');
    body.append(
      el("p", { text: `Recommended: ${item.recommended_contact_name || "Unknown"}` }),
      personSelect,
      note,
    );
    const save = el("button", { type: "button", text: "Save wrong person" });
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        const selected = personSelect.selectedOptions[0];
        await saveOperatorDecision(item, {
          decision_type: "WRONG_PERSON",
          preferred_contact_id: personSelect.value || undefined,
          preferred_contact_name: selected?.dataset?.name || undefined,
          operator_note: note.value.trim() || undefined,
          explicit_quality_feedback: "WRONG_PERSON",
        });
        dialog.close();
        $("cc-status").textContent = "Wrong person recorded — review required.";
      } catch (error) {
        status.textContent = operatorMessage(error);
      } finally {
        save.disabled = false;
      }
    });
    body.append(manageActions([save], true));
    dialog.showModal();
    return;
  }

  if (step === "research") {
    const note = manageNoteField('Optional note, e.g. "Need to establish who owns partnerships."');
    body.append(el("p", { text: "Move to research / data required." }), note);
    const save = el("button", { type: "button", text: "Save research required" });
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        await saveOperatorDecision(item, { decision_type: "RESEARCH_REQUIRED", operator_note: note.value.trim() || undefined });
        dialog.close();
        $("cc-status").textContent = "Marked as research required.";
      } catch (error) {
        status.textContent = operatorMessage(error);
      } finally {
        save.disabled = false;
      }
    });
    body.append(manageActions([save], true));
    dialog.showModal();
    return;
  }

  if (step === "context") {
    const note = manageNoteField('e.g. "Sarah is actually the decision maker."');
    body.append(el("p", { text: "Add operator context without recording a customer interaction." }), note);
    const save = el("button", { type: "button", text: "Save context" });
    save.addEventListener("click", async () => {
      if (!note.value.trim()) {
        status.textContent = "Enter a short note.";
        return;
      }
      save.disabled = true;
      try {
        const data = await saveOperatorDecision(item, { decision_type: "CONTEXT_ADDED", operator_note: note.value.trim() });
        const feedback = contextZohoWriteFeedback(data);
        if (!feedback.complete) {
          status.textContent = feedback.message;
          const retryContextZoho = async () => {
            const retried = await api(`/api/operator-decisions/${encodeURIComponent(data.decision.id)}/retry-zoho`, {
              method: "POST",
              body: JSON.stringify({ zoho_write: zohoWriteContextFromWatchItem(item) }),
            });
            const retryFeedback = contextZohoWriteFeedback(retried);
            if (!retryFeedback.complete) {
              status.textContent = retryFeedback.message;
              appendZohoRetryButton(body, status, retryContextZoho, retryFeedback.retryLabel || "Retry");
              return;
            }
            dialog.close();
            $("cc-status").textContent = contextZohoSuccessMessage(retried);
          };
          appendZohoRetryButton(body, status, retryContextZoho, feedback.retryLabel || "Retry");
          return;
        }
        dialog.close();
        $("cc-status").textContent = data.writtenToZoho
          ? contextZohoSuccessMessage(data)
          : "Context saved — queue unchanged.";
      } catch (error) {
        status.textContent = operatorMessage(error);
      } finally {
        save.disabled = false;
      }
    });
    body.append(manageActions([save], true));
    dialog.showModal();
    return;
  }

  if (step === "done") {
    body.append(el("p", { text: "What happened?" }));
    const customer = el("button", { type: "button", text: "Customer interaction" });
    const internal = el("button", { type: "button", class: "secondary", text: "Internal / review only" });
    customer.addEventListener("click", () => openManageDialog(item, "done-customer"));
    internal.addEventListener("click", () => openManageDialog(item, "done-internal"));
    body.append(el("div", { class: "row" }, [customer, internal]));
    body.append(manageActions([], true));
    dialog.showModal();
    return;
  }

  if (step === "done-internal") {
    const note = manageNoteField("Optional note about internal work completed");
    body.append(el("p", { text: "Record internal work only — not a customer interaction." }), note);
    const save = el("button", { type: "button", text: "Save done (internal)" });
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        await saveOperatorDecision(item, { decision_type: "COMPLETED", operator_note: note.value.trim() || undefined });
        dialog.close();
        $("cc-status").textContent = "Internal work recorded. No Sales Event created.";
      } catch (error) {
        status.textContent = operatorMessage(error);
      } finally {
        save.disabled = false;
      }
    });
    body.append(manageActions([save], true));
    dialog.showModal();
    return;
  }

  if (step === "done-customer") {
    renderSalesEventCapture(body, item, status, "COMPLETED");
    dialog.showModal();
    return;
  }

  if (step === "already-handled") {
    body.append(el("p", { text: "Was there a real customer interaction for this recommendation?" }));
    const yes = el("button", { type: "button", text: "Yes — record interaction" });
    const no = el("button", { type: "button", class: "secondary", text: "No — already dealt with" });
    yes.addEventListener("click", () => openManageDialog(item, "already-handled-customer"));
    no.addEventListener("click", () => openManageDialog(item, "already-handled-only"));
    body.append(el("div", { class: "row" }, [yes, no]));
    body.append(manageActions([], true));
    dialog.showModal();
    return;
  }

  if (step === "already-handled-only") {
    const note = manageNoteField("Optional note");
    body.append(el("p", { text: "Mark recommendation as already handled without fabricating customer activity." }), note);
    const save = el("button", { type: "button", text: "Save already handled" });
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        await saveOperatorDecision(item, { decision_type: "ALREADY_HANDLED", operator_note: note.value.trim() || undefined });
        dialog.close();
        $("cc-status").textContent = "Marked as already handled.";
      } catch (error) {
        status.textContent = operatorMessage(error);
      } finally {
        save.disabled = false;
      }
    });
    body.append(manageActions([save], true));
    dialog.showModal();
    return;
  }

  if (step === "already-handled-customer") {
    renderSalesEventCapture(body, item, status, "ALREADY_HANDLED");
    dialog.showModal();
  }
}

function renderCommandCentre() {
  const root = $("cc-root");
  const status = $("cc-status");
  if (!root) return;
  root.replaceChildren();
  const snapshot = ccSnapshot;
  if (!snapshot) {
    status.textContent = "No Sales Command Centre snapshot yet. Scan CRM first. Scanning does not call OpenAI.";
    const empty = el("div", { class: "card callout" });
    empty.append(el("h3", { text: "No Sales Command Centre snapshot yet." }));
    empty.append(el("p", { text: "Scan discovers organisations and estimates reuse. It does not analyse the book or call OpenAI." }));
    const scanBtn = el("button", { type: "button", text: "Scan CRM" });
    scanBtn.addEventListener("click", () => runCcScan());
    empty.append(scanBtn);
    root.append(empty);
    if (ccScan) root.append(renderCcScanDetails(ccScan, true));
    return;
  }
  status.textContent = "";

  root.append(renderCcCommercialSnapshot(snapshot));
  root.append(renderCcWorkQueue(snapshot));
  if (ccScan || snapshot.truncated_reason) {
    root.append(renderCcScanDetails(ccScan, false, snapshot));
  }
}

function renderCcScanDetails(scan, allowBuild, snapshot) {
  const details = el("details", { class: "cc-scan-details" });
  details.append(el("summary", { text: "Scan details" }));
  const body = el("div", { class: "cc-scan-details-body" });
  if (!scan) {
    body.append(el("p", { class: "muted", text: "Run Check for changes to refresh the scan estimate." }));
    if (snapshot?.truncated_reason) body.append(el("p", { class: "warn-text", text: snapshot.truncated_reason }));
    details.append(body);
    return details;
  }
  const universe = scan.universe_size && scan.universe_size !== scan.organisations_discovered
    ? `${scan.organisations_discovered} of ${scan.universe_size}`
    : String(scan.organisations_discovered);
  body.append(el("p", { text: `${universe} organisations in last scan. ${scan.analyses_reusable} analyses can be reused. ${scan.analyses_require_refresh} require refresh.` }));
  body.append(el("p", { class: "muted", text: `OpenAI would be called for ${scan.openai_would_be_called} organisation(s). Scan itself used 0 OpenAI calls.` }));
  if (scan.truncated_reason) body.append(el("p", { class: "warn-text", text: scan.truncated_reason }));
  if (snapshot?.truncated_reason && snapshot.truncated_reason !== scan.truncated_reason) {
    body.append(el("p", { class: "warn-text", text: snapshot.truncated_reason }));
  }
  for (const warning of scan.retrieval_warnings || []) body.append(el("p", { class: "warn-text", text: warning }));
  if (scan.organisations?.length) {
    const reuseNotes = scan.organisations
      .filter((item) => item.reuse_reason)
      .slice(0, 8)
      .map((item) => `${item.organisation_name}: ${item.reuse} — ${item.reuse_reason}`);
    if (reuseNotes.length) body.append(listBlock("Why reuse or refresh", reuseNotes));
  }
  if (allowBuild) {
    const build = el("button", { type: "button", class: "secondary", text: "Build Command Centre" });
    build.addEventListener("click", () => runCcBuild("build_changed"));
    body.append(build);
  }
  details.append(body);
  return details;
}

function renderCcScan(scan, allowBuild) {
  return renderCcScanDetails(scan, allowBuild);
}

async function loadCommandCentre() {
  const status = $("cc-status");
  try {
    const data = await api("/api/command-centre/snapshot");
    ccSnapshot = data.snapshot || null;
    ccScan = data.lastScan || ccScan;
    renderCommandCentre();
  } catch (error) {
    ccSnapshot = null;
    renderCommandCentre();
    const message = operatorMessage(error);
    if (status && !/not found/i.test(message)) status.textContent = message;
  }
}

async function runCcScan() {
  const status = $("cc-status");
  status.textContent = "Scanning CRM… OpenAI is not called.";
  try {
    ccScan = await api("/api/command-centre/scan", { method: "POST", body: "{}" });
    renderCommandCentre();
    status.textContent = ccScan.truncated_reason
      ? `Scan complete. ${ccScan.truncated_reason} OpenAI was not called.`
      : `Scan complete. ${ccScan.organisations_discovered} organisations. OpenAI was not called.`;
  } catch (error) {
    status.textContent = operatorMessage(error);
  }
}

async function runCcBuild(mode) {
  const status = $("cc-status");
  status.textContent = mode === "full_rebuild"
    ? "Full rebuild in progress. This may call OpenAI."
    : "Building Command Centre for changed items…";
  try {
    const data = await api("/api/command-centre/build", {
      method: "POST",
      body: JSON.stringify({ mode, confirm: true, includeBriefSynthesis: true }),
    });
    ccSnapshot = data.snapshot;
    renderCommandCentre();
  } catch (error) {
    status.textContent = operatorMessage(error);
  }
}

window.addEventListener("hashchange", showPage);
showPage();
refreshStatus();
loadUsageStatus();
if (/oauth=connected/.test(location.hash)) {
  $("connect-status").textContent = "Zoho connected. The grant code was exchanged on the server and is not kept in the URL.";
}
if (/oauth=error/.test(location.hash)) {
  $("connect-status").textContent = "OAuth connection failed. Check redirect URI, scopes, and server-side client credentials.";
}
