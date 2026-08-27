const $ = (id) => document.getElementById(id);

function showPage() {
  const hash = (location.hash || "#explorer").replace("#", "").split("?")[0];
  for (const id of ["explorer", "usage", "settings"]) {
    $(`page-${id}`).classList.toggle("hidden", id !== hash);
  }
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
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
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

async function refreshStatus() {
  try {
    const status = await api("/api/zoho/status");
    const pill = $("zoho-pill");
    pill.textContent = `Zoho: ${status.status.replaceAll("_", " ")}`;
    pill.className = `pill ${status.status === "connected" ? "ok" : status.status === "not_connected" ? "warn" : "bad"}`;
    renderConnection(status);
  } catch (error) {
    $("zoho-pill").textContent = "Zoho: connection error";
    $("zoho-pill").className = "pill bad";
  }
}

function renderConnection(status) {
  const card = $("connection-card");
  card.replaceChildren();
  card.append(
    el("h2", { text: "Connection Status" }),
    el("p", {}, [el("span", { class: `pill ${status.status === "connected" ? "ok" : status.status === "not_connected" ? "warn" : "bad"}`, text: status.status.replaceAll("_", " ") })]),
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

$("search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const q = $("search-q").value.trim();
  $("search-status").textContent = "Searching…";
  $("search-results").replaceChildren();
  $("relationship").replaceChildren();
  try {
    const data = await api(`/api/crm/search?q=${encodeURIComponent(q)}`);
    $("search-status").textContent = `${data.hits.length} result(s) across Contacts, Leads, and Accounts. Ambiguous matches are listed separately.`;
    if (data.warnings?.length) {
      $("search-status").textContent += ` ${data.warnings.join(" ")}`;
    }
    for (const hit of data.hits) {
      const card = el("div", { class: "hit" });
      card.append(
        el("strong", { text: hit.name || hit.email || hit.id }),
        el("div", { class: "muted", text: `${hit.module} · ${hit.id}` }),
        el("div", { text: [hit.email, hit.company].filter(Boolean).join(" · ") }),
      );
      card.addEventListener("click", () => openRelationship(hit.module, hit.id));
      $("search-results").append(card);
    }
  } catch (error) {
    $("search-status").textContent = error.message;
  }
});

async function openRelationship(moduleName, id) {
  $("relationship").replaceChildren(el("p", { class: "muted", text: "Loading relationship…" }));
  try {
    const data = await api(`/api/crm/relationship?module=${encodeURIComponent(moduleName)}&id=${encodeURIComponent(id)}`);
    renderRelationship(data.view, data.usage, moduleName, id);
  } catch (error) {
    $("relationship").replaceChildren(el("p", { text: error.message }));
  }
}

function renderRelationship(view, usage, moduleName, id) {
  const root = $("relationship");
  root.replaceChildren();
  root.append(
    el("div", { class: "block" }, [
      el("h2", { text: view.header.company || view.header.name }),
      el("p", { text: [view.header.name, view.header.email, view.header.country].filter(Boolean).join(" · ") }),
      el("p", { class: "muted", text: `${view.header.module} ${view.header.id} · read-only` }),
    ]),
  );

  const intelligence = el("div", { id: "intelligence-panel", class: "block" });
  intelligence.append(
    el("h3", { text: "Commercial intelligence" }),
    el("p", { class: "muted", text: "Analysis runs only when you ask. It is not refreshed automatically." }),
  );
  const analyseRow = el("div", { class: "row" });
  const analyseButton = el("button", { type: "button", text: "ANALYSE COMMERCIAL OPPORTUNITY" });
  const reanalyseButton = el("button", { type: "button", class: "secondary", text: "Re-analyse" });
  reanalyseButton.hidden = true;
  const analyseStatus = el("p", { class: "muted", id: "analyse-status" });
  const salesPanel = el("div", { id: "sales-event-panel" });
  const analyseResult = el("div", { id: "analyse-result" });
  analyseRow.append(analyseButton, reanalyseButton);
  intelligence.append(analyseRow, analyseStatus, salesPanel, analyseResult);
  root.append(intelligence);

  let latestAnalysis = null;

  async function showAnalysis(analysis, fromCache) {
    latestAnalysis = analysis || latestAnalysis;
    reanalyseButton.hidden = !analysis;
    if (fromCache && analysis?.success) {
      analyseStatus.textContent = `Last analysis ${formatWhen(analysis.analysedAt)} · ${analysis.model} · not re-run on refresh`;
    }
    renderSalesEventPanel(salesPanel, moduleName, id, latestAnalysis, runAnalysis);
    if (!analysis) return;
    renderIntelligence(analyseResult, analysis, moduleName, id);
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
      analyseStatus.textContent = data.analysis?.success ? "Analysis complete. Nothing was written to Zoho." : data.analysis?.error || "Analysis failed.";
      showAnalysis(data.analysis, false);
    } catch (error) {
      analyseStatus.textContent = error.message;
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


  if (usage) {
    const usageBlock = el("div", { class: "block" }, [el("h3", { text: "Portal Genie" })]);
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
    root.append(usageBlock);
  }

  if (view.account) {
    const account = el("div", { class: "block" }, [el("h3", { text: "Account" })]);
    for (const key of ["Account_Name", "Website", "Industry", "Billing_Country", "Phone", "Owner"]) {
      if (view.account[key] != null && view.account[key] !== "") {
        account.append(kv(key.replaceAll("_", " "), fieldValue(view.account[key]?.name ?? view.account[key])));
      }
    }
    account.append(kv("Zoho ID", fieldValue(view.account.id)));
    root.append(account);
  }

  const overview = el("div", { class: "block" }, [el("h3", { text: "Overview" })]);
  for (const field of view.overview) overview.append(kv(field.label, fieldValue(field.value)));
  root.append(overview);

  const caps = el("div", { class: "caps block" });
  caps.append(el("h3", { text: "Relationship" }));
  for (const cap of view.capabilities) {
    const node = el("div", { class: `cap ${cap.status}` });
    node.append(el("div", { text: cap.label }), el("div", { class: "status", text: cap.status }));
    node.append(el("div", { text: capabilityLine(cap) }));
    caps.append(node);
  }
  root.append(caps);

  const timeline = el("div", { class: "block" }, [el("h3", { text: "Timeline" })]);
  if (!view.timeline.length) {
    timeline.append(el("p", { class: "muted", text: "No dated CRM events were returned. Missing timestamps are not invented." }));
  } else {
    const list = el("ul", { class: "timeline" });
    for (const event of view.timeline) {
      const item = el("li");
      item.append(
        el("time", { text: formatWhen(event.at) }),
        el("strong", { text: ` ${event.type.replaceAll("_", " ")}` }),
        el("div", { text: event.title }),
      );
      if (event.preview) item.append(el("div", { class: "muted", text: event.preview }));
      const details = el("details", {}, [el("summary", { text: "Inspect" })]);
      const directionLabel = event.direction ? ` · ${event.direction}` : "";
      details.append(el("div", { class: "muted", text: `Source: ${event.sourceId || "n/a"} · ${event.moduleHint || ""}${directionLabel}` }));
      const matching = (view.normalizedEmails || []).find((email) => email.messageId === event.sourceId);
      if (matching?.bodyText) {
        details.append(el("pre", { text: matching.bodyText.slice(0, 4000) }));
      } else if (event.type.startsWith("email") && event.sourceId) {
        const button = el("button", { type: "button", text: "Load email body" });
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            const email = await api(`/api/crm/email?module=${encodeURIComponent(moduleName)}&id=${encodeURIComponent(id)}&messageId=${encodeURIComponent(event.sourceId)}`);
            const content = email.normalized?.bodyText || "";
            details.append(el("pre", { text: content ? content.slice(0, 4000) : "No cleaned body was returned." }));
          } catch (error) {
            details.append(el("p", { text: error.message }));
          }
        });
        details.append(button);
      }
      item.append(details);
      list.append(item);
    }
    timeline.append(list);
  }
  root.append(timeline);

  const emailCap = view.capabilities.find((item) => item.key === "Emails");
  const emailRows = view.normalizedEmails?.length ? view.normalizedEmails : view.emails?.headers;
  renderCapabilityList(root, "Emails", emailCap, emailRows, (email) => {
    const direction = email.direction || (email.sent === false ? "inbound" : email.sent === true ? "outbound" : "unknown");
    const when = formatWhen(email.at || email.time) || "no timestamp";
    return `${email.subject || "Email"} · ${direction} · ${when}`;
  });
  renderCapabilityList(root, "Notes", view.capabilities.find((item) => item.key === "Notes"), view.notes, (note) => `${note.Note_Title || "Note"} — ${(note.Note_Content || "").toString().slice(0, 240)}`);
  renderCapabilityList(root, "Deals", view.capabilities.find((item) => item.key === "Deals"), view.deals, (deal) => `${deal.Deal_Name || "Deal"} · ${deal.Stage || ""}`);
  renderCapabilityList(root, "Tasks", view.capabilities.find((item) => item.key === "Tasks"), view.tasks, (task) => `${task.Subject || "Task"} · ${task.Status || ""}`);
  renderCapabilityList(root, "Calls", view.capabilities.find((item) => item.key === "Calls"), view.calls, (call) => call.Subject || "Call");
  renderCapabilityList(root, "Meetings", view.capabilities.find((item) => item.key === "Events" || item.key === "Meetings"), view.meetings, (meeting) => meeting.Event_Title || meeting.Subject || "Meeting");

  const details = el("div", { class: "block" }, [el("h3", { text: "CRM details" })]);
  details.append(el("h4", { text: "Tags" }), el("p", { text: fieldValue(view.tags) }));
  details.append(el("h4", { text: "Custom fields" }));
  if (!view.customFields.length) details.append(el("p", { class: "muted", text: "No custom field values on this record." }));
  for (const field of view.customFields) details.append(kv(field.label, fieldValue(field.value)));
  details.append(el("h4", { text: "Standard fields" }));
  for (const field of view.standardFields.slice(0, 40)) details.append(kv(field.label, fieldValue(field.value)));
  details.append(el("h4", { text: "Related records" }));
  if (!view.relatedLists?.length) {
    details.append(el("p", { class: "muted", text: "No related-list catalog was returned for this module." }));
  }
  for (const related of view.relatedLists || []) {
    details.append(kv(related.label || related.key, capabilityLine(related)));
  }
  root.append(details);

  const debug = el("div", { class: "block" }, [el("h3", { text: "View Diagnostic" })]);
  const button = el("button", { type: "button", text: "Load diagnostic JSON" });
  const download = el("button", { type: "button", text: "Download diagnostic" });
  const pre = el("pre");
  async function loadDiagnostic() {
    const diagnostic = await api(`/api/crm/diagnostic?module=${encodeURIComponent(moduleName)}&id=${encodeURIComponent(id)}`);
    const text = JSON.stringify(diagnostic, null, 2);
    pre.textContent = text;
    return text;
  }
  button.addEventListener("click", async () => {
    try {
      await loadDiagnostic();
    } catch (error) {
      pre.textContent = error.message;
    }
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
      pre.textContent = error.message;
    }
  });
  debug.append(el("p", { class: "muted", text: "Development/verification only. Secrets are redacted." }), button, download, pre);
  root.append(debug);
}

