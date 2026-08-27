const $ = (id) => document.getElementById(id);

const PAGE_CONTEXT = {
  overview: { kicker: "Mission control", title: "Overview" },
  explorer: { kicker: "Workspace", title: "CRM Explorer" },
  usage: { kicker: "Product evidence", title: "Usage Intelligence" },
  pipeline: { kicker: "Coming later", title: "Pipeline Intelligence" },
  settings: { kicker: "Connections", title: "Settings" },
};

function showPage() {
  const hash = (location.hash || "#overview").replace("#", "").split("?")[0];
  const page = PAGE_CONTEXT[hash] ? hash : "overview";
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
  const date = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
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
  try {
    const openai = await api("/api/intelligence/status");
    openaiNode.textContent = openai.configured ? "Ready" : "Not configured";
    openaiNode.className = `status-value ${openai.configured ? "ok" : "warn"}`;
  } catch {
    openaiNode.textContent = "Error";
    openaiNode.className = "status-value bad";
  }
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
    kv("Access", "Read-only"),
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

function kv(label, value) {
  const wrap = el("div", { class: "kv" });
  wrap.append(el("div", { class: "muted", text: label }), el("div", { text: value }));
  return wrap;
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
  async function showAnalysis(analysis, fromCache) {
    latestAnalysis = analysis || latestAnalysis;
    reanalyseButton.hidden = !analysis;
    if (fromCache && analysis?.success) {
      analyseStatus.textContent = `Last analysis ${formatWhen(analysis.analysedAt)}. Nothing was written to Zoho.`;
    }
    renderSalesEventPanel(salesPanel, moduleName, id, latestAnalysis, runAnalysis);
    snapshotSection.hidden = Boolean(analysis?.profile);
    if (!snapshotSection.hidden) renderSnapshot(snapshot, view, usage, latestAnalysis);
    updateIdentityBadges(badges, view, latestAnalysis);
    if (!analysis) return;
    renderIntelligence(analyseResult, analysis, moduleName, id, view, usage);
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
      if (data.analysed) showAnalysis(data.analysis, true);
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
  const usageBlock = el("details", { class: "panel" }, [el("summary", { text: "Portal Genie usage" })]);
  usageBlock.append(el("p", { text: usage?.label || "USAGE UNKNOWN" }));
  usageBlock.append(el("p", { class: "muted", text: usage?.message || "Product usage is unknown, not assumed to be zero. This is not Zoho data." }));
  for (const item of usage?.profiles || []) {
    usageBlock.append(
      kv("Match", item.matchMethod || "matched"),
      kv("Registered", item.registered ? item.registrationDate || "Yes" : "Not evidenced"),
      kv("Accounting", item.accountingSoftware ? `${item.accountingSoftware} · connected=${item.accountingConnected}` : "Unknown"),
      kv("Activation", fieldValue(item.activationState)),
      kv("Last activity", fieldValue(item.lastActivity)),
      kv("Paying", fieldValue(item.paying)),
    );
  }
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
    $("usage-status").textContent = `Imported ${result.rowCount} row(s) from ${result.file}.`;
  } catch (error) {
    $("usage-status").textContent = operatorMessage(error);
  }
});

async function loadUsageStatus() {
  try {
    const status = await api("/api/usage/status");
    $("usage-status").textContent = status.imported
      ? `Last import: ${status.rowCount} row(s) from ${status.file || "usage-import.json"}`
      : "No usage file imported yet.";
  } catch (error) {
    $("usage-status").textContent = operatorMessage(error);
  }
}

$("nav-toggle")?.addEventListener("click", () => {
  const open = !$("sidebar").classList.contains("open");
  $("sidebar").classList.toggle("open", open);
  $("nav-toggle").setAttribute("aria-expanded", String(open));
});

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
