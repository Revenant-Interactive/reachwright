/* Reachwright Operator console.
 * Plain JS, no dependencies. All API data renders via textContent — provider
 * and model text can never inject HTML. The token lives in sessionStorage
 * only; nothing here contains a secret. */

(() => {
  "use strict";

  // ------------------------------------------------------------ state + api
  const state = {
    base: sessionStorage.getItem("rw.base") || "http://localhost:8788",
    token: sessionStorage.getItem("rw.token") || "",
    health: null,
  };

  async function api(method, path, body) {
    let response;
    try {
      response = await fetch(state.base + path, {
        method,
        headers: {
          authorization: `Bearer ${state.token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      return { status: 0, body: { error: "network-unavailable",
        detail: "Could not reach the operator API. The run remains persisted; check the API base and retry." } };
    }
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    return { status: response.status, body: data };
  }

  // -------------------------------------------------------------- utilities
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "class") node.className = value;
      else if (key === "dataset") Object.assign(node.dataset, value);
      else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
      else if (value !== undefined && value !== null) node.setAttribute(key, value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined) continue;
      node.append(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }
  const view = document.getElementById("view");
  const banner = document.getElementById("banner");
  const nav = document.getElementById("nav");
  const runBadge = document.getElementById("run-badge");

  function setView(...nodes) { view.replaceChildren(...nodes); }
  function pill(text, kind = "") { return el("span", { class: `pill ${kind}` }, text); }
  function scorePill(score, threshold = 70) {
    if (!score) return pill("unscored");
    const total = Number.isInteger(score.override_total) ? score.override_total : score.total;
    const kind = total >= threshold ? "good" : total >= 40 ? "warn" : "bad";
    return pill(`${total}${Number.isInteger(score.override_total) ? "*" : ""}`, kind);
  }
  function errBox(detail) {
    return el("p", { class: "err" }, typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
  }
  function download(filename, text) {
    const a = el("a", { href: URL.createObjectURL(new Blob([text], { type: "text/csv" })), download: filename });
    document.body.append(a); a.click(); a.remove();
  }
  function jsonArray(value) {
    if (Array.isArray(value)) return value;
    try { return JSON.parse(value || "[]"); } catch { return []; }
  }
  function jsonObject(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    try { const parsed = JSON.parse(value || "{}"); return parsed && typeof parsed === "object" ? parsed : {}; }
    catch { return {}; }
  }
  function percent(value) {
    return Number.isFinite(Number(value)) ? `${Math.round(Number(value) * 100)}%` : "—";
  }
  function money(cents) {
    const amount = Number(cents || 0) / 100;
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD",
      maximumFractionDigits: amount % 1 ? 2 : 0 }).format(amount);
  }
  function safeExternalLink(url, label) {
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) return el("span", { class: "mono small" }, label || url || "—");
      return el("a", { href: parsed.href, target: "_blank", rel: "noopener noreferrer", class: "source-link" }, label || parsed.hostname);
    } catch { return el("span", { class: "mono small" }, label || url || "—"); }
  }
  const generationStageLabels = {
    discovered: "Discovered", researching: "Researching", "contact-found": "Contact found",
    qualified: "Qualified", "message-ready": "Message ready", rejected: "Rejected", failed: "Retry needed",
  };
  const taskLabels = {
    reverify: "Reverify dossier", "review-evidence": "Review evidence",
    "audit-dossier": "Fact audit", "draft-outreach": "Create draft",
    "approve-draft": "Review packet", "export-approved": "Export one",
    "record-send": "Confirm send", "follow-up-due": "Follow-up due",
    "score-dossier": "Score dossier", "review-score": "Review low score",
    "record-outcome": "Record outcome",
  };
  const readinessLabels = {
    "evidence-review": "review evidence", freshness: "verify fresh evidence",
    audit: "complete fact audit", "scores-current": "recompute scores",
    threshold: "below score threshold", suppressed: "suppressed",
  };

  async function refreshBanner() {
    const health = await api("GET", "/api/health").catch(() => null);
    state.health = health?.body ?? null;
    banner.hidden = false;
    if (!health || health.status !== 200) {
      banner.className = "banner bad";
      banner.textContent = "API unreachable or token rejected — check connection settings (Lock → sign in again).";
      return;
    }
    const provider = health.body.provider;
    const generationSources = health.body.generation_sources?.providers ?? [];
    if (!provider.configured) {
      banner.className = "banner warn";
      banner.textContent = `Provider not configured — Scout search is disabled. Add the API key for ${provider.provider || "your selected provider"} to the worker secrets. Manual sourced-dossier intake remains available; nothing in this console fakes data.`;
    } else if (provider.mode === "test-fixtures-only") {
      banner.className = "banner warn";
      banner.textContent = "DEV FIXTURES MODE — records marked [FIXTURE] are fake and for testing only. Never treat them as prospects.";
    } else {
      banner.className = "banner good";
      const sourceNames = generationSources.map((item) => item.provider).join(" + ") || provider.provider;
      banner.textContent = `Generation sources: ${sourceNames} (configured, live accuracy still requires a proof run). Email exports: ${health.body.email_gate_passed ? "enabled" : "BLOCKED until the CAN-SPAM gate passes"}.`;
    }
  }

  // ------------------------------------------------------------------ login
  function loginScreen(message) {
    nav.hidden = true;
    banner.hidden = true;
    const baseInput = el("input", { type: "url", value: state.base, id: "login-base" });
    const tokenInput = el("input", { type: "password", value: "", id: "login-token", autocomplete: "off" });
    const status = el("p", { class: "muted small" }, message || "");
    setView(el("div", { class: "login-wrap card" },
      el("h1", {}, "Operator sign-in"),
      el("p", { class: "sub" }, "Point at the Reachwright API and unlock with the operator token. The token is held in this tab's session only."),
      el("label", { for: "login-base" }, "API base URL"), baseInput,
      el("label", { for: "login-token" }, "Operator token"), tokenInput,
      el("div", { class: "btn-row" },
        el("button", { class: "btn", onclick: async () => {
          state.base = baseInput.value.replace(/\/$/, "");
          state.token = tokenInput.value;
          status.textContent = "Checking…";
          const health = await api("GET", "/api/health").catch(() => null);
          if (health?.status === 200) {
            sessionStorage.setItem("rw.base", state.base);
            sessionStorage.setItem("rw.token", state.token);
            location.hash = "#/today";
            route();
          } else {
            status.textContent = health ? `Rejected (${health.status})` : "Unreachable — is the API running?";
          }
        } }, "Unlock"),
      ),
      status,
    ));
  }

  document.getElementById("lock").addEventListener("click", () => {
    sessionStorage.removeItem("rw.token");
    state.token = "";
    location.hash = "#/";
    loginScreen("Locked. Token cleared from this session.");
  });

  // ---------------------------------------------------------- generation
  async function autoAdvanceGeneration(runId, status) {
    for (let step = 0; step < 20; step += 1) {
      const next = await api("POST", `/api/generation-runs/${runId}/advance`, { batch: 3 });
      if (next.status !== 200) {
        status.replaceChildren(errBox(next.body));
        return next;
      }
      const run = next.body.run;
      const ready = run.counts?.message_ready ?? 0;
      status.replaceChildren(el("p", { class: "ok" },
        `${ready} of ${run.target_ready} review-ready · ${run.counts?.total ?? 0} candidates considered · ${run.status}`));
      if (["completed", "partial", "failed", "paused", "canceled"].includes(run.status)) return next;
    }
    status.replaceChildren(el("p", { class: "muted small" },
      "The run is safely persisted. Open it and continue the next bounded batch."));
    return null;
  }

  async function generationScreen() {
    const [clientsResult, campaignsResult, runsResult, sourcesResult] = await Promise.all([
      api("GET", "/api/clients"), api("GET", "/api/campaigns"),
      api("GET", "/api/generation-runs"), api("GET", "/api/providers"),
    ]);
    if (clientsResult.status !== 200) return setView(errBox(clientsResult.body));
    if (campaignsResult.status !== 200) return setView(errBox(campaignsResult.body));
    if (runsResult.status !== 200) return setView(errBox(runsResult.body));
    if (sourcesResult.status !== 200) return setView(errBox(sourcesResult.body));
    const clients = clientsResult.body.clients;
    const campaigns = campaignsResult.body.campaigns;
    const runs = runsResult.body?.runs ?? [];
    const sourceNames = (sourcesResult.body?.providers ?? []).map((item) => item.provider);
    const clientSelect = el("select", {}, clients.map((client) => el("option", { value: client.id }, client.name)));
    const campaignSelect = el("select");
    const targetInput = el("input", { type: "number", min: "1", max: "10", value: "5" });
    const capInput = el("input", { type: "number", min: "5", max: "50", value: "40" });
    const budgetInput = el("input", { type: "number", min: "0", max: "100", step: "1", value: "10" });
    const keywordsInput = el("input", { type: "text", placeholder: "marketing agency, SaaS, consulting firm, law firm" });
    const locationInput = el("input", { type: "text", value: "United States" });
    const status = el("div");

    function fillCampaigns() {
      const matches = campaigns.filter((campaign) => campaign.client_id === clientSelect.value
        && campaign.status !== "closed" && !/^DEV SEED/i.test(campaign.name)
        && !/browser test/i.test(campaign.name));
      campaignSelect.replaceChildren(
        el("option", { value: "" }, matches.length ? "— choose a campaign —" : "No campaign for this client"),
        ...matches.map((campaign) => el("option", { value: campaign.id }, campaign.name)),
      );
      const preferred = matches.find((campaign) => campaign.id === "rw-c-copywriting-feed") || matches[0];
      if (preferred) {
        campaignSelect.value = preferred.id;
        locationInput.value = preferred.geography || "United States";
        keywordsInput.value = jsonArray(preferred.positive_signals).join(", ");
      }
    }
    fillCampaigns();
    clientSelect.addEventListener("change", fillCampaigns);
    campaignSelect.addEventListener("change", () => {
      const selected = campaigns.find((campaign) => campaign.id === campaignSelect.value);
      if (selected?.geography) locationInput.value = selected.geography;
      const campaignSignals = jsonArray(selected?.positive_signals);
      if (campaignSignals.length) keywordsInput.value = campaignSignals.join(", ");
    });

    const runRows = runs.map((entry) => {
      const counts = jsonObject(entry.counts);
      return el("tr", { class: "clickable", onclick: () => { location.hash = `#/generate/${entry.id}`; } },
        el("td", {}, new Date(entry.started_at).toLocaleString()),
        el("td", {}, el("strong", {}, entry.client_name || entry.client_id),
          el("div", { class: "small muted" }, entry.campaign_name || entry.campaign_id)),
        el("td", {}, pill(entry.status, entry.status === "completed" ? "good" : entry.status === "partial" ? "warn" : "")),
        el("td", {}, `${counts.message_ready ?? 0} / ${entry.target_ready}`),
        el("td", {}, String(counts.total ?? 0)),
        el("td", {}, String(counts.provider_credits_estimated ?? 0)));
    });

    let generateButton;
    setView(
      el("div", { class: "generation-hero" },
        el("div", {}, el("p", { class: "eyebrow" }, "Scout · evidence-led generation"),
          el("h1", {}, "Generate qualified prospects"),
          el("p", { class: "sub" }, "One command overfetches, researches official sites, resolves decision-makers, detects one focused opportunity, matches a Reemergence service, and prepares review packets. Nothing is sent automatically.")),
        el("div", { class: "hero-target" }, el("strong", {}, "5"), el("span", {}, "review-ready packets"))),
      status,
      el("div", { class: "card generation-command" },
        el("div", { class: "command-grid" },
          el("div", {}, el("label", {}, "Client"), clientSelect),
          el("div", { class: "command-campaign" }, el("label", {}, "Campaign brief"), campaignSelect),
          el("div", {}, el("label", {}, "Ready target"), targetInput),
          el("div", {}, el("label", {}, "Candidate ceiling"), capInput)),
        el("div", { class: "grid cols-2" },
          el("div", {}, el("label", {}, "Industry / search terms"), keywordsInput),
          el("div", {}, el("label", {}, "Geography"), locationInput)),
        el("details", { class: "advanced" },
          el("summary", {}, "Source and budget controls"),
          el("div", { class: "grid cols-2" },
            el("div", {}, el("label", {}, "Maximum provider credits for this run"), budgetInput),
            el("div", {}, el("label", {}, "Configured cooperative sources"),
              el("p", { class: "small muted source-plan" }, sourceNames.length ? sourceNames.join(" + ") : "No provider configured")))),
        el("div", { class: "command-action" },
          (generateButton = el("button", { class: "btn generate-btn", disabled: campaigns.length && sourceNames.length ? undefined : "disabled", onclick: async () => {
            if (!campaignSelect.value) return status.replaceChildren(errBox("Choose a complete campaign brief first."));
            const payload = {
              campaign_id: campaignSelect.value,
              target_ready: Number(targetInput.value), candidate_cap: Number(capInput.value),
              credit_budget: Number(budgetInput.value),
              keywords: keywordsInput.value.split(",").map((value) => value.trim()).filter(Boolean),
              locations: locationInput.value ? [locationInput.value.trim()] : [],
              start_immediately: true, initial_batch: 2,
            };
            status.replaceChildren(el("p", { class: "muted" }, "Starting discovery and the first bounded research batch…"));
            const created = await api("POST", "/api/generation-runs", payload);
            if (created.status !== 201) return status.replaceChildren(errBox(created.body));
            const run = created.body.run;
            runBadge.textContent = `${run.counts?.message_ready ?? 0} / ${run.target_ready} ready`;
            if (!["completed", "partial", "failed"].includes(run.status)) {
              await autoAdvanceGeneration(run.id, status);
            }
            location.hash = `#/generate/${run.id}`;
          } }, `Generate ${targetInput.value} qualified prospects`)),
          el("p", { class: "small muted" }, "Creates review packets only. Evidence, scores, audit, message choice, approval, and every manual send remain yours."))),
      el("h2", {}, "Recent generation runs"),
      el("div", { class: "card table-wrap" }, el("table", {},
        el("thead", {}, el("tr", {}, ["Started", "Client / campaign", "Status", "Ready", "Candidates", "Est. credits"].map((head) => el("th", {}, head)))),
        el("tbody", {}, runRows.length ? runRows
          : el("tr", {}, el("td", { colspan: "6", class: "muted" }, "No runs yet. Your first Generate command will appear here."))))),
    );
    targetInput.addEventListener("input", () => {
      generateButton.textContent = `Generate ${targetInput.value || 5} qualified prospects`;
    });
  }

  async function generationRunScreen(runId) {
    const result = await api("GET", `/api/generation-runs/${runId}`);
    if (result.status !== 200) return setView(errBox(result.body));
    const { run, candidates, events } = result.body;
    const counts = jsonObject(run.counts);
    runBadge.textContent = `${counts.message_ready ?? 0} / ${run.target_ready} ready`;
    const status = el("div");
    const stageNames = ["discovered", "researching", "contact-found", "qualified", "message-ready"];
    const terminal = ["completed", "partial", "failed", "canceled"].includes(run.status);
    const controls = [];
    if (!terminal && run.status !== "paused") controls.push(el("button", { class: "btn", onclick: async () => {
      status.replaceChildren(el("p", { class: "muted" }, "Advancing the next safe batch…"));
      await autoAdvanceGeneration(run.id, status); generationRunScreen(run.id);
    } }, "Continue generation"));
    if (run.status === "paused") controls.push(el("button", { class: "btn", onclick: async () => {
      await api("PATCH", `/api/generation-runs/${run.id}`, { action: "resume" }); generationRunScreen(run.id);
    } }, "Resume"));
    else if (!terminal) controls.push(el("button", { class: "btn ghost", onclick: async () => {
      await api("PATCH", `/api/generation-runs/${run.id}`, { action: "pause" }); generationRunScreen(run.id);
    } }, "Pause"));
    if ((counts.failed ?? 0) > 0 || run.status === "partial") controls.push(el("button", { class: "btn ghost", onclick: async () => {
      const retried = await api("POST", `/api/generation-runs/${run.id}/retry`, { batch: 3 });
      status.replaceChildren(retried.status === 200 ? el("p", { class: "ok" }, "Retry completed.") : errBox(retried.body));
      generationRunScreen(run.id);
    } }, "Retry recoverable failures"));

    setView(
      el("div", { class: "detail-head" }, el("div", {}, el("p", { class: "eyebrow" }, `Run ${run.id.slice(-8)}`),
        el("h1", {}, `${counts.message_ready ?? 0} of ${run.target_ready} message-ready`),
        el("p", { class: "small muted" }, `${run.client_name || run.client_id} · ${run.campaign_name || run.campaign_id}`),
        el("p", { class: "sub" }, run.status === "partial" ? run.last_error
          : "Each ready candidate has an official-site research packet and still needs your confirmation.")),
      pill(run.status, run.status === "completed" ? "good" : run.status === "partial" ? "warn" : "copper")),
      status,
      el("div", { class: "run-stage-rail" }, stageNames.map((stage) => el("div", { class: `run-stage ${stage === "message-ready" ? "finish" : ""}` },
        el("strong", {}, String(counts[stage] ?? 0)), el("span", {}, generationStageLabels[stage]))),
      el("div", { class: "run-stage reject-lane" }, el("strong", {}, String((counts.rejected ?? 0) + (counts.failed ?? 0))), el("span", {}, "Rejected / retry"))),
      el("div", { class: "grid cols-5 run-metrics" },
        [["Candidates", counts.total ?? 0], ["Researched", counts.researched ?? 0],
          ["Contactable", counts.contactable ?? 0], ["Ready yield", percent(counts.candidate_to_ready_yield)],
          ["Est. credits", counts.provider_credits_estimated ?? 0]].map(([label, value]) =>
          el("div", { class: "stat" }, el("div", { class: "n" }, String(value)), el("div", { class: "l" }, label)))),
      el("div", { class: "btn-row" }, controls,
        el("button", { class: "btn ghost", onclick: () => { location.hash = `#/review/${run.id}`; } }, "Review ready packets")),
      el("h2", {}, "Candidate pipeline"),
      el("div", { class: "card table-wrap" }, el("table", {},
        el("thead", {}, el("tr", {}, ["Company", "Stage", "Opportunity", "Decision-maker", "Contact", "Service", "Confidence"].map((head) => el("th", {}, head)))),
        el("tbody", {}, candidates.length ? candidates.map((candidate) => el("tr", {
          class: candidate.stage === "message-ready" ? "clickable" : "",
          onclick: candidate.stage === "message-ready" ? () => { location.hash = `#/review/${run.id}/${candidate.id}`; } : undefined,
        },
        el("td", {}, el("strong", {}, candidate.organization_name), el("div", { class: "small muted mono" }, candidate.normalized_domain || "no site")),
        el("td", {}, pill(generationStageLabels[candidate.stage] || candidate.stage,
          candidate.stage === "message-ready" ? "good" : candidate.stage === "rejected" ? "bad" : candidate.stage === "failed" ? "warn" : "")),
        el("td", { class: "small" }, candidate.opportunity_claim || candidate.rejection_reason || candidate.last_error || "—"),
        el("td", { class: "small" }, candidate.person_name ? `${candidate.person_name} · ${candidate.person_title}` : "—"),
        el("td", { class: "small" }, candidate.route_type
          ? `${candidate.route_type} · ${candidate.contact_verification_state} (${candidate.contact_confidence}%)` : "—"),
        el("td", { class: "small" }, candidate.service_name || "—"),
        el("td", {}, candidate.confidence ? `${candidate.confidence}%` : "—")))
          : el("tr", {}, el("td", { colspan: "7", class: "muted" }, "No candidates were stored."))))),
      el("details", { class: "advanced" }, el("summary", {}, `Run events (${events.length})`),
        el("div", { class: "card table-wrap event-table" }, el("table", {},
          el("thead", {}, el("tr", {}, ["When", "Stage", "Source", "Result", "Error"].map((head) => el("th", {}, head)))),
          el("tbody", {}, events.map((event) => el("tr", {},
            el("td", { class: "mono small" }, event.occurred_at.slice(0, 19)), el("td", {}, event.stage),
            el("td", {}, event.provider || "system"), el("td", {}, event.status), el("td", { class: "small" }, event.error_code || "—"))))))),
    );
  }

  async function reviewScreen(runId) {
    if (!runId) {
      const runsResult = await api("GET", "/api/generation-runs");
      if (runsResult.status !== 200) return setView(errBox(runsResult.body));
      const runs = runsResult.body.runs.filter((run) => (jsonObject(run.counts).message_ready ?? 0) > 0);
      return setView(el("h1", {}, "Review prospect packets"),
        el("p", { class: "sub" }, "System recommendations become usable only after you open the sources, confirm every fact, correct the scores, and choose one message."),
        el("div", { class: "review-run-grid" }, runs.length ? runs.map((run) => {
          const counts = jsonObject(run.counts);
          return el("button", { class: "card review-run-card", onclick: () => { location.hash = `#/review/${run.id}`; } },
            el("strong", {}, `${counts.message_ready} ready`), el("span", {}, new Date(run.started_at).toLocaleString()),
            el("small", {}, `${run.client_name || run.client_id} · ${run.campaign_name || run.campaign_id}`),
            el("small", {}, `${counts.total ?? 0} candidates · ${run.status}`));
        }) : el("div", { class: "card" }, el("p", { class: "muted" }, "No review-ready packets yet."),
          el("button", { class: "btn", onclick: () => { location.hash = "#/generate"; } }, "Start a Generate 5 run"))));
    }
    const result = await api("GET", `/api/generation-runs/${runId}`);
    if (result.status !== 200) return setView(errBox(result.body));
    const ready = result.body.candidates.filter((candidate) => candidate.stage === "message-ready");
    setView(el("div", { class: "detail-head" }, el("div", {}, el("h1", {}, "Review queue"),
      el("p", { class: "sub" }, `${ready.length} packet${ready.length === 1 ? "" : "s"} ready for human confirmation.`)),
    el("button", { class: "btn ghost", onclick: () => { location.hash = `#/generate/${runId}`; } }, "Back to run")),
    el("div", { class: "prospect-card-grid" }, ready.length ? ready.map((candidate) => el("article", { class: "card prospect-card" },
      el("div", { class: "prospect-card-head" }, el("div", {}, el("p", { class: "eyebrow" }, candidate.signal_type || "opportunity"),
        el("h2", {}, candidate.organization_name)), pill(candidate.packet_status || "operator-review", candidate.packet_status === "approved" ? "good" : "copper")),
      el("p", {}, candidate.opportunity_claim || "Open the packet for the cited opportunity."),
      el("dl", { class: "packet-glance" },
        el("dt", {}, "Decision-maker"), el("dd", {}, candidate.person_name ? `${candidate.person_name} · ${candidate.person_title}` : "—"),
        el("dt", {}, "Contact"), el("dd", {}, candidate.route_type ? `${candidate.route_type} · ${candidate.contact_verification_state}` : "—"),
        el("dt", {}, "Focused service"), el("dd", {}, candidate.service_name || "—"),
        el("dt", {}, "Confidence"), el("dd", {}, `${candidate.confidence}%`)),
      el("button", { class: "btn", onclick: () => { location.hash = `#/review/${runId}/${candidate.id}`; } },
        candidate.packet_status === "approved" ? "View confirmed packet" : "Review evidence and messages")))
      : el("div", { class: "card" }, el("p", { class: "muted" }, "No message-ready candidates in this run."))));
  }

  async function prospectReviewScreen(runId, candidateId) {
    const result = await api("GET", `/api/generation-runs/${runId}/candidates/${candidateId}/packet`);
    if (result.status !== 200) return setView(errBox(result.body));
    const packet = result.body.packet;
    const status = el("div");
    const finalStatus = el("div", { role: "status" });
    if (result.body.stale) {
      return setView(el("h1", {}, `${packet.company?.name || "Prospect"} packet is stale`),
        errBox("Evidence or contact data changed after generation. Refresh this candidate before making a decision."),
        el("button", { class: "btn", onclick: async () => {
          await api("POST", `/api/generation-runs/${runId}/candidates/${candidateId}/decision`, {
            action: "refresh", packet_hash: result.body.packet_hash,
          }); location.hash = `#/generate/${runId}`;
        } }, "Queue fresh research"));
    }
    const evidenceControls = (packet.review_items || packet.cited_facts || []).map((item) => {
      const select = el("select", {},
        el("option", { value: "" }, "— review required —"),
        el("option", { value: "accepted", selected: item.reviewer_state === "accepted" ? "" : undefined }, "Accept as accurate"),
        el("option", { value: "rejected", selected: item.reviewer_state === "rejected" ? "" : undefined }, "Reject / do not use"));
      return { item, select };
    });
    const auditChecks = packet.qualification.audit_recommendation.checks;
    const checkControls = Object.entries(auditChecks).map(([name, recommendation]) => ({
      name, recommendation,
      input: el("input", { type: "checkbox", checked: recommendation.status === "supported" ? "" : undefined }),
    }));
    const proposedInputs = packet.qualification.proposed_scores.fit.proposed_inputs;
    const scoreControls = Object.entries(proposedInputs).map(([name, value]) => {
      const select = el("select", {}, [0, 0.25, 0.5, 0.75, 1].map((choice) =>
        el("option", { value: String(choice), selected: Number(value) === choice ? "" : undefined },
          choice === 1 ? "Confirmed" : choice === 0 ? "No support" : `${Math.round(choice * 100)}% support`)));
      return { name, select };
    });
    const optionControls = packet.message_options.map((option) => ({ option,
      input: el("input", { type: "radio", name: "message-option", value: option.id }) }));
    const reason = el("textarea", { placeholder: "What you verified, corrected, or rejected. Keep this concise but specific." });
    const rejectReason = el("input", { type: "text", placeholder: "Reason to reject this prospect" });

    setView(
      el("div", { class: "detail-head" }, el("div", {}, el("p", { class: "eyebrow" }, "Human confirmation workspace"),
        el("h1", {}, packet.company.name), el("p", { class: "sub" }, packet.company.location || packet.company.domain)),
      el("button", { class: "btn ghost", onclick: () => { location.hash = `#/review/${runId}`; } }, "Back to queue")),
      status,
      el("section", { class: "packet-summary-grid" },
        el("article", { class: "card" }, el("p", { class: "eyebrow" }, "Company + opportunity"),
          el("h2", {}, packet.opportunity.type.replaceAll("-", " ")),
          el("p", {}, packet.opportunity.claim),
          el("p", { class: "small" }, safeExternalLink(packet.opportunity.source_url, "Open official source")),
          el("p", { class: "confidence-line" }, `Detector confidence ${packet.opportunity.confidence}% · proposal only`)),
        el("article", { class: "card" }, el("p", { class: "eyebrow" }, "Decision-maker + route"),
          el("h2", {}, packet.decision_maker.name), el("p", {}, packet.decision_maker.title),
          el("p", { class: "mono" }, packet.contact_route.value),
          el("p", { class: "small" }, `${packet.contact_route.type} · ${packet.contact_route.verification_state} · ${packet.contact_route.confidence}%`),
          packet.contact_route.source_url.startsWith("http") ? safeExternalLink(packet.contact_route.source_url, "Open contact source") : null),
        el("article", { class: "card service-focus" }, el("p", { class: "eyebrow" }, "One focused service"),
          el("h2", {}, packet.recommended_service.name), el("p", {}, packet.recommended_service.description),
          el("p", { class: "small muted" }, packet.recommended_service.rationale))),
      el("h2", {}, "1 · Verify every evidence item"),
      el("p", { class: "sub" }, "Open each official citation. Provider discovery rows are provenance, not facts; reject them unless independently confirmed."),
      el("div", { class: "evidence-review-list" }, evidenceControls.map(({ item, select }) => el("article", { class: "card evidence-review" },
        el("p", {}, item.claim), el("div", { class: "evidence-meta" }, pill(item.strength),
          item.source_url.startsWith("http") ? safeExternalLink(item.source_url, "Open source ↗") : el("span", { class: "mono small muted" }, item.source_url)),
        select))),
      el("h2", {}, "2 · Confirm or correct the proposed scores"),
      el("p", { class: "sub" }, `Proposed fit ${packet.qualification.proposed_scores.fit.total} · evidence ${packet.qualification.proposed_scores.evidence.total}. Unknown economics and capacity stay at zero until you find support.`),
      el("div", { class: "card score-review-grid" }, scoreControls.map(({ name, select }) =>
        el("div", {}, el("label", {}, name.replaceAll("_", " ")), select)),
      el("div", { class: "score-assumptions" }, packet.exceptions.map((note) => el("p", { class: "small muted" }, `• ${note}`)))),
      el("h2", {}, "3 · Complete the six-check dossier audit"),
      el("div", { class: "card audit-recommendations" }, checkControls.map(({ name, recommendation, input }) => el("label", { class: `audit-recommendation ${recommendation.status}` },
        input, el("span", {}, el("strong", {}, name.replaceAll("_", " ")), pill(recommendation.status,
          recommendation.status === "supported" ? "good" : recommendation.status === "exception" ? "bad" : "warn"),
        el("small", {}, recommendation.note))))),
      el("h2", {}, "4 · Choose one message angle"),
      el("p", { class: "sub" }, "These are alternatives, not multiple sends. Selecting one creates a draft; the existing packet-hash approval gate still comes next."),
      el("div", { class: "message-option-grid" }, optionControls.map(({ option, input }) => el("label", { class: "card message-option" },
        el("div", { class: "message-option-head" }, input, el("strong", {}, option.strategy.replaceAll("-", " ")), pill(option.channel)),
        el("pre", { class: "msg-box" }, option.body)))),
      el("div", { class: "card final-review" }, el("label", {}, "Review note"), reason,
        el("div", { class: "btn-row" }, el("button", { class: "btn", disabled: result.body.status === "approved" ? "disabled" : undefined, onclick: async () => {
          const decisions = Object.fromEntries(evidenceControls.map(({ item, select }) => [item.id, select.value]));
          if (Object.values(decisions).some((value) => !value)) return finalStatus.replaceChildren(errBox("Review every evidence item before approving."));
          if (checkControls.some(({ input }) => !input.checked)) return finalStatus.replaceChildren(errBox("Complete all six audit checks. Open and verify the exceptions first."));
          const selected = optionControls.find(({ input }) => input.checked);
          if (!selected) return finalStatus.replaceChildren(errBox("Choose exactly one message option."));
          const approved = await api("POST", `/api/generation-runs/${runId}/candidates/${candidateId}/decision`, {
            action: "approve", packet_hash: result.body.packet_hash, evidence_decisions: decisions,
            checklist: Object.fromEntries(checkControls.map(({ name, input }) => [name, input.checked])),
            use_recommended_scores: false,
            fit_inputs: Object.fromEntries(scoreControls.map(({ name, select }) => [name, Number(select.value)])),
            selected_message_option_id: selected.option.id, reason: reason.value,
          });
          finalStatus.replaceChildren(approved.status === 201
            ? el("div", { class: "success-panel" }, el("strong", {}, "Packet confirmed; one draft created."),
              el("p", {}, "The message is still unsent and still requires exact packet approval."),
              el("button", { class: "btn", onclick: () => { location.hash = "#/approvals"; } }, "Open outreach approval"))
            : errBox(approved.body));
        } }, result.body.status === "approved" ? "Already confirmed" : "Confirm packet and create one draft"),
        el("div", { class: "reject-inline" }, rejectReason,
          el("button", { class: "btn danger", onclick: async () => {
            if (!rejectReason.value.trim()) return finalStatus.replaceChildren(errBox("Give a rejection reason first."));
            const rejected = await api("POST", `/api/generation-runs/${runId}/candidates/${candidateId}/decision`, {
              action: "reject", packet_hash: result.body.packet_hash, reason: rejectReason.value,
            });
            if (rejected.status === 200) location.hash = `#/review/${runId}`;
            else finalStatus.replaceChildren(errBox(rejected.body));
          } }, "Reject prospect"))), finalStatus),
    );
  }

  // ------------------------------------------------------------------ today
  async function todayScreen({ skipAuto = false } = {}) {
    const [feedResult, today, dashboard, revenueResult] = await Promise.all([
      api("GET", "/api/prospect-feed"), api("GET", "/api/today"), api("GET", "/api/dashboard"),
      api("GET", "/api/revenue-plan")]);
    if (feedResult.status !== 200) return setView(errBox(feedResult.body));
    if (today.status !== 200) return setView(errBox(today.body));
    const feed = feedResult.body;
    const tasks = today.body?.tasks ?? [];
    const prospects = feed.prospects ?? [];
    const d = dashboard.body ?? {};
    const revenue = revenueResult.status === 200 ? revenueResult.body : null;
    const autoKey = `rw.feed.worked.${feed.campaign.id}.${new Date().toISOString().slice(0, 10)}`;

    async function replenish({ automatic = false } = {}) {
      const status = el("div", { class: "card feed-loading" },
        el("p", { class: "eyebrow" }, automatic ? "Automatic prospect replenishment" : "Fresh prospect search"),
        el("h2", {}, "Finding evidence-backed copywriting opportunities…"),
        el("p", { class: "small muted" }, "Searching multiple market lanes, reviewing official sites, resolving decision-makers, and preparing cited packets. No outreach is sent."));
      setView(status);
      let runId = feed.active_run?.id;
      if (!runId) {
        const created = await api("POST", "/api/generation-runs", feed.refill);
        if (created.status !== 201) return setView(errBox(created.body),
          el("button", { class: "btn", onclick: () => todayScreen({ skipAuto: true }) }, "Back to Today"));
        runId = created.body.run.id;
        if (["completed", "partial", "failed"].includes(created.body.run.status)) {
          sessionStorage.setItem(autoKey, "1");
          return todayScreen({ skipAuto: true });
        }
      }
      await autoAdvanceGeneration(runId, status);
      sessionStorage.setItem(autoKey, "1");
      return todayScreen({ skipAuto: true });
    }

    if (!skipAuto && feed.auto_enabled && !sessionStorage.getItem(autoKey)
      && (feed.needs_refill || feed.active_run)) return replenish({ automatic: true });

    function contactNode(prospect) {
      if (!prospect.route_value) return el("span", { class: "muted" }, "No usable route");
      const href = prospect.route_type === "email" ? `mailto:${prospect.route_value}`
        : /^https?:\/\//i.test(prospect.route_value) ? prospect.route_value : "";
      return href ? el("a", { href, class: "source-link", target: "_blank", rel: "noreferrer" }, prospect.route_value)
        : el("span", { class: "mono" }, prospect.route_value);
    }

    function prospectCard(prospect) {
      const market = jsonObject(prospect.market_evaluation);
      const dimensions = jsonObject(market.dimensions);
      return el("article", { class: "card feed-prospect-card" },
        el("div", { class: "prospect-card-head" },
          el("div", {}, el("p", { class: "eyebrow" }, prospect.signal_type || "copy opportunity"),
            el("h2", {}, prospect.organization_name)),
          pill(`${market.overall_priority ?? prospect.confidence}% priority`, market.qualified ? "good" : "warn")),
        el("p", { class: "opportunity-copy" }, prospect.opportunity_claim || "Open the packet for the cited observation."),
        prospect.opportunity_source_url ? el("a", { href: prospect.opportunity_source_url, class: "source-link small",
          target: "_blank", rel: "noreferrer" }, "Open cited public source ↗") : null,
        el("dl", { class: "packet-glance" },
          el("dt", {}, "Business"), el("dd", {}, prospect.normalized_domain
            ? el("a", { href: `https://${prospect.normalized_domain}`, target: "_blank", rel: "noreferrer" }, prospect.normalized_domain)
            : "Website unavailable"),
          el("dt", {}, "Right person"), el("dd", {}, prospect.person_name
            ? `${prospect.person_name} · ${prospect.person_title || "decision-maker"}` : "Not resolved"),
          el("dt", {}, "Contact"), el("dd", {}, contactNode(prospect),
            el("span", { class: "small muted" }, ` · ${prospect.contact_verification_state || "unverified"}`)),
          el("dt", {}, "Best-fit service"), el("dd", {}, prospect.service_name || "Focused copywriting review"),
          el("dt", {}, "Next move"), el("dd", {}, prospect.next_action)),
        el("div", { class: "dimension-strip" }, Object.entries(dimensions).map(([key, value]) =>
          el("span", { class: Number(value.total) >= Number(value.threshold) ? "good" : "warn" },
            `${key.replaceAll("_", " ")} ${value.total ?? 0}`))),
        el("button", { class: "btn", onclick: () => {
          location.hash = `#/review/${prospect.run_id}/${prospect.id}`;
        } }, prospect.packet_status === "approved" ? "Open approved prospect" : "Review evidence and message"));
    }

    setView(
      el("div", { class: "feed-hero" }, el("div", {}, el("p", { class: "eyebrow" }, "Copywriting opportunity feed"),
        el("h1", {}, "Prospects ready for your judgment"),
        el("p", { class: "sub" }, "Reachwright searches twelve market lanes, verifies public evidence, and puts the strongest contactable opportunities first. You review; nothing sends automatically."))),
      revenue ? el("section", { class: "card revenue-strip" },
        el("div", {}, el("p", { class: "eyebrow" }, "$10k recurring-revenue path"),
          el("strong", { class: "revenue-strip-number" }, `${money(revenue.actual.recorded_mrr_cents)} / ${money(revenue.plan.target_mrr_cents)}`),
          el("p", { class: "small muted" }, `${revenue.required.additional_recurring_clients} additional ${money(revenue.plan.average_client_mrr_cents)}/month client${revenue.required.additional_recurring_clients === 1 ? "" : "s"} required at the current plan.`)),
        el("div", { class: "revenue-next" }, pill(revenue.bottleneck.stage.replaceAll("-", " "), "copper"),
          el("p", { class: "small" }, revenue.bottleneck.action),
          el("a", { class: "btn ghost small", href: "#/revenue" }, "Open revenue plan"))) : null,
      el("div", { class: "grid cols-4" }, [
        ["Ready prospects", prospects.length], ["Active real campaigns", d.campaigns_active],
        ["Approvals waiting", d.approvals_waiting], ["Outreach prepared", d.outreach_prepared],
      ].map(([label, n]) => el("div", { class: "stat" }, el("div", { class: "n" }, String(n ?? 0)), el("div", { class: "l" }, label)))),
      el("div", { class: "feed-command card" },
        el("div", {}, el("strong", {}, feed.campaign.name),
          el("p", { class: "small muted" }, `${feed.campaign.positive_signals.length} market lanes · ${feed.campaign.geography} · ${feed.refill.candidate_cap}-candidate ceiling`)),
        el("button", { class: "btn", disabled: feed.active_run ? "disabled" : undefined,
          onclick: () => replenish({ automatic: false }) }, feed.active_run ? "Search in progress" : "Find fresh prospects")),
      el("h2", {}, "Best opportunities now"),
      el("div", { class: "prospect-feed-grid" }, prospects.length ? prospects.map(prospectCard)
        : el("div", { class: "card feed-empty" }, el("h2", {}, "No prospect has cleared every gate yet."),
          el("p", { class: "muted" }, feed.source_status.configured
            ? "Run a fresh search. Reachwright will reject companies without a cited copy opportunity, visible buying capacity, and a verified permitted route."
            : "Configure a live discovery source before searching; fixture companies are intentionally hidden."),
          el("button", { class: "btn", disabled: feed.source_status.configured ? undefined : "disabled",
            onclick: () => replenish({ automatic: false }) }, "Search now"))),
      tasks.length ? el("details", { class: "card advanced follow-through" },
        el("summary", {}, `Follow-through and recordkeeping (${tasks.length})`),
        el("div", { class: "table-wrap" }, el("table", {},
          el("thead", {}, el("tr", {}, ["Priority", "Organization", "Campaign", "Detail"].map((h) => el("th", {}, h)))),
          el("tbody", {}, tasks.map((task) => el("tr", { class: "clickable", onclick: () => {
            location.hash = ["approve-draft", "export-approved"].includes(task.kind)
              ? "#/approvals" : `#/dossier/${task.organization_id}`;
          } }, el("td", {}, pill(taskLabels[task.kind] || task.kind)), el("td", {}, task.organization_name),
          el("td", {}, task.campaign_name), el("td", { class: "small muted" }, task.detail))))))) : null,
    );
  }

  async function legacyTodayScreen() {
    const [today, campaigns, dashboard] = await Promise.all([
      api("GET", "/api/today"), api("GET", "/api/campaigns"), api("GET", "/api/dashboard")]);
    if (today.status !== 200) return setView(errBox(today.body));
    const tasks = today.body?.tasks ?? [];
    const campaignRows = campaigns.body?.campaigns ?? [];
    const d = dashboard.body ?? {};

    const firstRun = !campaignRows.length;
    const guide = el("section", { class: "card" },
      el("h2", {}, firstRun ? "Start here" : "Working loop"),
      firstRun
        ? el("ol", { class: "first-run-steps" },
          el("li", {}, el("strong", {}, "Review your market model. "),
            "The ", el("a", { href: "#/market" }, "Market screen"), " holds your copywriting services, the signal library, and the scoring rules. Everything is editable; disable what you don't sell."),
          el("li", {}, el("strong", {}, "Create your first copywriting campaign. "),
            "A campaign is the approved brief — ICP, geography, signals, triggers, disqualifiers, channels. Open ",
            el("a", { href: "#/campaigns" }, "Campaigns"), " and complete every brief field so it leaves blocked-brief."),
          el("li", {}, el("strong", {}, "Generate. "),
            "From an approved campaign, ", el("a", { href: "#/generate" }, "Generate"),
            " overfetches candidates, researches official sites, and prepares review-ready packets. Nothing sends — every outreach is your manual decision."))
        : el("p", { class: "small muted" },
          "Review evidence → audit → approve → send manually → record the outcome. Candidates are not leads; booked is not held."));

    setView(
      el("h1", {}, "Today"),
      el("p", { class: "sub" }, "What deserves your attention next. Evidence in, decisions out — nothing here sends anything."),
      el("div", { class: "grid cols-4" }, [
        ["Active campaigns", d.campaigns_active], ["Candidates found", d.candidates_found],
        ["Approvals waiting", d.approvals_waiting], ["Outreach prepared", d.outreach_prepared],
      ].map(([label, n]) => el("div", { class: "stat" }, el("div", { class: "n" }, String(n ?? 0)), el("div", { class: "l" }, label)))),
      guide,
      el("h2", {}, "Today's work"),
      el("div", { class: "card table-wrap" }, el("table", {},
        el("thead", {}, el("tr", {}, ["Priority", "Organization", "Campaign", "Detail"].map((h) => el("th", {}, h)))),
        el("tbody", {}, tasks.length ? tasks.map((task) => el("tr", {
          class: "clickable", onclick: () => {
            location.hash = ["approve-draft", "export-approved"].includes(task.kind)
              ? "#/approvals" : `#/dossier/${task.organization_id}`;
          },
        }, el("td", {}, pill(taskLabels[task.kind] || task.kind, task.kind === "follow-up-due" ? "warn" : "")),
        el("td", {}, task.organization_name), el("td", {}, task.campaign_name), el("td", { class: "small muted" }, task.detail)))
          : el("tr", {}, el("td", { colspan: "4", class: "muted" },
            firstRun ? "Nothing yet — follow the three steps above to create your first campaign."
              : "Nothing due. Start a Generate run or review campaigns."))))),
      el("div", { class: "btn-row" },
        el("button", { class: "btn", onclick: () => { location.hash = "#/generate"; } }, "Open Generate"),
        el("button", { class: "btn ghost", onclick: () => { location.hash = "#/market"; } }, "Review market model")),
    );
  }

  // ----------------------------------------------------------------- market
  const dimensionLabels = {
    "icp-fit": "ICP fit", "copy-opportunity": "Copy opportunity",
    "buying-trigger": "Buying trigger / capacity", "evidence-quality": "Evidence quality",
    reachability: "Reachability",
  };

  async function marketScreen() {
    const [signalsResult, modelResult] = await Promise.all([
      api("GET", "/api/signals"), api("GET", "/api/scoring-model")]);
    if (signalsResult.status !== 200) return setView(errBox(signalsResult.body));
    if (modelResult.status !== 200) return setView(errBox(modelResult.body));
    const signals = signalsResult.body.signals;
    const model = modelResult.body.model;

    function signalEditor(signal) {
      const label = el("input", { type: "text", value: signal.label });
      const description = el("textarea", {}, signal.description || "");
      const asset = el("input", { type: "text", value: signal.observable_asset || "" });
      const detection = el("select", {}, ["automated", "manual", "either"].map((value) =>
        el("option", { value, selected: value === signal.detection ? "" : undefined }, value)));
      const confidence = el("input", { type: "number", min: "0", max: "100", value: String(signal.default_confidence) });
      const recency = el("input", { type: "number", min: "1", max: "365", value: String(signal.recency_window_days) });
      const qualifying = el("input", { type: "checkbox", ...(Number(signal.qualifying) ? { checked: "" } : {}) });
      const guidance = el("textarea", {}, signal.guidance || "");
      const msg = el("div");
      return el("details", { class: "advanced signal-row" },
        el("summary", {}, `${signal.label} `, el("span", { class: "mono small muted" }, signal.signal_type),
          " ", Number(signal.active) ? pill(signal.detection, "good") : pill("disabled")),
        el("div", { class: "grid cols-2" },
          el("div", {}, el("label", {}, "Label"), label,
            el("label", {}, "Description"), description,
            el("label", {}, "Observable asset or event"), asset,
            el("label", {}, "Reviewer guidance"), guidance),
          el("div", {}, el("label", {}, "Detection"), detection,
            el("label", {}, "Default confidence (0–100)"), confidence,
            el("label", {}, "Recency window (days)"), recency,
            el("label", { class: "check-row" }, qualifying, " May anchor an outreach angle"))),
        el("div", { class: "btn-row" },
          el("button", { class: "btn small", onclick: async () => {
            const saved = await api("PATCH", `/api/signals/${signal.id}`, {
              label: label.value, description: description.value, observable_asset: asset.value,
              detection: detection.value, default_confidence: Number(confidence.value),
              recency_window_days: Number(recency.value), qualifying: qualifying.checked,
              guidance: guidance.value,
            });
            msg.replaceChildren(saved.status === 200 ? el("p", { class: "ok" }, "Saved.") : errBox(saved.body));
          } }, "Save signal"),
          el("button", { class: "btn small ghost", onclick: async () => {
            const toggled = await api("PATCH", `/api/signals/${signal.id}`, { active: !Number(signal.active) });
            if (toggled.status === 200) marketScreen(); else msg.replaceChildren(errBox(toggled.body));
          } }, Number(signal.active) ? "Disable" : "Enable")),
        msg);
    }

    function addSignalForm() {
      const dimension = el("select", {}, Object.entries(dimensionLabels).map(([value, text]) =>
        el("option", { value }, text)));
      const slug = el("input", { type: "text", placeholder: "kebab-case-slug" });
      const label = el("input", { type: "text", placeholder: "Respectful display label" });
      const description = el("textarea", { placeholder: "What is observed, stated neutrally" });
      const detection = el("select", {}, ["manual", "automated", "either"].map((value) => el("option", { value }, value)));
      const confidence = el("input", { type: "number", min: "0", max: "100", value: "70" });
      const recency = el("input", { type: "number", min: "1", max: "365", value: "60" });
      const qualifying = el("input", { type: "checkbox" });
      const msg = el("div");
      return el("details", { class: "card advanced" }, el("summary", {}, "Add a signal"),
        el("div", { class: "grid cols-2" },
          el("div", {}, el("label", {}, "Dimension"), dimension, el("label", {}, "Signal type (slug)"), slug,
            el("label", {}, "Label"), label, el("label", {}, "Description"), description),
          el("div", {}, el("label", {}, "Detection"), detection, el("label", {}, "Default confidence"), confidence,
            el("label", {}, "Recency window (days)"), recency,
            el("label", { class: "check-row" }, qualifying, " May anchor an outreach angle"))),
        el("button", { class: "btn small", onclick: async () => {
          const created = await api("POST", "/api/signals", {
            dimension: dimension.value, signal_type: slug.value, label: label.value,
            description: description.value, detection: detection.value,
            default_confidence: Number(confidence.value), recency_window_days: Number(recency.value),
            qualifying: qualifying.checked,
          });
          if (created.status === 201) marketScreen(); else msg.replaceChildren(errBox(created.body));
        } }, "Add signal"), msg);
    }

    // Scoring model editor: weights per factor, thresholds, priority weights.
    const weightInputs = {};
    const thresholdInputs = {};
    const priorityInputs = {};
    const modelMsg = el("div");
    const dimensionCards = Object.entries(model.dimensions).map(([key, dimension]) => {
      weightInputs[key] = {};
      return el("article", { class: "service-catalog-item" },
        el("strong", {}, dimension.label || key),
        ...dimension.factors.map((factor) => {
          const input = el("input", { type: "number", min: "0", max: "100", value: String(factor.weight), class: "weight-input" });
          weightInputs[key][factor.factor] = { input, label: factor.label };
          return el("label", { class: "weight-row" }, input, ` ${factor.label}`);
        }),
        (() => {
          const threshold = el("input", { type: "number", min: "0", max: "100",
            value: String(model.thresholds[key] ?? 0), class: "weight-input" });
          thresholdInputs[key] = threshold;
          return el("label", { class: "weight-row threshold-row" }, threshold, " minimum score (threshold)");
        })(),
        (() => {
          const priority = el("input", { type: "number", min: "0", max: "100",
            value: String(model.priority_weights[key] ?? 0), class: "weight-input" });
          priorityInputs[key] = priority;
          return el("label", { class: "weight-row" }, priority, " share of overall priority");
        })());
    });
    const priorityThreshold = el("input", { type: "number", min: "0", max: "100",
      value: String(model.thresholds.overall_priority ?? 0), class: "weight-input" });

    async function saveModel() {
      const dimensions = {};
      for (const [key, dimension] of Object.entries(model.dimensions)) {
        dimensions[key] = { label: dimension.label, factors: dimension.factors.map((factor) => ({
          factor: factor.factor, label: factor.label,
          weight: Number(weightInputs[key][factor.factor].input.value),
        })) };
      }
      const thresholds = { overall_priority: Number(priorityThreshold.value) };
      const priorityWeights = {};
      for (const key of Object.keys(model.dimensions)) {
        thresholds[key] = Number(thresholdInputs[key].value);
        priorityWeights[key] = Number(priorityInputs[key].value);
      }
      const saved = await api("PATCH", "/api/scoring-model", {
        dimensions, thresholds, priority_weights: priorityWeights,
      });
      modelMsg.replaceChildren(saved.status === 200
        ? el("p", { class: "ok" }, "Scoring model saved.") : errBox(saved.body));
    }

    const grouped = {};
    for (const signal of signals) (grouped[signal.dimension] ||= []).push(signal);

    setView(
      el("h1", {}, "Market model"),
      el("p", { class: "sub" }, "Your copywriting services, the observable signals Reachwright may use, and the deterministic scoring rules. Everything here is editable and persists; every change is audited."),
      el("div", { class: "btn-row" },
        el("button", { class: "btn ghost small", onclick: () => { location.hash = "#/clients"; } },
          "Edit the service catalog →")),
      el("h2", {}, "Signal library"),
      el("p", { class: "small muted" }, "Five separated dimensions. A signal describes what was observed — never a verdict on the prospect. Copy-opportunity signals marked as angle-anchors may open an outreach message."),
      ...Object.entries(dimensionLabels).map(([dimension, label]) =>
        el("section", { class: "card" },
          el("h3", {}, `${label} (${(grouped[dimension] || []).length})`),
          ...(grouped[dimension] || []).map(signalEditor))),
      addSignalForm(),
      el("h2", {}, "Scoring model"),
      el("p", { class: "small muted" },
        `${model.label} · ${model.version} — six separate deterministic scores. Weights inside a dimension must sum to 100; priority shares must sum to 100. A candidate must pass every threshold and every hard gate; no dimension compensates for another.`),
      el("div", { class: "service-catalog-grid" }, dimensionCards),
      el("label", { class: "weight-row" }, priorityThreshold, " minimum overall priority"),
      el("div", { class: "btn-row" }, el("button", { class: "btn", onclick: saveModel }, "Save scoring model")),
      modelMsg,
      el("h3", {}, "Hard gates (always enforced)"),
      el("ul", { class: "small" }, model.hard_gates.map((gate) => el("li", {},
        el("strong", {}, `${gate.gate}: `), gate.reason))),
    );
  }

  async function clientsScreen() {
    const result = await api("GET", "/api/clients");
    if (result.status !== 200) return setView(errBox(result.body));
    const clients = result.body.clients;
    const [serviceResults, offerResults] = await Promise.all([
      Promise.all(clients.map((client) => api("GET", `/api/clients/${client.id}/services`))),
      Promise.all(clients.map((client) => api("GET", `/api/clients/${client.id}/offers`))),
    ]);
    const createMsg = el("div");
    const clientName = el("input", { type: "text", placeholder: "Client business name" });
    const clientOwner = el("input", { type: "text", value: "michael" });
    const clientMode = el("select", {},
      el("option", { value: "managed-client" }, "Managed client"),
      el("option", { value: "internal" }, "Internal business"));

    // Full copywriting-model editor for one service. Lists edit as one item
    // per line; prose fields edit directly. Saving PATCHes only this service.
    function serviceEditor(service) {
      const textInput = (value) => el("input", { type: "text", value: value || "" });
      const listInput = (values) => el("textarea", {}, (values || []).join("\n"));
      const fields = {
        name: textInput(service.name),
        description: el("textarea", {}, service.description || ""),
        entry_angle: el("textarea", {}, service.entry_angle || ""),
        signal_types: listInput(service.signal_types),
        target_business_type: textInput(service.target_business_type),
        target_buyer: textInput(service.target_buyer),
        company_stage: textInput(service.company_stage),
        minimum_commercial_value: textInput(service.minimum_commercial_value),
        capacity_indicators: listInput(service.capacity_indicators),
        buying_triggers: listInput(service.buying_triggers),
        service_disqualifiers: listInput(service.service_disqualifiers),
        required_evidence: listInput(service.required_evidence),
        contact_roles: listInput(service.contact_roles),
        permitted_claims: listInput(service.permitted_claims),
        prohibited_claims: listInput(service.prohibited_claims),
        typical_cta: textInput(service.typical_cta),
        next_step: textInput(service.next_step),
        priority: el("input", { type: "number", min: "0", max: "1000", value: String(service.priority) }),
      };
      const msg = el("div");
      const lines = (field) => field.value.split("\n").map((value) => value.trim()).filter(Boolean);
      const labeled = (text, node) => el("div", {}, el("label", {}, text), node);
      return el("details", { class: "advanced service-row" },
        el("summary", {}, `${service.name} `,
          Number(service.active) ? pill("active", "good") : pill("disabled"),
          " ", el("span", { class: "small muted" }, service.target_buyer || "")),
        el("div", { class: "grid cols-2" },
          el("div", {},
            labeled("Service name", fields.name),
            labeled("Plain-language description", fields.description),
            labeled("Entry angle", fields.entry_angle),
            labeled("Opportunity signals (one per line)", fields.signal_types),
            labeled("Buying triggers (one per line)", fields.buying_triggers),
            labeled("Capacity indicators (one per line)", fields.capacity_indicators),
            labeled("Disqualifiers (one per line)", fields.service_disqualifiers),
            labeled("Required evidence (one per line)", fields.required_evidence)),
          el("div", {},
            labeled("Target business type", fields.target_business_type),
            labeled("Target buyer", fields.target_buyer),
            labeled("Suitable company stage", fields.company_stage),
            labeled("Minimum commercial value", fields.minimum_commercial_value),
            labeled("Suitable contact roles (one per line)", fields.contact_roles),
            labeled("Permitted outreach claims (one per line)", fields.permitted_claims),
            labeled("Prohibited outreach claims (one per line)", fields.prohibited_claims),
            labeled("Typical CTA", fields.typical_cta),
            labeled("Typical next step", fields.next_step),
            labeled("Priority (lower runs first)", fields.priority))),
        el("div", { class: "btn-row" },
          el("button", { class: "btn small", onclick: async () => {
            const saved = await api("PATCH", `/api/services/${service.id}`, {
              name: fields.name.value, description: fields.description.value,
              entry_angle: fields.entry_angle.value, signal_types: lines(fields.signal_types),
              target_business_type: fields.target_business_type.value,
              target_buyer: fields.target_buyer.value, company_stage: fields.company_stage.value,
              minimum_commercial_value: fields.minimum_commercial_value.value,
              capacity_indicators: lines(fields.capacity_indicators),
              buying_triggers: lines(fields.buying_triggers),
              service_disqualifiers: lines(fields.service_disqualifiers),
              required_evidence: lines(fields.required_evidence),
              contact_roles: lines(fields.contact_roles),
              permitted_claims: lines(fields.permitted_claims),
              prohibited_claims: lines(fields.prohibited_claims),
              typical_cta: fields.typical_cta.value, next_step: fields.next_step.value,
              priority: Number(fields.priority.value),
            });
            msg.replaceChildren(saved.status === 200 ? el("p", { class: "ok" }, "Service saved.") : errBox(saved.body));
          } }, "Save service"),
          el("button", { class: "btn small ghost", onclick: async () => {
            const toggled = await api("PATCH", `/api/services/${service.id}`, { active: !Number(service.active) });
            if (toggled.status === 200) clientsScreen(); else msg.replaceChildren(errBox(toggled.body));
          } }, Number(service.active) ? "Disable service" : "Enable service")),
        msg);
    }

    function clientCard(client, index) {
      const services = serviceResults[index].body?.services ?? [];
      const offers = offerResults[index].body?.offers ?? [];
      const msg = el("div");
      const offerName = el("input", { type: "text", placeholder: "The offer this client sells" });
      const offerDescription = el("textarea", { placeholder: "What the customer receives" });
      const offerIcp = el("textarea", { placeholder: "Who this offer is for" });
      const offerProof = el("textarea", { placeholder: "Confirmed proof points, one per line" });
      const offerEconomics = el("input", { type: "text", placeholder: "Economics or qualification note" });
      const serviceName = el("input", { type: "text", placeholder: "Service you can recommend" });
      const serviceDescription = el("textarea", { placeholder: "Focused service outcome" });
      const serviceAngle = el("textarea", { placeholder: "How to enter the conversation without pitching everything" });
      const serviceSignals = el("textarea", { placeholder: "Supported signal types, one per line" });
      const serviceType = el("select", {}, ["consultation", "diagnostic", "sprint", "retainer", "service", "custom"].map((value) =>
        el("option", { value, selected: value === "service" ? "" : undefined }, value)));
      return el("section", { class: "card client-card" },
        el("div", { class: "detail-head" }, el("div", {}, el("p", { class: "eyebrow" }, client.mode),
          el("h2", {}, client.name), el("p", { class: "small muted" },
            `${client.campaigns} campaigns · ${client.offers} offers · ${client.services} active services`)), pill(client.status, "good")),
        el("h3", {}, "Client offers"),
        el("div", { class: "service-catalog-grid" }, offers.length ? offers.map((offer) => el("article", { class: "service-catalog-item" },
          el("strong", {}, offer.name), el("p", { class: "small" }, offer.description),
          el("p", { class: "small muted" }, offer.ideal_customer || "No ideal customer recorded"),
          offer.active ? pill("active", "good") : pill("inactive"))) : el("p", { class: "small muted" }, "No client offer yet.")),
        el("h3", {}, "Service matching catalog"),
        el("p", { class: "small muted" }, "Each service carries its own targeting, triggers, disqualifiers, evidence requirements, contact roles, and claim rules. Open a service to edit or disable it."),
        services.length ? services.map(serviceEditor) : el("p", { class: "small muted" }, "No active service match exists; generation will fail closed."),
        el("details", { class: "advanced client-config" }, el("summary", {}, "Add an offer this client sells"),
          el("div", { class: "grid cols-2" },
            el("div", {}, el("label", {}, "Offer name"), offerName, el("label", {}, "Description"), offerDescription,
              el("label", {}, "Ideal customer"), offerIcp),
            el("div", {}, el("label", {}, "Proof points"), offerProof, el("label", {}, "Economics note"), offerEconomics)),
          el("button", { class: "btn small", onclick: async () => {
            const created = await api("POST", `/api/clients/${client.id}/offers`, {
              name: offerName.value, description: offerDescription.value, ideal_customer: offerIcp.value,
              proof_points: offerProof.value.split("\n").map((value) => value.trim()).filter(Boolean),
              economics_note: offerEconomics.value,
            });
            if (created.status === 201) clientsScreen(); else msg.replaceChildren(errBox(created.body));
          } }, "Add client offer")),
        el("details", { class: "advanced client-config" }, el("summary", {}, "Add a service Reachwright may recommend"),
          el("div", { class: "grid cols-2" },
            el("div", {}, el("label", {}, "Service name"), serviceName, el("label", {}, "Description"), serviceDescription,
              el("label", {}, "Focused entry angle"), serviceAngle),
            el("div", {}, el("label", {}, "Supported signal types"), serviceSignals,
              el("label", {}, "Delivery type"), serviceType)),
          el("button", { class: "btn small", onclick: async () => {
            const created = await api("POST", `/api/clients/${client.id}/services`, {
              name: serviceName.value, description: serviceDescription.value, entry_angle: serviceAngle.value,
              signal_types: serviceSignals.value.split("\n").map((value) => value.trim()).filter(Boolean),
              delivery_type: serviceType.value, public_rung: true, priority: 100,
            });
            if (created.status === 201) clientsScreen(); else msg.replaceChildren(errBox(created.body));
          } }, "Add service match")),
        msg);
    }

    setView(el("h1", {}, "Clients and service catalogs"),
      el("p", { class: "sub" }, "Campaign targeting, generation runs, service matching, and reporting stay client-scoped. Global suppression and one-message safety remain protective across every client."),
      el("details", { class: "card client-create" }, el("summary", {}, "Add a managed client"),
        el("div", { class: "grid cols-3" },
          el("div", {}, el("label", {}, "Client name"), clientName),
          el("div", {}, el("label", {}, "Operator owner"), clientOwner),
          el("div", {}, el("label", {}, "Mode"), clientMode)),
        el("button", { class: "btn small", onclick: async () => {
          const created = await api("POST", "/api/clients", {
            name: clientName.value, owner: clientOwner.value, mode: clientMode.value,
          });
          if (created.status === 201) clientsScreen(); else createMsg.replaceChildren(errBox(created.body));
        } }, "Create separated client workspace"), createMsg),
      ...clients.map(clientCard));
  }

  async function settingsScreen() {
    const providers = await api("GET", "/api/providers");
    const rows = providers.body?.providers ?? [];
    setView(el("h1", {}, "Settings and safeguards"),
      el("p", { class: "sub" }, "Advanced administration stays available without dominating the generation workflow."),
      el("div", { class: "grid cols-3" },
        el("button", { class: "card settings-link", onclick: () => { location.hash = "#/market"; } },
          el("strong", {}, "Market model"), el("span", {}, "Signals, scoring rules, and thresholds")),
        el("button", { class: "card settings-link", onclick: () => { location.hash = "#/suppression"; } },
          el("strong", {}, "Suppression"), el("span", {}, "Global opt-outs and exact contact blocks")),
        el("button", { class: "card settings-link", onclick: () => { location.hash = "#/qualify"; } },
          el("strong", {}, "Qualification flows"), el("span", {}, "Advanced inbound decision rules")),
        el("button", { class: "card settings-link", onclick: () => { location.hash = "#/clients"; } },
          el("strong", {}, "Client catalogs"), el("span", {}, "Services and campaign ownership"))),
      el("h2", {}, "Generation sources"),
      el("div", { class: "card table-wrap" }, el("table", {},
        el("thead", {}, el("tr", {}, ["Source", "Mode", "Organizations", "People", "Contact enrichment"].map((head) => el("th", {}, head)))),
        el("tbody", {}, rows.length ? rows.map((item) => el("tr", {}, el("td", {}, item.provider),
          el("td", {}, item.live_connection_verified ? "live verified" : "configured, unproven"),
          el("td", {}, item.capabilities.organization_search === false ? "No" : "Yes"),
          el("td", {}, item.capabilities.people_search ? "Yes" : "No"),
          el("td", {}, item.capabilities.person_enrichment ? "Yes" : "No")))
          : el("tr", {}, el("td", { colspan: "5", class: "muted" }, "No provider configured."))))));
  }

  // -------------------------------------------------------------- dashboard
  async function dashboardScreen() {
    const [result, today] = await Promise.all([api("GET", "/api/dashboard"), api("GET", "/api/today")]);
    if (result.status !== 200) return setView(errBox(result.body));
    const d = result.body;
    const tiles = [
      ["Active campaigns", d.campaigns_active], ["Candidates found", d.candidates_found],
      ["Dossiers w/ accepted evidence", d.dossiers_with_accepted_evidence],
      ["Rule-ready dossiers", d.rule_ready_dossiers],
      ["Approvals waiting", d.approvals_waiting], ["Outreach prepared", d.outreach_prepared],
      ["Replies", d.replies], ["Qualified conversations", d.qualified_conversations],
      ["Booked", d.bookings_booked], ["Held calls", d.calls_held], ["Opt-outs", d.opt_outs],
    ];
    setView(
      el("h1", {}, "Dashboard"),
      el("p", { class: "sub" }, "Candidates are not leads until they pass a campaign's thresholds. Booked is not held."),
      el("div", { class: "grid cols-5" },
        tiles.map(([label, n]) => el("div", { class: "stat" }, el("div", { class: "n" }, String(n ?? 0)), el("div", { class: "l" }, label)))),
      el("h2", {}, "Today's work"),
      el("div", { class: "card table-wrap" }, el("table", {},
        el("thead", {}, el("tr", {}, ["Priority", "Organization", "Campaign", "Detail"].map((h) => el("th", {}, h)))),
        el("tbody", {}, (today.body?.tasks ?? []).length ? today.body.tasks.map((task) => el("tr", {
          class: "clickable", onclick: () => {
            location.hash = ["approve-draft", "export-approved"].includes(task.kind)
              ? "#/approvals" : `#/dossier/${task.organization_id}`;
          },
        }, el("td", {}, pill(taskLabels[task.kind] || task.kind, task.kind === "follow-up-due" ? "warn" : "")),
        el("td", {}, task.organization_name), el("td", {}, task.campaign_name), el("td", { class: "small muted" }, task.detail)))
          : el("tr", {}, el("td", { colspan: "4", class: "muted" }, "No pilot tasks due."))))),
    );
  }

  // ----------------------------------------------------- revenue command center
  async function revenueScreen() {
    const result = await api("GET", "/api/revenue-plan");
    if (result.status !== 200) return setView(errBox(result.body));
    const data = result.body;
    const plan = data.plan;
    const actual = data.actual;
    const required = data.required;
    const funnelLabels = [
      ["qualified_prospects", "Qualified prospects"], ["messages_selected", "Messages selected"],
      ["manually_sent", "Manually sent"], ["positive_replies", "Positive replies"],
      ["meetings_booked", "Meetings booked"], ["meetings_held", "Meetings held"],
      ["offers_recommended", "Offers recommended"], ["agreements_sent_or_signed", "Agreements sent/signed"],
      ["operator_confirmed_sales", "Operator-confirmed sales"],
    ];
    const targetInput = el("input", { type: "number", min: "1000", step: "100", value: String(plan.target_mrr_cents / 100) });
    const averageInput = el("input", { type: "number", min: "100", step: "100", value: String(plan.average_client_mrr_cents / 100) });
    const closeInput = el("input", { type: "number", min: "1", max: "100", step: "1", value: String(Math.round(plan.assumed_held_call_close_rate * 100)) });
    const showInput = el("input", { type: "number", min: "1", max: "100", step: "1", value: String(Math.round(plan.assumed_booking_show_rate * 100)) });
    const bookInput = el("input", { type: "number", min: "1", max: "100", step: "1", value: String(Math.round(plan.assumed_positive_reply_to_booking_rate * 100)) });
    const replyInput = el("input", { type: "number", min: "1", max: "100", step: "1", value: String(Math.round(plan.assumed_outreach_to_positive_reply_rate * 100)) });
    const daysInput = el("input", { type: "number", min: "1", max: "7", step: "1", value: String(plan.weekly_outreach_days) });
    const saveStatus = el("span", { class: "small muted" });
    const progress = Math.max(0, Math.min(1, Number(actual.target_progress || 0)));

    setView(
      el("div", { class: "revenue-hero" },
        el("div", {}, el("p", { class: "eyebrow" }, "Owner revenue command center"),
          el("h1", {}, `${money(actual.recorded_mrr_cents)} recorded MRR`),
          el("p", { class: "sub" }, `The current target is ${money(plan.target_mrr_cents)} per month. Reachwright turns the gap into an explicit client and activity plan, then replaces assumptions with your recorded outcomes.`)),
        el("div", { class: "revenue-target" }, el("strong", {}, money(actual.mrr_gap_cents)), el("span", {}, "MRR gap"))),
      el("div", { class: "revenue-progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100",
        "aria-valuenow": String(Math.round(progress * 100)) },
      el("span", { style: `width:${Math.round(progress * 100)}%` })),
      el("div", { class: "grid cols-4" }, [
        ["Target", money(plan.target_mrr_cents)], ["Average recurring client", money(plan.average_client_mrr_cents)],
        ["Recurring clients recorded", actual.recurring_clients_recorded],
        ["Additional clients needed", required.additional_recurring_clients],
      ].map(([label, value]) => el("div", { class: "stat" }, el("div", { class: "n revenue-stat" }, String(value)), el("div", { class: "l" }, label)))),
      el("section", { class: "card bottleneck-card" },
        el("div", {}, el("p", { class: "eyebrow" }, "Current bottleneck"),
          el("h2", {}, data.bottleneck.stage.replaceAll("-", " ")),
          el("p", {}, data.bottleneck.action)),
        el("a", { class: "btn", href: data.bottleneck.stage === "qualified-prospects" ? "#/today"
          : data.bottleneck.stage === "packet-review" ? "#/review"
            : data.bottleneck.stage === "manual-send" ? "#/approvals" : "#/sales" }, "Work the bottleneck")),
      el("h2", {}, "Recorded funnel truth"),
      el("div", { class: "revenue-funnel" }, funnelLabels.map(([key, label]) =>
        el("div", { class: "revenue-stage" }, el("strong", {}, String(data.funnel[key] ?? 0)), el("span", {}, label)))),
      el("h2", {}, "Planning requirements to close the current gap"),
      el("p", { class: "small muted" }, "These are reverse-planned targets from the assumptions below, not market benchmarks or promised conversion rates."),
      el("div", { class: "grid cols-5 revenue-required" }, [
        ["Wins", required.additional_recurring_clients], ["Held calls", required.held_calls],
        ["Bookings", required.bookings], ["Positive replies", required.positive_replies],
        ["Manual outreaches", required.manual_outreaches],
      ].map(([label, value]) => el("div", { class: "stat" }, el("div", { class: "n" }, String(value)), el("div", { class: "l" }, label)))),
      el("p", { class: "pace-callout" }, `${required.manual_outreaches_per_workday_for_four_weeks} carefully reviewed manual outreaches per workday would meet the current four-week planning pace. Change the assumptions if your actual data says otherwise.`),
      el("details", { class: "card revenue-settings" }, el("summary", {}, "Edit target and planning assumptions"),
        el("div", { class: "grid cols-2" },
          el("label", {}, "Target MRR ($)", targetInput),
          el("label", {}, "Average recurring client ($/month)", averageInput),
          el("label", {}, "Held call → client (%)", closeInput),
          el("label", {}, "Booking → held call (%)", showInput),
          el("label", {}, "Positive reply → booking (%)", bookInput),
          el("label", {}, "Manual outreach → positive reply (%)", replyInput),
          el("label", {}, "Outreach workdays per week", daysInput)),
        el("div", { class: "btn-row" }, el("button", { class: "btn", onclick: async () => {
          const saved = await api("PATCH", "/api/revenue-plan", {
            target_mrr_cents: Math.round(Number(targetInput.value) * 100),
            average_client_mrr_cents: Math.round(Number(averageInput.value) * 100),
            assumed_held_call_close_rate: Number(closeInput.value) / 100,
            assumed_booking_show_rate: Number(showInput.value) / 100,
            assumed_positive_reply_to_booking_rate: Number(bookInput.value) / 100,
            assumed_outreach_to_positive_reply_rate: Number(replyInput.value) / 100,
            weekly_outreach_days: Number(daysInput.value),
          });
          if (saved.status === 200) revenueScreen();
          else saveStatus.textContent = JSON.stringify(saved.body);
        } }, "Save revenue plan"), saveStatus)),
      el("div", { class: "card truth-note" }, el("strong", {}, "Revenue truth boundary"),
        el("p", { class: "small muted" }, `${data.truth.recurring_status_limit} ${data.truth.pipeline_limit}`)),
    );
  }

  // ----------------------------------------------------------- sales calls
  const discoveryPrompts = [
    ["primary_offer", "What do you sell, and what is the primary offer today?"],
    ["ideal_customer", "Who is the strongest-fit customer for that offer?"],
    ["customer_value", "What does a new customer usually mean to the business?"],
    ["current_acquisition", "How do prospects currently find, trust, and contact you?"],
    ["ninety_day_goal", "What result would make the next 90 days meaningful?"],
    ["primary_bottleneck", "Where are the right prospects disappearing today?"],
    ["business_consequence", "What is that constraint costing in time, revenue, or capacity?"],
    ["what_tried", "What have you already tried, and what happened?"],
    ["ten_lead_breakpoint", "If 10 ideal prospects arrived tomorrow, what would break first?"],
    ["constraint_reflection", "Reflect back the immediate constraint in one sentence."],
    ["recommended_next_step", "What is the smallest responsible next step you both agreed to?"],
  ];

  const callRail = [
    ["01", "Frame", "0–3 min", "Set the contract: understand the business, locate the constraint, and recommend a next step only if there is a fit."],
    ["02", "Understand", "3–9 min", "Offer, best customer, customer value, current acquisition, and the 90-day result."],
    ["03", "Diagnose", "9–17 min", "Locate the leak: opportunity, message, conversion, qualification, follow-up, or capacity. Ask what breaks with 10 ideal prospects."],
    ["04", "Reflect", "17–21 min", "Say: “What I’m hearing is that the immediate constraint is ___, causing ___. Is that accurate?” Do not pitch until they agree."],
    ["05", "Recommend + next step", "21–30 min", "Recommend one right-sized offer, answer questions, then agreement first and payment second. Work begins only after cleared payment."],
  ];

  function dateTimeLocalValue(value) {
    const date = value ? new Date(value) : new Date(Date.now() + 24 * 60 * 60 * 1000);
    if (!Number.isFinite(date.getTime())) return "";
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }

  async function copyText(value, status) {
    try {
      await navigator.clipboard.writeText(value);
      status.replaceChildren(el("p", { class: "ok" }, "Copied. LinkedIn still requires you to paste and send manually."));
    } catch {
      status.replaceChildren(errBox("Clipboard access was blocked. Select and copy the text manually."));
    }
  }

  async function salesScreen() {
    const [callsResult, offersResult] = await Promise.all([
      api("GET", "/api/sales/calls"), api("GET", "/api/sales/offers"),
    ]);
    if (callsResult.status !== 200) return setView(errBox(callsResult.body));
    if (offersResult.status !== 200) return setView(errBox(offersResult.body));
    const calls = callsResult.body.calls;
    const f = {
      prospect: el("input", { type: "text", placeholder: "Prospect name" }),
      title: el("input", { type: "text", placeholder: "Founder, CEO, Owner…" }),
      business: el("input", { type: "text", placeholder: "Business name" }),
      website: el("input", { type: "url", placeholder: "https://business.example (optional)" }),
      linkedin: el("input", { type: "url", placeholder: "https://www.linkedin.com/in/..." }),
      context: el("textarea", { maxlength: "500", placeholder: "Short sourcing context only — never paste a private thread transcript." }),
      scheduled: el("input", { type: "datetime-local", value: dateTimeLocalValue() }),
      timezone: el("input", { type: "text", value: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago" }),
    };
    const msg = el("div");
    const rows = calls.map((entry) => el("tr", {
      class: "clickable", onclick: () => { location.hash = `#/sales/${entry.id}`; },
    },
    el("td", {}, entry.prospect.name), el("td", {}, entry.prospect.business_name),
    el("td", {}, new Date(entry.call.scheduled_for).toLocaleString()),
    el("td", {}, pill(entry.call.status, entry.call.status === "held" ? "good" : entry.call.status === "booked" ? "copper" : "")),
    el("td", {}, entry.offer.snapshot.name || "Not recommended"),
    el("td", {}, pill(entry.agreement.status, entry.agreement.status === "signed" ? "good" : "")),
    el("td", {}, pill(entry.payment.status, entry.payment.status === "operator-confirmed-paid" ? "good" : "")),
    ));

    setView(
      el("div", { class: "sales-heading" }, el("div", {},
        el("p", { class: "eyebrow" }, "Reemergence · authenticated operator workspace"),
        el("h1", {}, "Sales Call Console"),
        el("p", { class: "sub" }, "Run one honest consultation from booked call to signed agreement to confirmed payment. Those are three separate facts."))),
      el("div", { class: "card pilot-intake" },
        el("h2", {}, "Add a booked LinkedIn call"),
        el("p", { class: "muted small" }, "This records a meeting you already booked. It does not contact the person, create a LinkedIn event, or claim the call was held."),
        el("div", { class: "grid cols-3" },
          el("div", {}, el("label", {}, "Prospect"), f.prospect),
          el("div", {}, el("label", {}, "Title"), f.title),
          el("div", {}, el("label", {}, "Business"), f.business),
          el("div", {}, el("label", {}, "Company website"), f.website),
          el("div", {}, el("label", {}, "LinkedIn member profile"), f.linkedin),
          el("div", {}, el("label", {}, "Scheduled time"), f.scheduled),
          el("div", {}, el("label", {}, "Timezone label"), f.timezone),
          el("div", {}, el("label", {}, "Source context (max 500 characters)"), f.context)),
        el("div", { class: "btn-row" }, el("button", { class: "btn", onclick: async () => {
          const scheduled = new Date(f.scheduled.value);
          if (!Number.isFinite(scheduled.getTime())) return msg.replaceChildren(errBox("Enter a valid scheduled time."));
          const created = await api("POST", "/api/sales/calls", {
            prospect_name: f.prospect.value, contact_title: f.title.value,
            business_name: f.business.value, company_website: f.website.value,
            linkedin_profile_url: f.linkedin.value, source_context: f.context.value,
            scheduled_for: scheduled.toISOString(),
            timezone: f.timezone.value,
          });
          if (created.status !== 201) return msg.replaceChildren(errBox(created.body));
          location.hash = `#/sales/${created.body.call.id}`;
        } }, "Add booked call")), msg),
      el("div", { class: "grid cols-3 offer-glance" }, offersResult.body.offers.map((offer) =>
        el("div", { class: `stat ${offer.visibility === "private-qualified-only" ? "private-offer" : ""}` },
          el("div", { class: "l" }, offer.visibility === "private-qualified-only" ? "PRIVATE · QUALIFIED ONLY" : offer.cadence),
          el("strong", {}, offer.name), el("div", { class: "n sales-price" }, offer.price_label)))),
      el("div", { class: "card table-wrap" }, el("table", {},
        el("thead", {}, el("tr", {}, ["Prospect", "Business", "Scheduled", "Call", "Offer", "Agreement", "Payment"].map((h) => el("th", {}, h)))),
        el("tbody", {}, rows.length ? rows : el("tr", {}, el("td", { colspan: "7", class: "muted" }, "No booked LinkedIn calls yet."))))),
    );
  }

  async function salesCallScreen(id) {
    const [callResult, offersResult] = await Promise.all([
      api("GET", `/api/sales/calls/${id}`), api("GET", "/api/sales/offers"),
    ]);
    if (callResult.status !== 200) return setView(errBox(callResult.body));
    if (offersResult.status !== 200) return setView(errBox(offersResult.body));
    const record = callResult.body.call;
    const offers = offersResult.body.offers;
    const selectedOffer = offers.find((offer) => offer.id === record.offer.id) || null;
    const actionMsg = el("div");
    const discovery = Object.fromEntries(discoveryPrompts.map(([key]) => [key,
      el("textarea", { placeholder: "Keep this factual and concise." }, record.call.discovery[key] || "")
    ]));
    const summary = el("textarea", { placeholder: "Decision, objections, commitments, and anything future-you must know." }, record.call.summary || "");
    const scheduled = el("input", { type: "datetime-local", value: dateTimeLocalValue(record.call.scheduled_for) });
    const timezone = el("input", { type: "text", value: record.call.timezone });
    const callStatus = el("select", {}, ["booked", "rescheduled", "held", "no-show", "canceled"].map((status) =>
      el("option", { value: status, selected: status === record.call.status ? "" : undefined }, status)));
    const agreementNote = el("input", { type: "text", value: record.agreement.note || "", placeholder: "Where the agreement or signed copy is stored" });
    const paymentNote = el("input", { type: "text", value: record.payment.confirmation_note || "", placeholder: "Invoice reference or Stripe/dashboard confirmation" });
    const paymentReveal = el("div");
    const copyStatus = el("div");
    const firstName = record.prospect.name.split(/\s+/)[0] || record.prospect.name;
    const nextMessage = `Hi ${firstName}, thank you for your time today. Based on our discussion, the immediate constraint we identified is ${record.call.discovery.primary_bottleneck || "[confirmed constraint]"}. Our agreed next step is ${record.call.discovery.recommended_next_step || "[agreed next step]"}. I’ll send any written scope and payment details separately after the agreement is signed.`;

    const reloadAfter = async (requestPromise, success) => {
      const result = await requestPromise;
      if (result.status >= 200 && result.status < 300) {
        actionMsg.replaceChildren(el("p", { class: "ok" }, success));
        await salesCallScreen(id);
      } else actionMsg.replaceChildren(errBox(result.body));
    };

    const agreementActions = [];
    if (record.agreement.status === "not-sent") agreementActions.push(el("button", { class: "btn small", onclick: () => reloadAfter(
      api("POST", `/api/sales/calls/${id}/agreement`, { status: "sent", note: agreementNote.value }), "Agreement recorded as sent."),
    }, "Record agreement sent"));
    if (record.agreement.status === "sent") agreementActions.push(el("button", { class: "btn small", onclick: () => reloadAfter(
      api("POST", `/api/sales/calls/${id}/agreement`, { status: "signed", note: agreementNote.value }), "Signed agreement recorded."),
    }, "Confirm signed agreement"));

    const paymentActions = [];
    if (selectedOffer?.payment_mode === "stripe-link" && record.payment.status === "not-sent") {
      paymentActions.push(el("button", { class: "btn small", disabled: record.agreement.status !== "signed" ? "" : undefined, onclick: async () => {
        const released = await api("GET", `/api/sales/calls/${id}/payment-link`);
        if (released.status !== 200) return paymentReveal.replaceChildren(errBox(released.body));
        const url = released.body.payment_url;
        paymentReveal.replaceChildren(el("div", { class: "payment-reveal" },
          el("p", { class: "ok" }, "Authorized link retrieved. This does not mark it shared."),
          el("div", { class: "btn-row" },
            el("button", { class: "btn small", onclick: () => copyText(url, paymentReveal) }, "Copy payment link"),
            el("a", { class: "btn ghost small", href: url, target: "_blank", rel: "noopener noreferrer" }, "Open checkout"))));
      } }, "Retrieve signed-client payment link"));
      paymentActions.push(el("button", { class: "btn ghost small", disabled: record.agreement.status !== "signed" ? "" : undefined, onclick: () => reloadAfter(
        api("POST", `/api/sales/calls/${id}/payment`, { status: "link-shared", note: paymentNote.value }), "Payment link recorded as manually shared."),
      }, "Record link actually shared"));
    }
    if (selectedOffer?.payment_mode === "invoice" && record.payment.status === "not-sent") paymentActions.push(
      el("button", { class: "btn small", disabled: record.agreement.status !== "signed" ? "" : undefined, onclick: () => reloadAfter(
        api("POST", `/api/sales/calls/${id}/payment`, { status: "invoice-sent", note: paymentNote.value }), "Invoice recorded as sent."),
      }, "Record invoice sent"));
    if (["link-shared", "invoice-sent"].includes(record.payment.status)) paymentActions.push(
      el("button", { class: "btn small", onclick: () => reloadAfter(
        api("POST", `/api/sales/calls/${id}/payment`, { status: "operator-confirmed-paid", note: paymentNote.value }), "Payment recorded as operator-confirmed."),
      }, "Confirm cleared payment"));

    setView(
      el("div", { class: "detail-head" }, el("div", {},
        el("p", { class: "eyebrow" }, "Booked LinkedIn consultation"),
        el("h1", {}, `${record.prospect.name} · ${record.prospect.business_name}`),
        el("p", { class: "sub" }, `${record.prospect.title || "Title unknown"} · ${new Date(record.call.scheduled_for).toLocaleString()} · ${record.call.timezone}`),
        record.prospect.company_website ? el("a", { href: record.prospect.company_website, target: "_blank", rel: "noopener noreferrer", class: "small" }, "Open company website") : null,
        record.prospect.source_context ? el("p", { class: "muted small" }, `Source context: ${record.prospect.source_context}`) : null),
      el("div", { class: "btn-row tight" },
        el("a", { class: "btn ghost small", href: record.prospect.linkedin_profile_url, target: "_blank", rel: "noopener noreferrer" }, "Open LinkedIn profile"),
        el("a", { class: "btn ghost small", href: "#/sales" }, "All calls"))),
      el("div", { class: "truth-grid" },
        el("div", { class: "truth-card" }, el("span", {}, "CALL TRUTH"), pill(record.call.status, record.call.status === "held" ? "good" : "copper"), el("small", {}, "Booked is not held.")),
        el("div", { class: "truth-card" }, el("span", {}, "AGREEMENT TRUTH"), pill(record.agreement.status, record.agreement.status === "signed" ? "good" : ""), el("small", {}, "Signed is recorded explicitly.")),
        el("div", { class: "truth-card" }, el("span", {}, "PAYMENT TRUTH"), pill(record.payment.status, record.payment.status === "operator-confirmed-paid" ? "good" : ""), el("small", {}, "Operator-confirmed, not webhook-verified."))),
      el("h2", {}, "Five-step call rail"),
      el("div", { class: "call-rail" }, callRail.map(([number, title, time, prompt]) =>
        el("div", { class: "rail-step" }, el("span", { class: "rail-number" }, number), el("strong", {}, title), el("small", {}, time), el("p", {}, prompt)))),
      el("div", { class: "grid cols-2" },
        el("div", { class: "card" },
          el("h2", {}, "Structured discovery"),
          el("p", { class: "muted small" }, "Capture only what the prospect actually says. Unknown stays unknown."),
          discoveryPrompts.map(([key, label]) => el("div", {}, el("label", {}, label), discovery[key])),
          el("label", {}, "Call summary"), summary,
          el("div", { class: "btn-row" }, el("button", { class: "btn", onclick: () => reloadAfter(
            api("PATCH", `/api/sales/calls/${id}`, {
              discovery: Object.fromEntries(discoveryPrompts.map(([key]) => [key, discovery[key].value])),
              summary: summary.value,
            }), "Discovery notes saved."),
          }, "Save discovery"))),
        el("div", {},
          el("div", { class: "card" },
            el("h2", {}, "Call record"),
            el("label", {}, "Call status"), callStatus,
            el("label", {}, "Scheduled time"), scheduled,
            el("label", {}, "Timezone label"), timezone,
            el("div", { class: "btn-row" }, el("button", { class: "btn ghost small", onclick: () => reloadAfter(
              api("PATCH", `/api/sales/calls/${id}`, {
                status: callStatus.value, scheduled_for: new Date(scheduled.value).toISOString(), timezone: timezone.value,
              }), "Call record updated."),
            }, "Update call truth"))),
          el("div", { class: "card" },
            el("h2", {}, "Manual LinkedIn handoff"),
            el("p", { class: "muted small" }, "Reachwright can open the profile and copy text. It never clicks Send, automates a connection, or posts for you."),
            el("div", { class: "msg-box" }, nextMessage),
            el("div", { class: "btn-row" },
              el("button", { class: "btn ghost small", onclick: () => copyText(nextMessage, copyStatus) }, "Copy next-step message"),
              el("a", { class: "btn ghost small", href: record.prospect.linkedin_profile_url, target: "_blank", rel: "noopener noreferrer" }, "Open LinkedIn")), copyStatus))),
      el("h2", {}, "Offer recommendation"),
      el("p", { class: "sub" }, "Recommend the smallest responsible engagement. The private proof sprint is a qualified fallback, not a public advertised price."),
      el("div", { class: "grid cols-3 offer-ladder" }, offers.map((offer) => {
        const selected = record.offer.id === offer.id;
        const locked = Boolean(record.offer.locked_at) && !selected;
        return el("div", { class: `card offer-card ${selected ? "selected" : ""} ${offer.visibility === "private-qualified-only" ? "private-offer" : ""}` },
          el("div", { class: "draft-card-head" }, el("span", { class: "eyebrow" }, offer.visibility.replaceAll("-", " ")), pill(offer.price_label, selected ? "good" : "copper")),
          el("h2", {}, offer.name),
          el("ul", {}, offer.scope.map((item) => el("li", {}, item))),
          el("p", { class: "muted small" }, offer.boundaries.join(" · ")),
          el("button", { class: `btn small ${selected ? "ghost" : ""}`, disabled: selected || locked ? "" : undefined, onclick: () => reloadAfter(
            api("PATCH", `/api/sales/calls/${id}/offer`, { offer_id: offer.id }), "Offer recommendation saved."),
          }, selected ? "Recommended" : locked ? "Locked by commercial progress" : "Recommend this offer"));
      })),
      el("div", { class: "commercial-grid" },
        el("div", { class: "card" }, el("h2", {}, "1 · Agreement"),
          el("p", {}, pill(record.agreement.status, record.agreement.status === "signed" ? "good" : "")),
          el("p", { class: "muted small" }, selectedOffer?.agreement_required === false ? "No agreement is required for the free consultation." : "Record sent, then record signed. Direct signed transitions are rejected."),
          selectedOffer?.agreement_required ? [el("label", {}, "Agreement note"), agreementNote] : null,
          el("div", { class: "btn-row" }, agreementActions)),
        el("div", { class: "card" }, el("h2", {}, "2 · Payment"),
          el("p", {}, pill(record.payment.status, record.payment.status === "operator-confirmed-paid" ? "good" : "")),
          el("p", { class: "muted small" }, selectedOffer?.payment_mode === "none" ? "No payment is required for the free consultation." : "The server will not reveal a Stripe link or accept an invoice until the agreement is signed. Retrieving a link is not sharing it; record sharing explicitly. Paid always needs your confirmation note."),
          selectedOffer?.payment_mode !== "none" ? [el("label", {}, "Payment or invoice confirmation note"), paymentNote] : null,
          el("div", { class: "btn-row" }, paymentActions), paymentReveal)),
      actionMsg,
      el("div", { class: "card danger-zone" },
        el("h2", {}, "Archive"), el("p", { class: "muted small" }, "Archive removes this call from the active list but preserves its commercial and audit history."),
        el("button", { class: "btn danger small", onclick: async () => {
          if (!window.confirm("Archive this call? Its audit history will be retained.")) return;
          const result = await api("DELETE", `/api/sales/calls/${id}`);
          if (result.status === 200) location.hash = "#/sales";
          else actionMsg.replaceChildren(errBox(result.body));
        } }, "Archive call")),
    );
  }

  // -------------------------------------------------------------- campaigns
  async function campaignsScreen() {
    const [result, clientsResult] = await Promise.all([
      api("GET", "/api/campaigns"), api("GET", "/api/clients"),
    ]);
    if (result.status !== 200) return setView(errBox(result.body));
    if (clientsResult.status !== 200) return setView(errBox(clientsResult.body));
    const clients = clientsResult.body.clients;
    const rows = result.body.campaigns.map((c) => el("tr", { class: "clickable", onclick: () => { location.hash = `#/campaigns/${c.id}`; } },
      el("td", {}, c.name), el("td", {}, c.client_name || c.client_id),
      el("td", {}, c.client_offer_name || "Custom brief"),
      el("td", {}, pill(c.status, c.status === "researching" ? "good" : "")),
      el("td", {}, c.brief_complete ? pill("complete", "good") : pill("incomplete", "bad")),
      el("td", {}, c.geography), el("td", { class: "mono" }, String(c.max_batch_size)),
    ));

    const f = {};
    const field = (key, label, input) => { f[key] = input; return [el("label", {}, label), input]; };
    const msg = el("div");
    const clientSelect = el("select", {}, clients.map((client) =>
      el("option", { value: client.id }, `${client.name} · ${client.mode}`)));
    const clientOfferSelect = el("select", {}, el("option", { value: "" }, "— custom campaign brief —"));
    const clientOffers = new Map();
    async function fillClientOffers() {
      const offersResult = await api("GET", `/api/clients/${clientSelect.value}/offers`);
      const offers = offersResult.body?.offers ?? [];
      clientOffers.clear();
      offers.forEach((offer) => clientOffers.set(offer.id, offer));
      clientOfferSelect.replaceChildren(el("option", { value: "" }, "— custom campaign brief —"),
        ...offers.filter((offer) => offer.active).map((offer) => el("option", { value: offer.id }, offer.name)));
    }
    clientSelect.addEventListener("change", fillClientOffers);
    const form = el("div", { class: "card" },
      el("h2", {}, "New campaign brief"),
      el("p", { class: "muted small" }, "Playbook rule: items 1–5 are mandatory. An incomplete brief cannot research."),
      el("div", { class: "grid cols-2" },
        el("div", {},
          el("label", {}, "Client"), clientSelect,
          el("label", {}, "Client offer snapshot"), clientOfferSelect,
          field("name", "Campaign name", el("input", { type: "text" })),
          field("owner", "Owner", el("input", { type: "text", value: "michael" })),
          field("offer", "Offer + credible proof available today", el("textarea")),
          field("icp", "Ideal customer profile", el("textarea")),
          field("geography", "Geography", el("input", { type: "text" })),
        ),
        el("div", {},
          field("min_economics", "Minimum customer economics", el("input", { type: "text" })),
          field("positive_signals", "Opportunity signals (one per line)", el("textarea")),
          field("buying_triggers", "Buying triggers (one per line)", el("textarea")),
          field("disqualifiers", "Hard disqualifiers (one per line)", el("textarea")),
          field("max_batch_size", "Max batch size", el("input", { type: "number", value: "10", min: "1", max: "100" })),
          el("label", {}, "Allowed channels"),
          el("div", {},
            ["linkedin-manual", "dm", "email", "phone"].map((channel) =>
              el("label", { class: "small", style: "display:inline-flex;gap:.35rem;margin-right:1rem;" },
                el("input", { type: "checkbox", value: channel, name: "channel" }), channel)),
          ),
        ),
      ),
      el("div", { class: "btn-row" },
        el("button", { class: "btn", onclick: async () => {
          const channels = [...form.querySelectorAll("input[name=channel]:checked")].map((c) => c.value);
          const body = {
            name: f.name.value, owner: f.owner.value, offer: f.offer.value, icp: f.icp.value,
            geography: f.geography.value, min_economics: f.min_economics.value,
            positive_signals: f.positive_signals.value.split("\n").map((s) => s.trim()).filter(Boolean),
            buying_triggers: f.buying_triggers.value.split("\n").map((s) => s.trim()).filter(Boolean),
            disqualifiers: f.disqualifiers.value.split("\n").map((s) => s.trim()).filter(Boolean),
            max_batch_size: Number(f.max_batch_size.value), allowed_channels: channels,
            client_id: clientSelect.value, client_offer_id: clientOfferSelect.value,
          };
          const created = await api("POST", "/api/campaigns", body);
          msg.replaceChildren(created.status === 201 ? el("p", { class: "ok" }, "Campaign created.") : errBox(created.body));
          if (created.status === 201) campaignsScreen();
        } }, "Create campaign")),
      msg,
    );
    await fillClientOffers();
    clientOfferSelect.addEventListener("change", () => {
      const offer = clientOffers.get(clientOfferSelect.value);
      if (!offer) return;
      f.offer.value = offer.description;
      if (offer.ideal_customer) f.icp.value = offer.ideal_customer;
      if (offer.economics_note) f.min_economics.value = offer.economics_note;
    });

    setView(
      el("h1", {}, "Campaigns"),
      el("div", { class: "card table-wrap" }, el("table", {},
        el("thead", {}, el("tr", {}, ["Name", "Client", "Offer", "Status", "Brief", "Geography", "Batch cap"].map((h) => el("th", {}, h)))),
        el("tbody", {}, rows.length ? rows : el("tr", {}, el("td", { colspan: "7", class: "muted" }, "No campaigns yet."))))),
      form,
    );
  }

  // -------------------------------------------------- campaign detail/queue
  async function campaignScreen(id) {
    const result = await api("GET", `/api/campaigns/${id}`);
    if (result.status !== 200) return setView(errBox(result.body));
    const c = result.body.campaign;
    const msg = el("div");

    const locations = el("input", { type: "text", value: c.geography, placeholder: "comma-separated locations" });
    const keywords = el("input", { type: "text", placeholder: "keyword tags, comma-separated" });
    const batch = el("input", { type: "number", value: String(Math.min(10, c.max_batch_size)), min: "1", max: String(c.max_batch_size) });
    const startPage = el("input", { type: "number", value: "1", min: "1", max: "500", readonly: "" });
    let continuationToken = "";
    const manual = {
      name: el("input", { type: "text", placeholder: "Business name" }),
      domain: el("input", { type: "text", placeholder: "example.com (optional)" }),
      location: el("input", { type: "text", value: c.geography }),
      source: el("input", { type: "url", placeholder: "https://official-source.example" }),
      strength: el("select", {}, ["authoritative-directory", "first-party", "secondary", "weak"].map((value) => el("option", { value }, value))),
      observed: el("input", { type: "date", value: new Date().toISOString().slice(0, 10) }),
      claim: el("textarea", { placeholder: "Exact, source-supported fact you can safely reference" }),
      verified: el("input", { type: "checkbox" }),
      contactName: el("input", { type: "text", placeholder: "Decision-maker name (optional)" }),
      contactTitle: el("input", { type: "text", placeholder: "Owner / founder / role" }),
      contactEmail: el("input", { type: "email", placeholder: "Business email (optional)" }),
      contactPhone: el("input", { type: "text", placeholder: "Business phone (optional)" }),
      contactSource: el("input", { type: "url", placeholder: "Usable LinkedIn or public DM profile (optional if email/phone exists)" }),
    };

    const searchParams = () => ({
      locations: locations.value.split(",").map((s) => s.trim()).filter(Boolean),
      keywords: keywords.value.split(",").map((s) => s.trim()).filter(Boolean),
      batch: Number(batch.value),
      start_page: Number(startPage.value),
      continuation_token: continuationToken,
    });
    const resetProviderCursor = () => { startPage.value = "1"; continuationToken = ""; };
    [locations, keywords, batch].forEach((input) => input.addEventListener("input", resetProviderCursor));

    const queueWrap = el("div", { class: "card table-wrap" }, el("p", { class: "muted" }, "Loading queue…"));
    async function loadQueue() {
      const queue = await api("GET", `/api/campaigns/${id}/queue`);
      if (queue.status !== 200) return queueWrap.replaceChildren(errBox(queue.body));
      const rows = queue.body.queue.map((entry) => el("tr", { class: "clickable", onclick: () => { location.hash = `#/dossier/${entry.organization.id}`; } },
        el("td", {}, entry.organization.display_name, el("div", { class: "mono muted" }, entry.organization.normalized_domain || "no domain")),
        el("td", {}, scorePill(entry.fit, 65)), el("td", {}, scorePill(entry.evidence_score, 70)),
        el("td", {}, entry.evidence_freshness_days === null ? pill("never verified", "bad")
          : entry.stale ? pill(`${entry.evidence_freshness_days}d — stale`, "warn") : pill(`${entry.evidence_freshness_days}d`, "good")),
        el("td", {}, entry.rule_ready ? pill("RULE-READY", "good")
          : pill(entry.readiness_reasons.map((reason) => readinessLabels[reason] || reason).join(", ") || "not ready", "warn")),
        el("td", {}, pill(entry.duplicate_state, entry.duplicate_state === "active" ? "" : "warn")),
        el("td", {}, entry.suppression.suppressed ? pill("SUPPRESSED", "bad") : pill("clear", "good")),
        el("td", { class: "small muted" }, entry.unknown_fields.join(", ") || "—"),
      ));
      queueWrap.replaceChildren(el("table", {},
        el("thead", {}, el("tr", {}, ["Organization", "Fit", "Evidence", "Freshness", "Rule readiness", "Dup state", "Suppression", "Unknown"].map((h) => el("th", {}, h)))),
        el("tbody", {}, rows.length ? rows : el("tr", {}, el("td", { colspan: "8", class: "muted" }, "Queue is empty — run a search or add evidence.")))));
    }

    setView(
      el("h1", {}, c.name),
      el("p", { class: "sub" }, `${c.icp} · ${c.geography} · economics: ${c.min_economics}`),
      el("div", { class: "btn-row" },
        pill(c.status, c.status === "researching" ? "good" : ""),
        c.brief_complete ? pill("brief complete", "good") : pill("brief incomplete", "bad"),
        el("button", { class: "btn small ghost", onclick: async () => {
          const target = c.status === "researching" ? "paused" : "researching";
          const patched = await api("PATCH", `/api/campaigns/${id}`, { status: target });
          if (patched.status === 200) campaignScreen(id); else msg.replaceChildren(errBox(patched.body));
        } }, c.status === "researching" ? "Pause" : "Start researching"),
        el("a", { class: "btn small ghost", href: `#/reports/${id}` }, "Report"),
      ),
      msg,
      (() => {
        const icpEdit = el("textarea", {}, c.icp || "");
        const geographyEdit = el("input", { type: "text", value: c.geography || "" });
        const signalsEdit = el("textarea", {}, jsonArray(c.positive_signals).join("\n"));
        const triggersEdit = el("textarea", {}, jsonArray(c.buying_triggers).join("\n"));
        const disqualifiersEdit = el("textarea", {}, jsonArray(c.disqualifiers).join("\n"));
        const briefMsg = el("div");
        const lines = (input) => input.value.split("\n").map((v) => v.trim()).filter(Boolean);
        return el("details", { class: "card advanced" },
          el("summary", {}, "Edit campaign brief (ICP, signals, triggers, disqualifiers)"),
          el("div", { class: "grid cols-2" },
            el("div", {}, el("label", {}, "Ideal customer profile"), icpEdit,
              el("label", {}, "Geography"), geographyEdit,
              el("label", {}, "Opportunity signals (one per line)"), signalsEdit),
            el("div", {}, el("label", {}, "Buying triggers (one per line)"), triggersEdit,
              el("label", {}, "Hard disqualifiers (one per line)"), disqualifiersEdit)),
          el("div", { class: "btn-row" }, el("button", { class: "btn small", onclick: async () => {
            const saved = await api("PATCH", `/api/campaigns/${id}`, {
              icp: icpEdit.value, geography: geographyEdit.value,
              positive_signals: lines(signalsEdit), buying_triggers: lines(triggersEdit),
              disqualifiers: lines(disqualifiersEdit),
            });
            if (saved.status === 200) campaignScreen(id);
            else briefMsg.replaceChildren(errBox(saved.body));
          } }, "Save brief")), briefMsg);
      })(),
      el("div", { class: "card pilot-intake" },
        el("div", { class: "eyebrow" }, "Five-dossier pilot · fastest path"),
        el("h2", {}, "Create a sourced dossier in one pass"),
        el("p", { class: "muted small" }, "Enter the company, one exact claim, and—when known—the decision-maker. Dedupe and suppression run before anything is saved."),
        el("div", { class: "grid cols-3" },
          el("div", {}, el("label", {}, "Business name"), manual.name),
          el("div", {}, el("label", {}, "Domain"), manual.domain),
          el("div", {}, el("label", {}, "Location"), manual.location),
          el("div", {}, el("label", {}, "Source URL"), manual.source),
          el("div", {}, el("label", {}, "Source strength"), manual.strength),
          el("div", {}, el("label", {}, "Observed"), manual.observed)),
        el("label", {}, "Exact personalization claim"), manual.claim,
        el("label", { class: "check-line" }, manual.verified,
          el("span", {}, "I checked this exact claim against the source above; save it as accepted evidence.")),
        el("fieldset", {}, el("legend", {}, "Decision-maker (optional, saves a second step)"),
          el("div", { class: "grid cols-3" },
            el("div", {}, el("label", {}, "Name"), manual.contactName),
            el("div", {}, el("label", {}, "Title"), manual.contactTitle),
            el("div", {}, el("label", {}, "Business email"), manual.contactEmail),
            el("div", {}, el("label", {}, "Business phone"), manual.contactPhone),
            el("div", {}, el("label", {}, "Usable public contact profile"), manual.contactSource))),
        el("button", { class: "btn small", onclick: async () => {
          if (!manual.name.value.trim() || !manual.location.value.trim() || !manual.source.value.trim()
            || !manual.claim.value.trim() || !manual.verified.checked) {
            return msg.replaceChildren(errBox("Business, location, source URL, exact claim, and verification checkbox are required for pilot intake."));
          }
          const created = await api("POST", "/api/organizations/manual", {
            display_name: manual.name.value, domain: manual.domain.value, location: manual.location.value,
            campaign_id: id, source_url: manual.source.value, source_strength: manual.strength.value, observed_at: manual.observed.value,
            claim: manual.claim.value, evidence_reviewed: manual.verified.checked,
            contact_name: manual.contactName.value, contact_title: manual.contactTitle.value,
            contact_email: manual.contactEmail.value, contact_phone: manual.contactPhone.value,
            contact_source_url: manual.contactName.value ? manual.contactSource.value : "",
          });
          if (created.status === 201) location.hash = `#/dossier/${created.body.organization_id}`;
          else msg.replaceChildren(errBox(created.body));
        } }, "Add and open dossier")),
      el("div", { class: "card" },
        el("h2", {}, "Company discovery"),
        el("p", { class: "muted small" }, "The configured provider creates research candidates, not verified leads. Every candidate still needs first-party evidence, a decision-maker, and the six-check audit."),
        el("div", { class: "grid cols-3" },
          el("div", {}, el("label", {}, "Locations"), locations),
          el("div", {}, el("label", {}, "Keywords"), keywords),
          el("div", {}, el("label", {}, `Batch (cap ${c.max_batch_size})`), batch),
          el("div", {}, el("label", {}, "Provider start page"), startPage)),
        el("div", { class: "btn-row" },
          el("button", { class: "btn ghost", onclick: async () => {
            const preview = await api("POST", `/api/campaigns/${id}/preview-search`, searchParams());
            msg.replaceChildren(preview.status === 200
              ? el("p", { class: "ok" }, `Planned provider page ${preview.body.page_plan.startPage} plus ${preview.body.page_plan.pages - 1} continuation page(s), at ${preview.body.page_plan.perPage}/page. Estimated ≤ ${preview.body.estimate.estimated} credits (${preview.body.estimate.basis}). Ceiling remaining: ${preview.body.credit_ceiling_remaining ?? "∞"}.${preview.body.would_exceed_ceiling ? " WOULD EXCEED CEILING." : ""}`)
              : errBox(preview.body));
          } }, "Preview provider usage"),
          el("button", { class: "btn", onclick: async () => {
            msg.replaceChildren(el("p", { class: "muted" }, "Searching…"));
            const search = await api("POST", `/api/campaigns/${id}/search`, searchParams());
            if (search.status === 200) {
              startPage.value = String(search.body.pagination.next_page || 1);
              continuationToken = search.body.pagination.continuation_token || "";
            }
            msg.replaceChildren(search.status === 200
              ? el("p", { class: "ok" }, `Fetched provider page(s) ${search.body.pagination.start_page}–${search.body.pagination.last_page} at ${search.body.pagination.per_page}/page. Stored ${search.body.summary.stored}, merged ${search.body.summary.merged} duplicates, attached ${search.body.summary.attached} existing companies to this campaign, ${search.body.summary.suppressed} suppressed, ${search.body.summary.skipped} skipped.${search.body.pagination.next_page ? ` Next run is safely staged at page ${search.body.pagination.next_page}; changing the filters or batch resets it.` : " No next provider page reported."}`)
              : errBox(search.body));
            loadQueue();
          } }, "Discover candidates"))),
      el("h2", {}, "Research queue"),
      queueWrap,
    );
    loadQueue();
  }

  // ---------------------------------------------------------------- dossier
  async function dossierScreen(orgId) {
    const result = await api("GET", `/api/organizations/${orgId}/dossier`);
    if (result.status !== 200) return setView(errBox(result.body));
    const d = result.body;
    const org = d.organization;
    const providerCapabilities = state.health?.provider?.capabilities || {};
    const providerPeopleSearch = providerCapabilities.people_search !== false;
    const providerContactEnrichment = providerCapabilities.contact_enrichment !== false;
    const campaigns = (await api("GET", "/api/campaigns")).body?.campaigns ?? [];
    const linkedCampaigns = campaigns.filter((campaign) => (d.campaign_ids ?? []).includes(campaign.id));
    if (linkedCampaigns.length === 0) {
      return setView(errBox("This organization is not linked to a campaign. Add campaign evidence before auditing, scoring, or drafting."));
    }
    const campaignName = (id) => linkedCampaigns.find((campaign) => campaign.id === id)?.name || "unlinked";
    const msg = el("div");

    function openPersonCorrection(person) {
      const fields = {
        full_name: el("input", { type: "text", value: person.full_name || "" }),
        title: el("input", { type: "text", value: person.title || "" }),
        business_email: el("input", { type: "email", value: person.business_email || "" }),
        business_phone: el("input", { type: "text", value: person.business_phone || "" }),
        public_profile_url: el("input", { type: "url", value: person.public_profile_url || "" }),
      };
      const confirmed = el("input", { type: "checkbox" });
      const dialogMsg = el("div");
      const dialog = el("dialog", {},
        el("h2", {}, "Correct decision-maker"),
        el("p", { class: "muted small" }, "A correction kills unexported drafts for this person and makes the dossier audit and scores stale."),
        el("div", { class: "grid cols-2" },
          el("div", {}, el("label", {}, "Name"), fields.full_name),
          el("div", {}, el("label", {}, "Title"), fields.title),
          el("div", {}, el("label", {}, "Business email"), fields.business_email),
          el("div", {}, el("label", {}, "Business phone"), fields.business_phone)),
        el("label", {}, "Usable LinkedIn or public DM profile"), fields.public_profile_url,
        el("label", { class: "check-line" }, confirmed,
          el("span", {}, "I checked these details against a current public or first-party source.")),
        el("div", { class: "btn-row" },
          el("button", { class: "btn small", onclick: async () => {
            if (!confirmed.checked) return dialogMsg.replaceChildren(errBox("Confirm that you checked the corrected details."));
            const contactNames = ["business_email", "business_phone", "public_profile_url"];
            const clearFields = contactNames.filter((name) => person[name] && !fields[name].value.trim());
            const corrected = await api("PATCH", `/api/people/${person.id}`, {
              full_name: fields.full_name.value, title: fields.title.value,
              business_email: fields.business_email.value || undefined,
              business_phone: fields.business_phone.value || undefined,
              public_profile_url: fields.public_profile_url.value || undefined,
              clear_fields: clearFields, observed_at: new Date().toISOString().slice(0, 10), confirmed: true,
            });
            if (corrected.status === 200) { dialog.close(); dialog.remove(); dossierScreen(orgId); }
            else dialogMsg.replaceChildren(errBox(corrected.body));
          } }, "Save verified correction"),
          el("button", { class: "btn small ghost", onclick: () => { dialog.close(); dialog.remove(); } }, "Cancel")),
        dialogMsg);
      document.body.append(dialog);
      dialog.showModal();
    }

    const evidenceList = d.evidence.map((item) => el("div", { class: "evidence-item" },
      el("div", {}, item.claim),
      el("div", { class: "mono muted small" }, `${item.strength} · ${campaignName(item.campaign_id)} · observed ${item.observed_at} · ${item.source_url}`),
      el("div", { class: "btn-row" },
        pill(item.reviewer_state, item.reviewer_state === "accepted" ? "good" : item.reviewer_state === "rejected" ? "bad" : ""),
        item.contradiction_state !== "none" ? pill(item.contradiction_state, "warn") : null,
        el("button", { class: "btn small ghost", onclick: async () => { await api("PATCH", `/api/evidence/${item.id}`, { reviewer_state: "accepted" }); dossierScreen(orgId); } }, "Accept"),
        el("button", { class: "btn small danger", onclick: async () => { await api("PATCH", `/api/evidence/${item.id}`, { reviewer_state: "rejected" }); dossierScreen(orgId); } }, "Reject"),
        el("button", { class: "btn small ghost", onclick: async () => { await api("PATCH", `/api/evidence/${item.id}`, { contradiction_state: item.contradiction_state === "contradicted" ? "resolved" : "contradicted" }); dossierScreen(orgId); } },
          item.contradiction_state === "contradicted" ? "Mark resolved" : "Flag contradiction"),
      )));

    // evidence form
    const ev = {
      claim: el("textarea", { placeholder: "The exact operational claim" }),
      url: el("input", { type: "url", placeholder: "https://…" }),
      date: el("input", { type: "date", value: new Date().toISOString().slice(0, 10) }),
      strength: el("select", {}, ["first-party", "authoritative-directory", "secondary", "weak"].map((s) => el("option", { value: s }, s))),
      campaign: el("select", {}, linkedCampaigns.map((c) => el("option", { value: c.id }, c.name))),
    };
    async function saveEvidence(acceptNow) {
      const added = await api("POST", `/api/organizations/${orgId}/evidence`, {
        claim: ev.claim.value, source_url: ev.url.value, observed_at: ev.date.value,
        strength: ev.strength.value, campaign_id: ev.campaign.value || undefined,
        reviewer_state: acceptNow ? "accepted" : "unreviewed",
      });
      if (added.status === 201) dossierScreen(orgId); else msg.replaceChildren(errBox(added.body));
    }
    ev.claim.addEventListener("keydown", (event) => {
      if (event.ctrlKey && event.key === "Enter") { event.preventDefault(); saveEvidence(true); }
    });

    // scoring form
    const factorNames = [["offer_match", "Offer match"], ["timing_signal", "Timing signal"], ["geography", "Geography"],
      ["economics", "Economics"], ["capacity_growth", "Capacity/growth"], ["reachable", "Reachable"]];
    const factorInputs = Object.fromEntries(factorNames.map(([key]) => [key,
      el("select", {}, [["0", "0 — no"], ["0.5", "0.5 — partial"], ["1", "1 — yes"]].map(([v, l]) => el("option", { value: v }, l)))]));
    const disqualifierInput = el("input", { type: "text", placeholder: "hard disqualifier reason (leave empty if none)" });
    const contactVerified = el("input", { type: "checkbox" });
    const manualPerson = {
      name: el("input", { type: "text", placeholder: "Decision-maker name" }),
      title: el("input", { type: "text", placeholder: "Owner / founder / role" }),
      email: el("input", { type: "email", placeholder: "Business email (optional)" }),
      phone: el("input", { type: "text", placeholder: "Business phone (optional)" }),
      source: el("input", { type: "url", placeholder: "Usable LinkedIn or public DM profile (optional if email/phone exists)" }),
    };
    const auditCampaign = el("select", {}, linkedCampaigns.map((c) => el("option", { value: c.id }, c.name)));
    const auditVerdict = el("select", {}, ["accurate", "partly-accurate", "reject"].map((v) => el("option", { value: v }, v)));
    const auditNotes = el("textarea", { placeholder: "What was checked" });
    const auditCheckLabels = {
      identity_verified: "Company identity verified",
      offer_signal_verified: "Offer or need signal verified",
      geography_verified: "Geography verified",
      decision_maker_verified: "Decision-maker verified",
      contact_path_verified: "Allowed contact path verified",
      contradictions_checked: "Contradictions checked and resolved",
    };
    const auditChecks = Object.fromEntries(Object.keys(auditCheckLabels)
      .map((name) => [name, el("input", { type: "checkbox" })]));

    // draft form
    const eligiblePeople = d.people.filter((person) => !person.do_not_contact);
    const personSelect = el("select", {}, eligiblePeople.length
      ? eligiblePeople.map((p) => el("option", { value: p.id }, `${p.full_name} (${p.title || "?"})`))
      : el("option", { value: "" }, "— add an eligible decision-maker first —"));
    const channelSelect = el("select", {}, ["linkedin-manual", "dm", "email", "phone"].map((c) => el("option", { value: c }, c)));
    const outreachKind = el("select", {}, [["initial", "Initial message"], ["follow-up", "Single follow-up (after 7 days)"]]
      .map(([value, label]) => el("option", { value }, label)));
    const scoreCampaign = el("select", {}, linkedCampaigns.map((c) => el("option", { value: c.id }, c.name)));
    const draftCampaign = el("select", {}, linkedCampaigns.map((c) => el("option", { value: c.id }, c.name)));
    const externalCampaign = el("select", {}, linkedCampaigns.map((c) => el("option", { value: c.id }, c.name)));
    const externalPerson = el("select", {},
      el("option", { value: "" }, "— company only —"),
      d.people.map((p) => el("option", { value: p.id }, `${p.full_name} (${p.title || "?"})`)));
    const externalChannel = el("select", {}, ["linkedin-manual", "email", "dm", "phone"]
      .map((channel) => el("option", { value: channel }, channel)));
    const externalDate = el("input", { type: "date", value: new Date().toISOString().slice(0, 10) });
    const externalNotes = el("textarea", { placeholder: "What was sent and any context needed to recognize it later" });
    const externalAttempts = d.contact_attempts.filter((attempt) => !attempt.draft_id);
    const externalConversationClosed = externalAttempts.some((attempt) =>
      ["replied", "positive-reply", "opted-out", "closed"].includes(attempt.status));
    function refreshDraftChannels() {
      const campaign = linkedCampaigns.find((item) => item.id === draftCampaign.value);
      const allowed = jsonArray(campaign?.allowed_channels);
      const selectedPerson = d.people.find((person) => person.id === personSelect.value);
      const usable = allowed.filter((channel) => selectedPerson && !selectedPerson.do_not_contact && (
        (channel === "email" && selectedPerson.business_email)
        || (channel === "phone" && selectedPerson.business_phone)
        || (["linkedin-manual", "dm"].includes(channel) && selectedPerson.public_profile_url)
      ));
      channelSelect.replaceChildren(...(usable.length
        ? usable.map((channel) => el("option", { value: channel }, channel))
        : [el("option", { value: "" }, "— no usable allowed channel for this person —")]));
    }
    draftCampaign.addEventListener("change", refreshDraftChannels);
    personSelect.addEventListener("change", refreshDraftChannels);
    refreshDraftChannels();
    const latestAuditText = el("p", { class: "small" });
    function refreshAuditText() {
      const latest = d.audits.find((item) => item.campaign_id === auditCampaign.value);
      latestAuditText.textContent = latest
        ? `Latest for ${campaignName(auditCampaign.value)}: ${latest.verdict} · ${latest.audited_at.slice(0, 16)} · ${latest.notes || "no notes"}`
        : `No audit recorded for ${campaignName(auditCampaign.value)}.`;
    }
    auditCampaign.addEventListener("change", refreshAuditText);
    refreshAuditText();

    setView(
      el("h1", {}, org.display_name),
      el("p", { class: "sub mono" }, `${org.normalized_domain || "no domain"} · ${org.location || "location unknown"} · source: ${org.provider || "manual"} · first seen ${org.first_seen} · last verified ${org.last_verified || "never"}`),
      el("div", { class: "btn-row" },
        d.suppression.suppressed ? pill("SUPPRESSED — no outreach", "bad") : pill("suppression clear", "good"),
        pill(`merge: ${org.merge_state}`)),
      msg,

      el("div", { class: "grid cols-2" },
        el("div", { class: "card" },
          el("h2", {}, `People (${d.people.length})`),
          d.people.length === 0 ? el("p", { class: "muted small" }, "None stored.") : null,
          d.people.map((p) => el("div", { class: "person-row" },
            el("p", { class: "small" },
              `${p.full_name} — ${p.title || "?"} `,
              p.business_email ? el("span", { class: "mono" }, `· ${p.business_email} (${p.email_status})`) : " · no email",
              p.do_not_contact ? pill("do-not-contact", "bad") : null),
            el("div", { class: "btn-row tight" },
              el("button", { class: "btn small ghost", onclick: () => openPersonCorrection(p) }, "Correct"),
              p.provider_id && !p.do_not_contact && providerContactEnrichment ? el("button", { class: "btn small ghost", onclick: async () => {
                const enriched = await api("POST", `/api/people/${p.id}/enrich`, {});
                if (enriched.status === 200) dossierScreen(orgId);
                else msg.replaceChildren(errBox(enriched.body));
              } }, p.business_email ? "Re-verify email (est. 1+ credit)" : "Find email (est. 1+ credit)") : null))),
          el("fieldset", {}, el("legend", {}, "Manual decision-maker"),
            el("div", { class: "grid cols-2" },
              el("div", {}, el("label", {}, "Name"), manualPerson.name),
              el("div", {}, el("label", {}, "Title"), manualPerson.title),
              el("div", {}, el("label", {}, "Business email"), manualPerson.email),
              el("div", {}, el("label", {}, "Business phone"), manualPerson.phone)),
            el("label", {}, "Usable public contact profile"), manualPerson.source),
          el("div", { class: "btn-row" },
            el("button", { class: "btn small", onclick: async () => {
              const created = await api("POST", `/api/organizations/${orgId}/people/manual`, {
                full_name: manualPerson.name.value, title: manualPerson.title.value,
                business_email: manualPerson.email.value, business_phone: manualPerson.phone.value,
                public_profile_url: manualPerson.source.value, observed_at: new Date().toISOString().slice(0, 10),
              });
              if (created.status === 201) dossierScreen(orgId); else msg.replaceChildren(errBox(created.body));
            } }, "Save manual person"),
            providerPeopleSearch ? el("button", { class: "btn small ghost", onclick: async () => {
              const found = await api("POST", `/api/organizations/${orgId}/people`, { titles: ["owner", "founder", "marketing"], seniorities: ["owner", "founder", "c_suite", "director"] });
              msg.replaceChildren(found.status === 200
                ? el("p", { class: "ok" }, `People search: ${found.body.stored} new, ${found.body.updated} refreshed, ${found.body.suppressed} suppressed.`)
                : errBox(found.body));
              if (found.status === 200) dossierScreen(orgId);
            } }, "Find CEO/owner (est. 1 credit)") : el("span", { class: "muted small" }, "The current provider discovers company websites only; enter the verified decision-maker manually.")),
        ),
        el("div", { class: "card" },
          el("h2", {}, "Scores"),
          d.scores.length === 0 ? el("p", { class: "muted small" }, "Not scored yet.") : null,
          d.scores.slice(0, 4).map((s) => el("div", { class: "small" },
            pill(s.kind, "copper"), " ", scorePill(s, s.kind === "fit" ? 65 : 70),
            ` ${campaignName(s.campaign_id)} · v${s.rule_version} · ${s.scored_at.slice(0, 16)}`,
            s.disqualifiers.length ? el("div", { class: "err" }, `DQ: ${s.disqualifiers.map((q) => q.reason).join("; ")}`) : null)),
        )),

      el("div", { class: "card" },
        el("h2", {}, `Evidence ledger (${d.evidence.length})`),
        el("p", { class: "muted small" }, "Only accepted first-party or authoritative evidence can enter an outreach draft. Unknown stays unknown."),
        evidenceList,
        el("fieldset", {}, el("legend", {}, "Add evidence"),
          el("label", {}, "Claim"), ev.claim,
          el("div", { class: "grid cols-3" },
            el("div", {}, el("label", {}, "Source URL"), ev.url),
            el("div", {}, el("label", {}, "Observed"), ev.date),
            el("div", {}, el("label", {}, "Strength"), ev.strength)),
          el("label", {}, "Campaign"), ev.campaign,
          el("div", { class: "btn-row" }, [false, true].map((acceptNow) => el("button", { class: `btn small${acceptNow ? "" : " ghost"}`, onclick: async () => {
            await saveEvidence(acceptNow);
          } }, acceptNow ? "Save + accept" : "Save for review"))))),

      el("div", { class: "card" },
        el("h2", {}, "Pilot fact audit"),
        el("p", { class: "muted small" }, "An accurate audit requires all six checks, accepted strong evidence, one named and titled decision-maker with an allowed contact path, and no unresolved evidence. Person or evidence changes invalidate it."),
        latestAuditText,
        el("div", { class: "grid cols-2" }, el("div", {}, el("label", {}, "Campaign"), auditCampaign),
          el("div", {}, el("label", {}, "Verdict"), auditVerdict)),
        el("label", {}, "Audit notes"), auditNotes,
        el("div", { class: "audit-checks" }, Object.entries(auditCheckLabels).map(([name, label]) =>
          el("label", { class: "check-line small" }, auditChecks[name], el("span", {}, label)))),
        el("button", { class: "btn small", onclick: async () => {
          const audited = await api("POST", `/api/campaigns/${auditCampaign.value}/organizations/${orgId}/audit`, {
            verdict: auditVerdict.value, notes: auditNotes.value,
            checklist: Object.fromEntries(Object.entries(auditChecks).map(([name, input]) => [name, input.checked])),
          });
          if (audited.status === 201) dossierScreen(orgId); else msg.replaceChildren(errBox(audited.body));
        } }, "Record audit verdict")),

      el("div", { class: "card" },
        el("h2", {}, "Score against a campaign"),
        el("label", {}, "Campaign"), scoreCampaign,
        el("div", { class: "grid cols-3" },
          factorNames.map(([key, label]) => el("div", {}, el("label", {}, label), factorInputs[key]))),
        el("label", {}, "Hard disqualifier"), disqualifierInput,
        el("label", { class: "small" }, el("span", {}, "Contact path verified "), contactVerified),
        el("div", { class: "btn-row" }, el("button", { class: "btn small", onclick: async () => {
          const inputs = Object.fromEntries(factorNames.map(([key]) => [key, Number(factorInputs[key].value)]));
          const disqualifiers = disqualifierInput.value.trim()
            ? [{ rule: "operator", reason: disqualifierInput.value.trim() }] : [];
          const scored = await api("POST", `/api/campaigns/${scoreCampaign.value}/organizations/${orgId}/score`, {
            fit_inputs: inputs, disqualifiers, contact_verified: contactVerified.checked,
          });
          msg.replaceChildren(scored.status === 200
            ? el("p", { class: "ok" }, `Fit ${scored.body.fit.total} · Evidence ${scored.body.evidence.total} (${scored.body.rule_version})`)
            : errBox(scored.body));
          if (scored.status === 200) dossierScreen(orgId);
        } }, "Compute scores"))),

      el("div", { class: "card" },
        el("h2", {}, "Prior contact outside Reachwright"),
        el("p", { class: "muted small" }, "Use this when you already messaged the prospect in LinkedIn, email, DM, or phone. It records history only—it does not send—and permanently blocks a new initial draft for this business."),
        el("div", { class: "grid cols-3" },
          el("div", {}, el("label", {}, "Campaign"), externalCampaign),
          el("div", {}, el("label", {}, "Person"), externalPerson),
          el("div", {}, el("label", {}, "Channel"), externalChannel),
          el("div", {}, el("label", {}, "Contacted on"), externalDate)),
        el("label", {}, "Required note"), externalNotes,
        el("button", { class: "btn small ghost", onclick: async () => {
          if (!externalNotes.value.trim()) return msg.replaceChildren(errBox("A note is required for externally recorded contact."));
          const recorded = await api("POST", "/api/attempts/external", {
            campaign_id: externalCampaign.value, organization_id: orgId,
            person_id: externalPerson.value || undefined, channel: externalChannel.value,
            contacted_on: externalDate.value, notes: externalNotes.value,
          });
          if (recorded.status === 201) dossierScreen(orgId); else msg.replaceChildren(errBox(recorded.body));
        } }, "Record prior contact"),
        externalAttempts.length ? el("div", { class: "draft-card" },
          el("h3", {}, "External contact history"),
          externalAttempts.map((attempt) => el("p", { class: "small" },
            pill(attempt.status, attempt.status === "sent" ? "copper" : "good"),
            ` ${attempt.channel} · ${attempt.occurred_at.slice(0, 10)} · ${attempt.notes || "no note"}`)),
          !externalConversationClosed && externalAttempts.some((attempt) => attempt.status === "sent")
            ? (() => {
              const sent = externalAttempts.find((attempt) => attempt.status === "sent");
              const note = el("input", { type: "text", placeholder: "Outcome note (recommended)" });
              return el("div", {}, el("label", {}, "What happened after the external message?"), note,
                el("div", { class: "btn-row" }, ["replied", "positive-reply", "opted-out", "bounced", "closed"]
                  .map((status) => el("button", { class: `btn small ${status === "opted-out" ? "danger" : "ghost"}`, onclick: async () => {
                    const outcome = await api("POST", "/api/attempts", {
                      campaign_id: sent.campaign_id, organization_id: orgId, person_id: sent.person_id || undefined,
                      channel: sent.channel, direction: "inbound", status, notes: note.value,
                    });
                    if (outcome.status === 201) dossierScreen(orgId); else msg.replaceChildren(errBox(outcome.body));
                  } }, status.replaceAll("-", " ")))));
            })() : null) : null),

      el("div", { class: "card" },
        el("h2", {}, "Outreach draft"),
        el("p", { class: "muted small" }, "Drafting requires a current six-check audit plus current fit ≥65 and evidence ≥70 scores. The selected person must have the exact channel contact; drafts use accepted evidence only."),
        el("div", { class: "grid cols-3" },
          el("div", {}, el("label", {}, "Person"), personSelect),
          el("div", {}, el("label", {}, "Channel"), channelSelect),
          el("div", {}, el("label", {}, "Campaign"), draftCampaign),
          el("div", {}, el("label", {}, "Message kind"), outreachKind)),
        el("div", { class: "btn-row" }, el("button", { class: "btn small", onclick: async () => {
          const drafted = await api("POST", "/api/drafts", {
            campaign_id: draftCampaign.value, organization_id: orgId,
            person_id: personSelect.value || undefined, channel: channelSelect.value, outreach_kind: outreachKind.value,
          });
          msg.replaceChildren(drafted.status === 201
            ? el("div", {}, el("p", { class: "ok" }, "Draft created — review it in Approvals."), el("div", { class: "msg-box" }, drafted.body.body))
            : errBox(drafted.body));
        } }, "Generate draft")),
        d.drafts.length ? el("div", {}, el("h2", {}, "Existing drafts & outcomes"),
          d.drafts.map((draft) => {
            const statuses = draft.status === "exported" ? ["sent"]
              : draft.status === "sent" ? ["replied", "positive-reply", "opted-out", "bounced", "closed"] : [];
            const notes = el("input", { type: "text", placeholder: "Outcome note (recommended)" });
            return el("div", { class: "draft-card" },
              el("div", { class: "draft-card-head" },
                el("span", {}, pill(draft.status, draft.status === "approved" ? "good" : ""),
                  ` ${draft.outreach_kind || "initial"} · ${draft.channel}`),
                el("span", { class: "mono muted small" }, draft.content_hash.slice(0, 12))),
              el("div", { class: "msg-box compact" }, draft.body),
              statuses.length ? el("div", {}, el("label", {}, "What happened?"), notes,
                el("div", { class: "btn-row" }, statuses.map((status) =>
                  el("button", { class: `btn small ${status === "opted-out" ? "danger" : "ghost"}`, onclick: async () => {
                    const outcome = await api("POST", "/api/attempts", {
                      campaign_id: draft.campaign_id, organization_id: orgId, person_id: draft.person_id || undefined,
                      draft_id: draft.id, channel: draft.channel,
                      direction: status === "sent" ? "outbound" : "inbound", status, notes: notes.value,
                    });
                    if (outcome.status === 201) dossierScreen(orgId); else msg.replaceChildren(errBox(outcome.body));
                  } }, status.replaceAll("-", " ")))))
                : el("p", { class: "muted small" }, "No outcome action is due at this state."));
          })) : null),
    );
  }

  // -------------------------------------------------------------- approvals
  async function approvalsScreen() {
    const [draftsResult, approvedResult] = await Promise.all([
      api("GET", "/api/drafts?status=draft"), api("GET", "/api/drafts?status=approved"),
    ]);
    if (draftsResult.status !== 200) return setView(errBox(draftsResult.body));
    const msg = el("div");

    async function exportOne(draftId) {
      const exported = await api("POST", "/api/exports", { draft_ids: [draftId] });
      if (exported.status !== 200) return msg.replaceChildren(errBox(exported.body));
      if (exported.body.exported !== 1) {
        return msg.replaceChildren(errBox(exported.body.blocked[0]?.reason || "Export blocked."));
      }
      download(`reachwright-${draftId}.csv`, exported.body.csv);
      approvalsScreen();
    }

    function draftRow(draft, mode) {
      const actions = el("div", { class: "btn-row tight" },
        el("button", { class: "btn small ghost", onclick: () => openPacket(draft.id) }, mode === "approved" ? "Inspect" : "Open packet"),
        mode === "approved" ? el("button", { class: "btn small", onclick: () => exportOne(draft.id) }, "Export this one") : null);
      return el("tr", {},
        el("td", {}, draft.organization_name || draft.organization_id),
        el("td", {}, draft.person_name || "—"), el("td", {}, draft.campaign_name || draft.campaign_id),
        el("td", {}, draft.outreach_kind || "initial"), el("td", {}, draft.channel),
        el("td", {}, pill(draft.status, draft.status === "approved" ? "good" : "")),
        el("td", { class: "small muted" }, draft.updated_at.slice(0, 16)),
        el("td", {}, actions));
    }

    async function openPacket(draftId) {
      const packetResult = await api("GET", `/api/drafts/${draftId}/packet`);
      if (packetResult.status !== 200) return msg.replaceChildren(errBox(packetResult.body));
      const { packet, packet_hash } = packetResult.body;
      const contactedElsewhere = el("select", {},
        el("option", { value: "no" }, "No — first contact from Reachwright"),
        el("option", { value: "yes" }, "Yes — I have contacted them elsewhere"));
      const editArea = el("textarea", { style: "min-height:140px" });
      editArea.value = packet.exact_message;
      const reason = el("input", { type: "text", placeholder: "approval/rejection note (optional for approve)" });
      const dialogMsg = el("div");

      const dialog = el("dialog", {},
        el("h2", {}, "Approval packet"),
        el("p", { class: "small" },
          el("strong", {}, packet.recipient?.name || "(no specific person)"), packet.recipient?.title ? ` — ${packet.recipient.title}` : "",
          el("br"), `${packet.company?.name ?? ""} · ${packet.company?.domain ?? "no domain"} · ${packet.company?.location ?? ""}`,
          el("br"), `Channel: ${packet.channel} · exact contact: ${packet.contact_for_channel || "—"}`),
        packet.suppression.suppressed ? el("p", { class: "err" }, `SUPPRESSED: ${packet.suppression.matches.map((m) => `${m.key_type}=${m.key_value}`).join(", ")} — approval will be refused.`) : el("p", { class: "ok" }, "Suppression: clear"),
        el("p", { class: "small muted" }, `Prior outbound contacts to this company: ${packet.prior_contact_count}`),
        el("h2", {}, "Exact message"),
        el("div", { class: "msg-box" }, packet.exact_message),
        el("h2", {}, "Evidence used"),
        packet.evidence_used.map((item) => el("div", { class: "evidence-item" }, item.claim,
          el("div", { class: "mono muted small" }, `${item.strength} · ${item.observed_at} · ${item.source_url}`))),
        el("label", {}, packet.confirm_question), contactedElsewhere,
        el("label", {}, "Note"), reason,
        el("div", { class: "btn-row" },
          el("button", { class: "btn", onclick: async () => {
            const approved = await api("POST", `/api/drafts/${draftId}/approve`, {
              packet_hash, contacted_elsewhere: contactedElsewhere.value, reason: reason.value || "",
            });
            if (approved.status === 200) { dialog.close(); dialog.remove(); approvalsScreen(); }
            else dialogMsg.replaceChildren(errBox(approved.body));
          } }, "Approve this exact message"),
          el("button", { class: "btn danger", onclick: async () => {
            const rejected = await api("POST", `/api/drafts/${draftId}/reject`, { reason: reason.value || "rejected" });
            if (rejected.status === 200) { dialog.close(); dialog.remove(); approvalsScreen(); }
            else dialogMsg.replaceChildren(errBox(rejected.body));
          } }, "Kill draft"),
          el("button", { class: "btn ghost", onclick: () => { dialog.close(); dialog.remove(); } }, "Close")),
        el("h2", {}, "Edit (any edit voids approval and re-enters draft)"),
        editArea,
        el("div", { class: "btn-row" }, el("button", { class: "btn small ghost", onclick: async () => {
          const edited = await api("PATCH", `/api/drafts/${draftId}`, { body: editArea.value });
          if (edited.status === 200) { dialog.close(); dialog.remove(); approvalsScreen(); }
          else dialogMsg.replaceChildren(errBox(edited.body));
        } }, "Save edit → back to draft")),
        dialogMsg,
      );
      document.body.append(dialog);
      dialog.showModal();
    }

    setView(
      el("h1", {}, "Approvals"),
      el("p", { class: "sub" }, "Approval binds to the exact packet shown. Pilot exports are deliberately one message at a time; sending is always a human act, and email stays blocked until the CAN-SPAM gate passes."),
      msg,
      el("h2", {}, "Waiting for review"),
      el("div", { class: "card table-wrap" }, el("table", {},
        el("thead", {}, el("tr", {}, ["Organization", "Person", "Campaign", "Kind", "Channel", "Status", "Updated", "Action"].map((h) => el("th", {}, h)))),
        el("tbody", {}, draftsResult.body.drafts.length ? draftsResult.body.drafts.map((d) => draftRow(d, "draft"))
          : el("tr", {}, el("td", { colspan: "8", class: "muted" }, "Nothing waiting."))))),
      el("h2", {}, "Approved — ready to export"),
      el("div", { class: "card table-wrap" },
        el("table", {},
          el("thead", {}, el("tr", {}, ["Organization", "Person", "Campaign", "Kind", "Channel", "Status", "Updated", "Action"].map((h) => el("th", {}, h)))),
          el("tbody", {}, approvedResult.body.drafts.length ? approvedResult.body.drafts.map((d) => draftRow(d, "approved"))
            : el("tr", {}, el("td", { colspan: "8", class: "muted" }, "None approved."))))),
    );
  }

  // ---------------------------------------------------------------- qualify
  const FLOW_TEMPLATE = {
    questions: [
      { id: "q1", field: "example", prompt: "First approved question?",
        options: [{ value: "a", label: "Answer A" }, { value: "b", label: "Answer B" }] },
    ],
    rules: {
      disqualifiers: [{ when: { field: "example", in: ["b"] }, reason: "example disqualifier" }],
      humanReview: [], scoring: [{ when: { field: "example", in: ["a"] }, points: 6 }],
      strongAt: 6, maybeAt: 3,
    },
    verdictCopy: { strong: "Strong fit.", maybe: "Maybe.", no: "Not a fit.", "human-review": "A human will review." },
    route: { strong: "booking", maybe: "human", no: "none", "human-review": "human" },
  };

  async function qualifyScreen() {
    const flows = await api("GET", "/api/qualify/flows");
    if (flows.status !== 200) return setView(errBox(flows.body));
    const active = await api("GET", "/api/qualify/flows/active");
    const msg = el("div");
    const nameInput = el("input", { type: "text", placeholder: "flow name, e.g. roofing-inbound" });
    const defArea = el("textarea", { style: "min-height:220px" });
    defArea.value = JSON.stringify(FLOW_TEMPLATE, null, 2);

    const previewWrap = el("div");
    async function buildPreview(flowId) {
      const flow = await api("GET", `/api/qualify/flows/${flowId}`);
      if (flow.status !== 200) return previewWrap.replaceChildren(errBox(flow.body));
      const definition = flow.body.flow.definition;
      const selects = definition.questions.map((q) => ({
        field: q.field,
        select: el("select", {}, el("option", { value: "unknown" }, "— unknown —"),
          q.options.map((opt) => el("option", { value: opt.value }, opt.label))),
        prompt: q.prompt,
      }));
      const verdictBox = el("div");
      previewWrap.replaceChildren(el("div", { class: "card" },
        el("h2", {}, `Preview: ${flow.body.flow.name} v${flow.body.flow.version}`),
        selects.map((s) => el("div", {}, el("label", {}, s.prompt), s.select)),
        el("div", { class: "btn-row" }, el("button", { class: "btn small", onclick: async () => {
          const answers = Object.fromEntries(selects.map((s) => [s.field, s.select.value]));
          const preview = await api("POST", "/api/qualify/preview", { flow_id: flowId, answers });
          verdictBox.replaceChildren(preview.status === 200
            ? el("div", { class: "msg-box" }, JSON.stringify(preview.body.decision, null, 2))
            : errBox(preview.body));
        } }, "Evaluate deterministically")),
        verdictBox));
    }

    setView(
      el("h1", {}, "Qualify — flow builder"),
      el("p", { class: "sub" }, "Verdicts are computed server-side from these rules. The AI never chooses a verdict; it may only phrase one bounded sentence, and every failure falls back to your scripted copy."),
      active.body?.flow
        ? el("p", { class: "ok" }, `Active flow: ${active.body.flow.name} v${active.body.flow.version}`)
        : el("p", { class: "muted small" }, "No operator flow active — the public worker uses its built-in interview."),
      msg,
      el("div", { class: "card table-wrap" }, el("table", {},
        el("thead", {}, el("tr", {}, ["Name", "Version", "Status", "Updated", "", ""].map((h) => el("th", {}, h)))),
        el("tbody", {}, flows.body.flows.length ? flows.body.flows.map((f) => el("tr", {},
          el("td", {}, f.name), el("td", { class: "mono" }, `v${f.version}`),
          el("td", {}, pill(f.status, f.status === "active" ? "good" : "")),
          el("td", { class: "small muted" }, f.updated_at.slice(0, 16)),
          el("td", {}, el("button", { class: "btn small ghost", onclick: async () => {
            const activated = await api("POST", `/api/qualify/flows/${f.id}/activate`, {});
            msg.replaceChildren(activated.status === 200 ? el("p", { class: "ok" }, "Activated.") : errBox(activated.body));
            qualifyScreen();
          } }, "Activate")),
          el("td", {}, el("button", { class: "btn small ghost", onclick: () => buildPreview(f.id) }, "Preview")),
        )) : el("tr", {}, el("td", { colspan: "6", class: "muted" }, "No flows authored yet."))))),
      previewWrap,
      el("div", { class: "card" },
        el("h2", {}, "New flow version"),
        el("label", {}, "Name"), nameInput,
        el("label", {}, "Definition (JSON — validated on save)"), defArea,
        el("div", { class: "btn-row" }, el("button", { class: "btn", onclick: async () => {
          let definition;
          try { definition = JSON.parse(defArea.value); } catch { return msg.replaceChildren(errBox("Definition is not valid JSON.")); }
          const created = await api("POST", "/api/qualify/flows", { name: nameInput.value, definition });
          msg.replaceChildren(created.status === 201 ? el("p", { class: "ok" }, `Saved ${nameInput.value} v${created.body.version}.`) : errBox(created.body));
          if (created.status === 201) qualifyScreen();
        } }, "Save as new version"))),
    );
  }

  // ------------------------------------------------------------- suppression
  async function suppressionScreen() {
    const result = await api("GET", "/api/suppression");
    if (result.status !== 200) return setView(errBox(result.body));
    const msg = el("div");
    const typeSelect = el("select", {}, ["email", "domain", "phone", "handle", "org", "alias"].map((t) => el("option", { value: t }, t)));
    const valueInput = el("input", { type: "text", placeholder: "value (normalized automatically)" });
    const reasonInput = el("input", { type: "text", placeholder: "reason" });
    setView(
      el("h1", {}, "Suppression list"),
      el("p", { class: "sub" }, "Checked before research expands, before approval, and again at export. An opt-out anywhere suppresses every channel."),
      msg,
      el("div", { class: "card" },
        el("div", { class: "grid cols-3" },
          el("div", {}, el("label", {}, "Key type"), typeSelect),
          el("div", {}, el("label", {}, "Value"), valueInput),
          el("div", {}, el("label", {}, "Reason"), reasonInput)),
        el("div", { class: "btn-row" }, el("button", { class: "btn small", onclick: async () => {
          const added = await api("POST", "/api/suppression", { key_type: typeSelect.value, key_value: valueInput.value, reason: reasonInput.value });
          msg.replaceChildren(added.status === 201 ? el("p", { class: "ok" }, `Suppressed ${added.body.key_type}:${added.body.key_value}`) : errBox(added.body));
          if (added.status === 201) suppressionScreen();
        } }, "Add entry"))),
      el("div", { class: "card table-wrap" }, el("table", {},
        el("thead", {}, el("tr", {}, ["Type", "Value", "Reason", "Channel", "Added"].map((h) => el("th", {}, h)))),
        el("tbody", {}, result.body.entries.length ? result.body.entries.map((entry) => el("tr", {},
          el("td", {}, pill(entry.key_type)), el("td", { class: "mono" }, entry.key_value),
          el("td", { class: "small" }, entry.reason), el("td", { class: "small muted" }, entry.source_channel || "—"),
          el("td", { class: "small muted" }, entry.created_at.slice(0, 16))))
          : el("tr", {}, el("td", { colspan: "5", class: "muted" }, "Empty."))))),
    );
  }

  // ---------------------------------------------------------------- reports
  async function reportsScreen(campaignId) {
    const [clientsResult, campaignsResult, auditResult] = await Promise.all([
      api("GET", "/api/clients"), api("GET", "/api/campaigns"), api("GET", "/api/audit"),
    ]);
    if (clientsResult.status !== 200) return setView(errBox(clientsResult.body));
    if (campaignsResult.status !== 200) return setView(errBox(campaignsResult.body));
    const clients = clientsResult.body.clients;
    const campaigns = campaignsResult.body.campaigns;
    const routedCampaign = campaigns.find((campaign) => campaign.id === campaignId);
    const clientSelect = el("select", {}, clients.map((client) =>
      el("option", { value: client.id, selected: client.id === routedCampaign?.client_id ? "" : undefined }, client.name)));
    if (!routedCampaign && clients[0]) clientSelect.value = clients[0].id;
    const campaignSelect = el("select");
    const body = el("div");

    function fillCampaigns(selectedId = "") {
      const matches = campaigns.filter((campaign) => campaign.client_id === clientSelect.value);
      campaignSelect.replaceChildren(el("option", { value: "" }, "All client campaigns"),
        ...matches.map((campaign) => el("option", { value: campaign.id }, campaign.name)));
      campaignSelect.value = matches.some((campaign) => campaign.id === selectedId) ? selectedId : "";
    }
    fillCampaigns(campaignId);

    const stat = (label, value) => el("div", { class: "stat" },
      el("div", { class: "n" }, String(value ?? "—")), el("div", { class: "l" }, label));
    const showRate = (value) => value === null || value === undefined ? "—" : percent(value);
    function cohortTable(title, rows) {
      return [el("h3", { class: "cohort-title" }, title),
        el("div", { class: "card table-wrap" }, el("table", {},
          el("thead", {}, el("tr", {}, ["Cohort", "Ready", "Selected", "Sent", "Replies", "Held", "Sales", "Reply rate", "Confidence"].map((head) => el("th", {}, head)))),
          el("tbody", {}, rows.length ? rows.map((row) => el("tr", {},
            el("td", {}, row.label), el("td", {}, `${row.message_ready}/${row.candidates}`),
            el("td", {}, String(row.messages_selected)), el("td", {}, String(row.sent)),
            el("td", {}, String(row.replies)), el("td", {}, String(row.held)),
            el("td", {}, String(row.sales)), el("td", {}, showRate(row.reply_rate)),
            el("td", {}, row.low_sample ? pill("low sample", "warn") : pill("directional", "good"))))
            : el("tr", {}, el("td", { colspan: "9", class: "muted" }, "No attributed outcomes yet.")))))];
    }

    async function renderReport() {
      body.replaceChildren(el("p", { class: "muted" }, "Calculating source-of-truth performance…"));
      const path = campaignSelect.value
        ? `/api/reports/campaigns/${campaignSelect.value}`
        : `/api/reports/clients/${clientSelect.value}`;
      const report = await api("GET", path);
      if (report.status !== 200) return body.replaceChildren(errBox(report.body));
      const r = report.body;
      const p = r.generation_performance;
      const feedback = r.feedback;
      const scopeName = r.campaign_name || r.client?.name || "Selected scope";
      const generationFunnel = [
        ["Candidates considered", p.candidates_discovered], ["Official sites researched", p.candidates_researched],
        ["Contactable", p.contactable_prospects], ["Message-ready", p.message_ready_prospects],
        ["Candidate → ready", showRate(p.candidate_to_ready_yield)], ["Est. provider credits", p.provider_credits_estimated],
      ];
      const outcomes = [
        ["Message options prepared", p.message_options_prepared], ["Messages selected", p.messages_selected],
        ["Manual sends recorded", p.messages_sent], ["Replies", p.replies],
        ["Booked now", p.bookings_booked], ["Held calls", p.calls_held],
        ["Operator-confirmed sales", p.operator_confirmed_sales], ["Reply rate", showRate(p.reply_rate)],
      ];
      const children = [
        el("div", { class: "results-heading" }, el("p", { class: "eyebrow" }, campaignSelect.value ? "Campaign performance" : "Client performance"),
          el("h2", {}, scopeName), el("p", { class: "small muted" }, "Estimated credits are not dollars. Booked, held, and paid remain independent facts.")),
        el("h3", { class: "results-section-title" }, "Generation yield"),
        el("div", { class: "grid cols-3 results-funnel" }, generationFunnel.map(([label, value]) => stat(label, value))),
        p.research_failures ? el("p", { class: "small err" }, `${p.research_failures} candidate(s) encountered a recorded research failure; retries remain visible.`) : null,
        el("h3", { class: "results-section-title" }, "From prepared message to sale"),
        el("div", { class: "grid cols-3 outcome-grid" }, outcomes.map(([label, value]) => stat(label, value))),
        el("h2", {}, "What is performing"),
        el("p", { class: "small muted" }, feedback.interpretation),
        ...cohortTable("Opportunity signals", feedback.by_signal),
        ...cohortTable("Focused services", feedback.by_service),
        ...cohortTable("Selected message strategies", feedback.by_strategy),
      ];
      if (r.markets) {
        children.push(el("h2", {}, "Campaign markets"),
          el("div", { class: "card table-wrap" }, el("table", {},
            el("thead", {}, el("tr", {}, ["Campaign", "Market", "Status", "Candidates", "Ready", "Yield", "Sales"].map((head) => el("th", {}, head)))),
            el("tbody", {}, r.markets.length ? r.markets.map((market) => el("tr", { class: "clickable", onclick: () => { location.hash = `#/reports/${market.id}`; } },
              el("td", {}, market.name), el("td", {}, market.geography), el("td", {}, pill(market.status)),
              el("td", {}, String(market.generation_performance.candidates_discovered)),
              el("td", {}, String(market.generation_performance.message_ready_prospects)),
              el("td", {}, showRate(market.generation_performance.candidate_to_ready_yield)),
              el("td", {}, String(market.generation_performance.operator_confirmed_sales))))
              : el("tr", {}, el("td", { colspan: "7", class: "muted" }, "No campaigns for this client."))))));
      }
      if (campaignSelect.value) {
        const legacyRows = [["Stored candidates", r.candidates], ["Rule-ready dossiers", r.rule_ready_dossiers],
          ["Duplicates merged", r.duplicates_merged], ["Dossiers scored", r.dossiers_scored],
          ["Audited accurate", r.dossiers_audited_accurate], ["Audited partly", r.dossiers_audited_partly],
          ["Dossiers rejected", r.dossiers_rejected], ["Opt-outs", r.opt_outs]];
        children.push(el("details", { class: "advanced" }, el("summary", {}, "Legacy dossier and provider audit detail"),
          el("div", { class: "grid cols-3" }, legacyRows.map(([label, value]) => stat(label, value))),
          el("div", { class: "card table-wrap" }, el("table", {},
            el("thead", {}, el("tr", {}, ["Provider", "Operation", "Requests", "Est. credits"].map((head) => el("th", {}, head)))),
            el("tbody", {}, r.provider_usage.length ? r.provider_usage.map((usage) => el("tr", {},
              el("td", {}, usage.provider), el("td", { class: "mono" }, usage.operation),
              el("td", {}, String(usage.requests)), el("td", {}, String(usage.credits))))
              : el("tr", {}, el("td", { colspan: "4", class: "muted" }, "No provider usage.")))))));
      }
      body.replaceChildren(...children);
    }

    clientSelect.addEventListener("change", () => { fillCampaigns(); renderReport(); });
    campaignSelect.addEventListener("change", () => {
      if (campaignSelect.value) location.hash = `#/reports/${campaignSelect.value}`;
      else renderReport();
    });

    setView(
      el("h1", {}, "Generation results"),
      el("p", { class: "sub" }, "Yield, cost, and outcomes from candidate discovery through operator-confirmed sales. Candidates are never called leads; booked is never called held."),
      el("div", { class: "card report-scope" },
        el("div", {}, el("label", {}, "Client"), clientSelect),
        el("div", {}, el("label", {}, "Campaign"), campaignSelect)),
      body,
      el("h2", {}, "Audit trail (latest 100)"),
      el("div", { class: "card table-wrap" }, el("table", {},
        el("thead", {}, el("tr", {}, ["When", "Action", "Subject", "Detail"].map((h) => el("th", {}, h)))),
        el("tbody", {}, (auditResult.body?.events ?? []).map((event) => el("tr", {},
          el("td", { class: "small muted mono" }, event.created_at.slice(0, 19)),
          el("td", { class: "mono small" }, event.action),
          el("td", { class: "mono small" }, `${event.subject_type}:${String(event.subject_id).slice(0, 16)}`),
          el("td", { class: "small muted" }, event.detail)))))),
    );
    await renderReport();
  }

  // ------------------------------------------------------------------ router
  async function route() {
    if (!state.token) return loginScreen();
    nav.hidden = false;
    await refreshBanner();
    const hash = location.hash || "#/today";
    for (const link of nav.querySelectorAll("a")) {
      link.classList.toggle("active", hash.startsWith(link.getAttribute("href")));
    }
    const [, screen, arg, detail] = hash.slice(1).split("/");
    try {
      if (screen === "today") return await todayScreen();
      if (screen === "market") return await marketScreen();
      if (screen === "generate" && arg) return await generationRunScreen(arg);
      if (screen === "generate") return await generationScreen();
      if (screen === "review" && arg && detail) return await prospectReviewScreen(arg, detail);
      if (screen === "review") return await reviewScreen(arg);
      if (screen === "revenue") return await revenueScreen();
      if (screen === "sales" && arg) return await salesCallScreen(arg);
      if (screen === "sales") return await salesScreen();
      if (screen === "campaigns" && arg) return await campaignScreen(arg);
      if (screen === "campaigns") return await campaignsScreen();
      if (screen === "dossier" && arg) return await dossierScreen(arg);
      if (screen === "approvals") return await approvalsScreen();
      if (screen === "qualify") return await qualifyScreen();
      if (screen === "suppression") return await suppressionScreen();
      if (screen === "reports") return await reportsScreen(arg);
      if (screen === "clients") return await clientsScreen();
      if (screen === "settings") return await settingsScreen();
      if (screen === "dashboard") return await dashboardScreen();
      return await todayScreen();
    } catch (cause) {
      setView(errBox(`Screen failed to load: ${cause?.message ?? "unknown"}`));
    }
  }

  window.addEventListener("hashchange", route);
  route();
})();