function optionList(values, selected) {
  return values.map((value) => {
    const label = value ? value.replaceAll("_", " ") : "(unknown)";
    const node = el("option", { value, text: label });
    if (value === selected) node.selected = true;
    return node;
  });
}

function organisationIdFrom(analysis, moduleName, id) {
  return analysis?.organisationGraph?.organisationId || `contact:${moduleName}:${id}`;
}

function timelineKindPill(kind, source) {
  if (kind === "operator_sales_event" || source === "OPERATOR_ENTERED_SALES_EVENT") {
    return el("span", { class: "pill operator", text: "OPERATOR EVENT" });
  }
  if (kind === "inferred_real_world") return el("span", { class: "pill inferred", text: "INFERRED" });
  if (kind === "usage") return el("span", { class: "pill usage", text: "USAGE" });
  return el("span", { class: "pill zoho", text: "ZOHO" });
}

function renderCommercialTimeline(analysis) {
  const block = el("div", { class: "intel-section" }, [el("h4", { text: "Commercial timeline" })]);
  block.append(el("p", { class: "muted", text: "Operator events are Sales Engine evidence. They are not Zoho activities." }));
  const events = [...(analysis.reconstructedTimeline || [])].sort(
    (left, right) => (right.at ? Date.parse(right.at) : 0) - (left.at ? Date.parse(left.at) : 0),
  );
  if (!events.length) {
    block.append(el("p", { class: "muted", text: "No dated commercial events yet." }));
    return block;
  }
  const list = el("ul", { class: "commercial-timeline" });
  for (const event of events.slice(0, 24)) {
    const item = el("li", { class: "timeline-item" });
    item.append(
      el("time", { text: formatDay(event.at) }),
      timelineKindPill(event.kind, event.source),
      el("strong", { text: event.title || "" }),
    );
    list.append(item);
  }
  block.append(list);
  return block;
}

function renderSalesEventPanel(root, moduleName, id, analysis, runAnalysis) {
  root.replaceChildren();
  const graph = analysis?.organisationGraph;
  const organisationId = organisationIdFrom(analysis, moduleName, id);
  const contacts = graph?.contacts || [];
  const section = el("div", { class: "intel-section event-section" }, [
    el("h4", { text: "Record sales event" }),
    el("p", { class: "muted", text: "Saved locally. Never written to Zoho. Re-analyse only when you ask." }),
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
    const wrap = el("label", { class: wide ? "wide" : "" }, [el("span", { text: label }), node]);
    return wrap;
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
          el("strong", { text: `${formatDay(event.occurred_at)} · ${(event.event_type || "").replaceAll("_", " ")}${event.outcome ? ` — ${event.outcome.replaceAll("_", " ")}` : ""}` }),
          el("div", { text: `${event.contact_name || "Organisation"} · ${(event.product_scope || "").replaceAll("_", " ")}` }),
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
      list.append(el("p", { class: "warn-text", text: error.message }));
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

  const save = el("button", { type: "button", class: "secondary", text: "Save event" });
  const saveAnalyse = el("button", { type: "button", text: "Save + re-analyse" });
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      await saveEvent();
      status.textContent = "Saved locally. Not written to Zoho. Analysis was not run.";
      fillForm(null);
      await refreshList();
    } catch (error) {
      status.textContent = error.message;
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
      status.textContent = error.message;
    } finally {
      saveAnalyse.disabled = false;
    }
  });

  section.append(form, el("div", { class: "row" }, [save, saveAnalyse]), status, list);
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
  return labels[reason] || String(reason || "").replaceAll("_", " ");
}

function associationLine(item) {
  const reasons = (item.association_reasons || item.reasons || []).map(reasonLabel).join("; ");
  return reasons || "Association reason not recorded";
}

function renderOrganisationGraph(root, graph, profile) {
  if (!graph) return;
  const panel = el("div", { class: "intel-section" }, [el("h4", { text: "Organisation" })]);
  panel.append(
    kv("Organisation", graph.organisationName || "Uncertain"),
    kv("Selected contact", graph.selectedContactName || "—"),
    kv("Domains", (graph.domains || []).join(", ") || "None (public email domains are excluded)"),
    kv("Certainty", graph.certainty === "resolved" ? "Resolved from deterministic evidence" : "Uncertain"),
    kv("Related contacts", String((graph.contacts || []).length)),
    kv("Related accounts", String((graph.accounts || []).length)),
    kv("Zoho records merged", "No — intelligence graph only"),
  );
  if (graph.fragmentation?.possible_crm_fragmentation) {
    panel.append(
      el("p", { class: "warn-text", text: graph.fragmentation.label || "POSSIBLY RELATED ACCOUNT RECORDS — REVIEW" }),
      el("p", {
        class: "muted",
        text: `${(graph.fragmentation.account_names || []).join(" · ")} (${(graph.fragmentation.confidence || "MEDIUM")} confidence). These Zoho Account records were not merged.`,
      }),
    );
  } else {
    panel.append(kv("Possible CRM fragmentation", "Not indicated"));
  }
  if (profile) {
    panel.append(
      kv("Commercial story", profile.relationship_summary || "—"),
      kv("Recommended contact", `${profile.best_contact} — ${profile.reason_for_best_contact}`),
      kv("Next action", `${(profile.recommended_action || "").replaceAll("_", " ")} · ${profile.recommended_channel || ""}`),
    );
    if (profile.best_contact && graph.selectedContactName && profile.best_contact !== graph.selectedContactName) {
      panel.append(el("p", { class: "muted", text: `Recommended contact differs from selected contact (${graph.selectedContactName}). Identities were not switched.` }));
    }
  }
  root.append(panel);

  const contacts = el("div", { class: "intel-section" }, [el("h4", { text: "Related contacts" })]);
  for (const member of graph.contacts || []) {
    const line = el("div", { class: member.certainty === "possible" ? "member possible" : "member" });
    line.append(el("strong", { text: `${member.name}${member.selected ? " · selected" : ""}` }));
    if (member.email) line.append(el("div", { class: "muted", text: member.email }));
    if (member.title) line.append(el("div", { class: "muted", text: `Job title (CRM fact): ${member.title}` }));
    if (member.accountName) line.append(el("div", { class: "muted", text: `Account: ${member.accountName}` }));
    line.append(el("div", { text: associationLine(member) }));
    if (member.commercial_role) {
      line.append(el("div", { class: "muted", text: `Commercial role (${member.commercial_role.layer}): ${String(member.commercial_role.role).replaceAll("_", " ")}` }));
    }
    contacts.append(line);
  }
  if (!(graph.contacts || []).length) contacts.append(el("p", { class: "muted", text: "No related contacts were associated." }));
  root.append(contacts);

  const accounts = el("div", { class: "intel-section" }, [el("h4", { text: "Related accounts" })]);
  for (const account of graph.accounts || []) {
    const line = el("div", { class: "member" });
    line.append(el("strong", { text: account.name }));
    line.append(el("div", { class: "muted", text: `Zoho Accounts ${account.recordId}` }));
    line.append(el("div", { text: associationLine(account) }));
    accounts.append(line);
  }
  for (const account of graph.possibleAccounts || []) {
    const line = el("div", { class: "member possible" });
    line.append(el("strong", { text: account.name }));
    line.append(el("div", { class: "muted", text: `Zoho Accounts ${account.recordId}` }));
    line.append(el("div", { text: associationLine(account) }));
    line.append(el("span", { class: "pill warn", text: "POSSIBLE MATCH — REVIEW" }));
    accounts.append(line);
  }
  if (!(graph.accounts || []).length && !(graph.possibleAccounts || []).length) {
    accounts.append(el("p", { class: "muted", text: "No related Account records were associated." }));
  }
  root.append(accounts);

  if ((graph.productOpportunities || []).length) {
    const opps = el("div", { class: "intel-section" }, [el("h4", { text: "Opportunities" })]);
    for (const item of graph.productOpportunities) {
      opps.append(
        kv(
          `${item.product.replaceAll("_", " ")} · ${item.status.replaceAll("_", " ")}`,
          `${item.deal_name || item.deal_id}${item.stage ? ` · ${item.stage}` : ""}${item.contact_name ? ` · ${item.contact_name}` : ""}${item.account_name ? ` · ${item.account_name}` : ""}`,
        ),
      );
    }
    root.append(opps);
  }

  if ((graph.dataQualitySignals || []).length || (graph.omissions || []).length) {
    const quality = el("div", { class: "intel-section" }, [el("h4", { text: "Data-quality signals" })]);
    for (const signal of graph.dataQualitySignals || []) {
      quality.append(el("p", { text: `${signal.code.replaceAll("_", " ")} — ${signal.message}` }));
    }
    for (const omission of graph.omissions || []) {
      quality.append(el("p", { class: "muted", text: `Retrieval limit: ${omission.kind} · ${omission.omitted} omitted (${omission.reason})` }));
    }
    root.append(quality);
  }
}

function renderIntelligence(root, analysis, moduleName, id) {
  root.replaceChildren();
  if (!analysis) return;
  if (!analysis.success) {
    root.append(el("p", { class: "warn-text", text: analysis.error || "Analysis failed." }));
  }
  const profile = analysis.profile;
  const org = analysis.organisation;
  const graph = analysis.organisationGraph;
  renderOrganisationGraph(root, graph, profile);
  if (profile) {
    const decision = el("div", { class: "decision" });
    decision.append(
      kv("Organisation", graph?.organisationName || org?.identity?.name || profile.best_contact || "Uncertain"),
      kv("Selected contact", graph?.selectedContactName || profile.best_contact || "—"),
      kv("Primary opportunity", `${profile.primary_opportunity.motion.replaceAll("_", " ")} — ${profile.primary_opportunity.rationale}`),
      kv("Relationship", [profile.relationship_state, ...(profile.additional_relationship_states || [])].join(" · ").replaceAll("_", " ")),
      kv("Recommended action", `${profile.recommended_action.replaceAll("_", " ")} · ${profile.recommended_channel}`),
      kv("Why", profile.recommended_action_reason),
      kv("Objective", profile.recommended_action_objective),
      kv("Message angle", profile.suggested_message_angle),
      kv("Recommended contact", `${profile.best_contact} — ${profile.reason_for_best_contact}`),
      kv("Decision", profile.decision_state.replaceAll("_", " ")),
      kv("Confidence", `${profile.confidence} — ${profile.confidence_reason}`),
      kv("Relationship depth", profile.relationship_depth || "—"),
      kv("Confirmed CRM activity", profile.confirmed_crm_activity || "—"),
      kv("Inferred real-world activity", profile.inferred_real_world_activity || "—"),
    );
    if (analysis.productRelationships?.length) {
      decision.append(
        kv(
          "Product relationships",
          analysis.productRelationships
            .map((item) => `${item.product.replaceAll("_", " ")}: ${item.relationship_state.replaceAll("_", " ")}`)
            .join(" · "),
        ),
      );
    }
    if (analysis.organisationRelationship?.characterisation) {
      decision.append(kv("Organisation relationship", analysis.organisationRelationship.characterisation));
    }
    root.append(decision);
    root.append(renderCommercialTimeline(analysis));
    root.append(listBlock("Known facts", profile.known_facts, "No verified facts were asserted."));
    root.append(listBlock("Signals", profile.important_signals));
    root.append(listBlock("Inferences", profile.inferences, "No inferences."));
    root.append(listBlock("Unknowns", profile.unknowns));
    root.append(listBlock("Contradictions", profile.contradictions, "None noted."));
    if (analysis.interactions?.length) {
      const inferred = el("div", { class: "intel-section" }, [el("h4", { text: "Inferred real-world interactions" })]);
      inferred.append(el("p", { class: "muted", text: "These are reconstructed from notes/emails. They are not Zoho Call or Meeting records unless also listed as CRM facts." }));
      for (const item of analysis.interactions) {
        inferred.append(
          kv(
            item.interaction_type.replaceAll("_", " "),
            `${item.direction} · ${item.confidence}${item.supporting_evidence_count > 1 ? ` · ${item.supporting_evidence_count} supporting evidence records` : ""} · ${item.summary}${item.follow_up_commitment ? ` · Follow-up: ${item.follow_up_commitment}` : ""} (${item.provenance})`,
          ),
        );
      }
      root.append(inferred);
    }
    const motions = el("div", { class: "intel-section" }, [el("h4", { text: "Opportunity assessments" })]);
    for (const [label, item] of [
      ["Partner", profile.partner_potential],
      ["Registration", profile.registration_potential],
      ["Activation", profile.activation_potential],
      ["Paid conversion", profile.paid_conversion_potential],
      ["Reactivation", profile.reactivation_potential],
    ]) {
      motions.append(kv(label, `${item.motion.replaceAll("_", " ")} (${item.confidence}) — ${item.rationale}`));
    }
    if (profile.secondary_opportunities?.length) {
      motions.append(listBlock(
        "Secondary opportunities",
        profile.secondary_opportunities.map((item) => `${item.motion.replaceAll("_", " ")} (${item.confidence}) — ${item.rationale}`),
      ));
    }
    root.append(motions);
  }

  const usage = org?.usage;
  const usageBlock = el("div", { class: "intel-section" }, [el("h4", { text: "Portal Genie usage" })]);
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

  const enrich = el("div", { class: "intel-section" }, [el("h4", { text: "Enrichment" })]);
  enrich.append(kv("Recommended", profile?.enrichment_recommended ? "Yes" : "No"));
  enrich.append(el("p", { class: "muted", text: "No vendor is called. These questions are for a future enrichment step." }));
  if (profile?.enrichment_questions?.length) {
    enrich.append(listBlock("Questions", profile.enrichment_questions));
  }
  root.append(enrich);

  if (!graph && org?.members?.length) {
    const members = el("div", { class: "intel-section" }, [el("h4", { text: "Organisation contacts" })]);
    if (org.identity?.certainty === "uncertain") {
      members.append(el("p", { class: "warn-text", text: "Organisation identity is uncertain. Records were not merged." }));
    }
    for (const member of org.members) {
      const line = el("div", { class: member.certainty === "possible" ? "member possible" : "member" });
      const title = [member.name, member.email, member.genericMailbox ? "generic mailbox" : "", member.selected ? "selected relationship" : ""]
        .filter(Boolean)
        .join(" · ");
      line.append(el("strong", { text: title }));
      line.append(el("div", { class: "muted", text: `${member.module} ${member.recordId}` }));
      if (member.lastActivity) line.append(el("div", { class: "muted", text: `Last interaction: ${formatWhen(member.lastActivity)}` }));
      line.append(el("div", { text: `Associated because: ${member.reasons.map(reasonLabel).join(", ") || "selected record"}` }));
      if (member.certainty === "possible") {
        line.append(el("span", { class: "pill warn", text: "POSSIBLE MATCH — REVIEW" }));
      }
      members.append(line);
    }
    root.append(members);
  }

  const evidence = el("details", { class: "intel-section" }, [el("summary", { text: "Evidence" })]);
  for (const item of analysis.evidence || []) {
    evidence.append(el("p", { text: `${item.id} · ${item.type} · ${item.claim} (${item.source}${item.recordId ? ` · ${item.recordId}` : ""})` }));
  }
  if (profile?.evidence_references?.length) {
    evidence.append(el("p", { class: "muted", text: `AI cited: ${profile.evidence_references.join(", ")}` }));
  }
  if (analysis.model) {
    evidence.append(el("p", { class: "muted", text: `Model ${analysis.model} · ${analysis.usage?.totalTokens ?? "?"} tokens · ${analysis.latencyMs ?? "?"} ms · ${analysis.requestId || "no request id"}` }));
  }
  root.append(evidence);

  const feedback = el("div", { class: "intel-section" }, [el("h4", { text: "Operator feedback" })]);
  feedback.append(el("p", { class: "muted", text: "Stored for later calibration. It does not retrain the model." }));
  const notes = el("textarea", { rows: "3", placeholder: "Optional notes" });
  const row = el("div", { class: "row" });
  for (const verdict of ["CORRECT", "PARTIALLY_CORRECT", "WRONG"]) {
    const button = el("button", { type: "button", class: "secondary", text: verdict.replaceAll("_", " ") });
    button.addEventListener("click", async () => {
      try {
        await api("/api/intelligence/feedback", {
          method: "POST",
          body: JSON.stringify({ module: moduleName, id, verdict, notes: notes.value }),
        });
        feedback.append(el("p", { text: `Saved ${verdict.replaceAll("_", " ")}.` }));
      } catch (error) {
        feedback.append(el("p", { text: error.message }));
      }
    });
    row.append(button);
  }
  feedback.append(notes, row);
  if (analysis.feedback?.length) {
    for (const item of analysis.feedback) {
      feedback.append(el("p", { class: "muted", text: `${formatWhen(item.at)} · ${item.verdict}${item.notes ? ` — ${item.notes}` : ""}` }));
    }
  }
  root.append(feedback);
}

function renderCapabilityList(root, title, cap, records, line) {
  const block = el("div", { class: "block" }, [el("h3", { text: title })]);
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
    $("connect-status").textContent = error.message;
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
    $("connect-status").textContent = error.message;
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
    $("usage-status").textContent = error.message;
  }
});

async function loadUsageStatus() {
  try {
    const status = await api("/api/usage/status");
    $("usage-status").textContent = status.imported
      ? `Last import: ${status.rowCount} row(s) from ${status.file || "usage-import.json"}`
      : "No usage file imported yet.";
  } catch (error) {
    $("usage-status").textContent = error.message;
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
