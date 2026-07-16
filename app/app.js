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
    const response = await fetch(state.base + path, {
      method,
      headers: {
        authorization: `Bearer ${state.token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
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

  function setView(...nodes) { view.replaceChildren(...nodes); }
  function pill(text, kind = "") { return el("span", { class: `pill ${kind}` }, text); }
  function scorePill(score) {
    if (!score) return pill("unscored");
    const total = Number.isInteger(score.override_total) ? score.override_total : score.total;
    const kind = total >= 70 ? "good" : total >= 40 ? "warn" : "bad";
    return pill(`${total}${Number.isInteger(score.override_total) ? "*" : ""}`, kind);
  }
  function errBox(detail) {
    return el("p", { class: "err" }, typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
  }
  function download(filename, text) {
    const a = el("a", { href: URL.createObjectURL(new Blob([text], { type: "text/csv" })), download: filename });
    document.body.append(a); a.click(); a.remove();
  }

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
    if (!provider.configured) {
      banner.className = "banner warn";
      banner.textContent = "Provider not configured — Scout search is disabled. Add an Apollo API key to the worker secrets to enable live research. Nothing in this console fakes data.";
    } else if (provider.mode === "test-fixtures-only") {
      banner.className = "banner warn";
      banner.textContent = "DEV FIXTURES MODE — records marked [FIXTURE] are fake and for testing only. Never treat them as prospects.";
    } else {
      banner.className = "banner good";
      banner.textContent = `Provider: ${provider.provider} (live). Email exports: ${health.body.email_gate_passed ? "enabled" : "BLOCKED until the CAN-SPAM gate passes"}.`;
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
            location.hash = "#/dashboard";
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

  // -------------------------------------------------------------- dashboard
  async function dashboardScreen() {
    const result = await api("GET", "/api/dashboard");
    if (result.status !== 200) return setView(errBox(result.body));
    const d = result.body;
    const tiles = [
      ["Active campaigns", d.campaigns_active], ["Candidates found", d.candidates_found],
      ["Dossiers w/ accepted evidence", d.dossiers_with_accepted_evidence],
      ["Approvals waiting", d.approvals_waiting], ["Outreach prepared", d.outreach_prepared],
      ["Replies", d.replies], ["Qualified conversations", d.qualified_conversations],
      ["Booked", d.bookings_booked], ["Held calls", d.calls_held], ["Opt-outs", d.opt_outs],
    ];
    setView(
      el("h1", {}, "Dashboard"),
      el("p", { class: "sub" }, "Candidates are not leads until they pass a campaign's thresholds. Booked is not held."),
      el("div", { class: "grid cols-5" },
        tiles.map(([label, n]) => el("div", { class: "stat" }, el("div", { class: "n" }, String(n ?? 0)), el("div", { class: "l" }, label)))),
    );
  }

  // -------------------------------------------------------------- campaigns
  async function campaignsScreen() {
    const result = await api("GET", "/api/campaigns");
    if (result.status !== 200) return setView(errBox(result.body));
    const rows = result.body.campaigns.map((c) => el("tr", { class: "clickable", onclick: () => { location.hash = `#/campaigns/${c.id}`; } },
      el("td", {}, c.name), el("td", {}, pill(c.status, c.status === "researching" ? "good" : "")),
      el("td", {}, c.brief_complete ? pill("complete", "good") : pill("incomplete", "bad")),
      el("td", {}, c.geography), el("td", { class: "mono" }, String(c.max_batch_size)),
    ));

    const f = {};
    const field = (key, label, input) => { f[key] = input; return [el("label", {}, label), input]; };
    const msg = el("div");
    const form = el("div", { class: "card" },
      el("h2", {}, "New campaign brief"),
      el("p", { class: "muted small" }, "Playbook rule: items 1–5 are mandatory. An incomplete brief cannot research."),
      el("div", { class: "grid cols-2" },
        el("div", {},
          field("name", "Campaign name", el("input", { type: "text" })),
          field("owner", "Owner", el("input", { type: "text", value: "michael" })),
          field("offer", "Offer + credible proof available today", el("textarea")),
          field("icp", "Ideal customer profile", el("textarea")),
          field("geography", "Geography", el("input", { type: "text" })),
        ),
        el("div", {},
          field("min_economics", "Minimum customer economics", el("input", { type: "text" })),
          field("positive_signals", "Positive signals (one per line)", el("textarea")),
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
            disqualifiers: f.disqualifiers.value.split("\n").map((s) => s.trim()).filter(Boolean),
            max_batch_size: Number(f.max_batch_size.value), allowed_channels: channels,
          };
          const created = await api("POST", "/api/campaigns", body);
          msg.replaceChildren(created.status === 201 ? el("p", { class: "ok" }, "Campaign created.") : errBox(created.body));
          if (created.status === 201) campaignsScreen();
        } }, "Create campaign")),
      msg,
    );

    setView(
      el("h1", {}, "Campaigns"),
      el("div", { class: "card table-wrap" }, el("table", {},
        el("thead", {}, el("tr", {}, ["Name", "Status", "Brief", "Geography", "Batch cap"].map((h) => el("th", {}, h)))),
        el("tbody", {}, rows.length ? rows : el("tr", {}, el("td", { colspan: "5", class: "muted" }, "No campaigns yet."))))),
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

    const searchParams = () => ({
      locations: locations.value.split(",").map((s) => s.trim()).filter(Boolean),
      keywords: keywords.value.split(",").map((s) => s.trim()).filter(Boolean),
      batch: Number(batch.value),
    });

    const queueWrap = el("div", { class: "card table-wrap" }, el("p", { class: "muted" }, "Loading queue…"));
    async function loadQueue() {
      const queue = await api("GET", `/api/campaigns/${id}/queue`);
      if (queue.status !== 200) return queueWrap.replaceChildren(errBox(queue.body));
      const rows = queue.body.queue.map((entry) => el("tr", { class: "clickable", onclick: () => { location.hash = `#/dossier/${entry.organization.id}`; } },
        el("td", {}, entry.organization.display_name, el("div", { class: "mono muted" }, entry.organization.normalized_domain || "no domain")),
        el("td", {}, scorePill(entry.fit)), el("td", {}, scorePill(entry.evidence_score)),
        el("td", {}, entry.evidence_freshness_days === null ? pill("never verified", "bad")
          : entry.stale ? pill(`${entry.evidence_freshness_days}d — stale`, "warn") : pill(`${entry.evidence_freshness_days}d`, "good")),
        el("td", {}, pill(entry.duplicate_state, entry.duplicate_state === "active" ? "" : "warn")),
        el("td", {}, entry.suppression.suppressed ? pill("SUPPRESSED", "bad") : pill("clear", "good")),
        el("td", { class: "small muted" }, entry.unknown_fields.join(", ") || "—"),
      ));
      queueWrap.replaceChildren(el("table", {},
        el("thead", {}, el("tr", {}, ["Organization", "Fit", "Evidence", "Freshness", "Dup state", "Suppression", "Unknown"].map((h) => el("th", {}, h)))),
        el("tbody", {}, rows.length ? rows : el("tr", {}, el("td", { colspan: "7", class: "muted" }, "Queue is empty — run a search or add evidence.")))));
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
      el("div", { class: "card" },
        el("h2", {}, "Provider search"),
        el("div", { class: "grid cols-3" },
          el("div", {}, el("label", {}, "Locations"), locations),
          el("div", {}, el("label", {}, "Keywords"), keywords),
          el("div", {}, el("label", {}, `Batch (cap ${c.max_batch_size})`), batch)),
        el("div", { class: "btn-row" },
          el("button", { class: "btn ghost", onclick: async () => {
            const preview = await api("POST", `/api/campaigns/${id}/preview-search`, searchParams());
            msg.replaceChildren(preview.status === 200
              ? el("p", { class: "ok" }, `Estimated ≤ ${preview.body.estimate.estimated} credits (${preview.body.estimate.basis}). Ceiling remaining: ${preview.body.credit_ceiling_remaining ?? "∞"}.${preview.body.would_exceed_ceiling ? " WOULD EXCEED CEILING." : ""}`)
              : errBox(preview.body));
          } }, "Preview credits"),
          el("button", { class: "btn", onclick: async () => {
            msg.replaceChildren(el("p", { class: "muted" }, "Searching…"));
            const search = await api("POST", `/api/campaigns/${id}/search`, searchParams());
            msg.replaceChildren(search.status === 200
              ? el("p", { class: "ok" }, `Stored ${search.body.summary.stored}, merged ${search.body.summary.merged} duplicates, ${search.body.summary.suppressed} suppressed, ${search.body.summary.skipped} skipped.`)
              : errBox(search.body));
            loadQueue();
          } }, "Run search"))),
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
    const campaigns = (await api("GET", "/api/campaigns")).body?.campaigns ?? [];
    const msg = el("div");

    const evidenceList = d.evidence.map((item) => el("div", { class: "evidence-item" },
      el("div", {}, item.claim),
      el("div", { class: "mono muted small" }, `${item.strength} · observed ${item.observed_at} · ${item.source_url}`),
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
      campaign: el("select", {}, campaigns.map((c) => el("option", { value: c.id }, c.name))),
    };

    // scoring form
    const factorNames = [["offer_match", "Offer match"], ["timing_signal", "Timing signal"], ["geography", "Geography"],
      ["economics", "Economics"], ["capacity_growth", "Capacity/growth"], ["reachable", "Reachable"]];
    const factorInputs = Object.fromEntries(factorNames.map(([key]) => [key,
      el("select", {}, [["0", "0 — no"], ["0.5", "0.5 — partial"], ["1", "1 — yes"]].map(([v, l]) => el("option", { value: v }, l)))]));
    const disqualifierInput = el("input", { type: "text", placeholder: "hard disqualifier reason (leave empty if none)" });
    const contactVerified = el("input", { type: "checkbox" });

    // draft form
    const personSelect = el("select", {},
      el("option", { value: "" }, "— no specific person —"),
      d.people.map((p) => el("option", { value: p.id }, `${p.full_name} (${p.title || "?"})${p.do_not_contact ? " — DO NOT CONTACT" : ""}`)));
    const channelSelect = el("select", {}, ["linkedin-manual", "dm", "email", "phone"].map((c) => el("option", { value: c }, c)));
    const draftCampaign = el("select", {}, campaigns.map((c) => el("option", { value: c.id }, c.name)));

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
          d.people.map((p) => el("p", { class: "small" },
            `${p.full_name} — ${p.title || "?"} `,
            p.business_email ? el("span", { class: "mono" }, `· ${p.business_email} (${p.email_status})`) : " · no email",
            p.do_not_contact ? pill("do-not-contact", "bad") : null)),
          el("div", { class: "btn-row" },
            el("button", { class: "btn small ghost", onclick: async () => {
              const found = await api("POST", `/api/organizations/${orgId}/people`, { titles: ["owner", "founder", "marketing"], seniorities: ["owner", "founder", "c_suite", "director"] });
              msg.replaceChildren(found.status === 200 ? el("p", { class: "ok" }, `Stored ${found.body.count} people.`) : errBox(found.body));
              if (found.status === 200) dossierScreen(orgId);
            } }, "Find decision-makers")),
        ),
        el("div", { class: "card" },
          el("h2", {}, "Scores"),
          d.scores.length === 0 ? el("p", { class: "muted small" }, "Not scored yet.") : null,
          d.scores.slice(0, 4).map((s) => el("div", { class: "small" },
            pill(s.kind, "copper"), " ", scorePill(s), ` v${s.rule_version} · ${s.scored_at.slice(0, 16)}`,
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
          el("div", { class: "btn-row" }, el("button", { class: "btn small", onclick: async () => {
            const added = await api("POST", `/api/organizations/${orgId}/evidence`, {
              claim: ev.claim.value, source_url: ev.url.value, observed_at: ev.date.value,
              strength: ev.strength.value, campaign_id: ev.campaign.value || undefined,
            });
            if (added.status === 201) dossierScreen(orgId); else msg.replaceChildren(errBox(added.body));
          } }, "Add evidence")))),

      el("div", { class: "card" },
        el("h2", {}, "Score against a campaign"),
        el("label", {}, "Campaign"), draftCampaign.cloneNode(true) && draftCampaign, // single select reused below intentionally? no — separate
        el("div", { class: "grid cols-3" },
          factorNames.map(([key, label]) => el("div", {}, el("label", {}, label), factorInputs[key]))),
        el("label", {}, "Hard disqualifier"), disqualifierInput,
        el("label", { class: "small" }, el("span", {}, "Contact path verified "), contactVerified),
        el("div", { class: "btn-row" }, el("button", { class: "btn small", onclick: async () => {
          const inputs = Object.fromEntries(factorNames.map(([key]) => [key, Number(factorInputs[key].value)]));
          const disqualifiers = disqualifierInput.value.trim()
            ? [{ rule: "operator", reason: disqualifierInput.value.trim() }] : [];
          const scored = await api("POST", `/api/campaigns/${draftCampaign.value}/organizations/${orgId}/score`, {
            fit_inputs: inputs, disqualifiers, contact_verified: contactVerified.checked,
          });
          msg.replaceChildren(scored.status === 200
            ? el("p", { class: "ok" }, `Fit ${scored.body.fit.total} · Evidence ${scored.body.evidence.total} (${scored.body.rule_version})`)
            : errBox(scored.body));
          if (scored.status === 200) dossierScreen(orgId);
        } }, "Compute scores"))),

      el("div", { class: "card" },
        el("h2", {}, "Outreach draft"),
        el("p", { class: "muted small" }, "Drafts assemble ONLY from accepted evidence. Insufficient evidence returns exactly that — no filler. Approval happens in the Approvals queue."),
        el("div", { class: "grid cols-3" },
          el("div", {}, el("label", {}, "Person"), personSelect),
          el("div", {}, el("label", {}, "Channel"), channelSelect),
          el("div", {}, el("label", {}, "Campaign"), (() => { const s = draftCampaign.cloneNode(true); s.id = "draft-campaign"; return s; })())),
        el("div", { class: "btn-row" }, el("button", { class: "btn small", onclick: async () => {
          const campaignSel = document.getElementById("draft-campaign");
          const drafted = await api("POST", "/api/drafts", {
            campaign_id: campaignSel.value, organization_id: orgId,
            person_id: personSelect.value || undefined, channel: channelSelect.value,
          });
          msg.replaceChildren(drafted.status === 201
            ? el("div", {}, el("p", { class: "ok" }, "Draft created — review it in Approvals."), el("div", { class: "msg-box" }, drafted.body.body))
            : errBox(drafted.body));
        } }, "Generate draft")),
        d.drafts.length ? el("div", {}, el("h2", {}, "Existing drafts"),
          d.drafts.map((draft) => el("p", { class: "small" }, pill(draft.status, draft.status === "approved" ? "good" : ""), ` ${draft.channel} · ${draft.created_at.slice(0, 16)} · `, el("span", { class: "mono" }, draft.content_hash.slice(0, 12))))) : null),
    );
  }

  // -------------------------------------------------------------- approvals
  async function approvalsScreen() {
    const [draftsResult, approvedResult] = await Promise.all([
      api("GET", "/api/drafts?status=draft"), api("GET", "/api/drafts?status=approved"),
    ]);
    if (draftsResult.status !== 200) return setView(errBox(draftsResult.body));
    const msg = el("div");
    const selected = new Set();

    function draftRow(draft, mode) {
      const checkbox = mode === "approved"
        ? el("input", { type: "checkbox", onchange: (event) => { event.target.checked ? selected.add(draft.id) : selected.delete(draft.id); } })
        : null;
      return el("tr", {},
        el("td", {}, checkbox), el("td", { class: "mono small" }, draft.id.slice(0, 18)),
        el("td", {}, draft.channel), el("td", {}, pill(draft.status, draft.status === "approved" ? "good" : "")),
        el("td", { class: "small muted" }, draft.updated_at.slice(0, 16)),
        el("td", {}, el("button", { class: "btn small ghost", onclick: () => openPacket(draft.id) }, "Open packet")));
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
          el("br"), `Channel: ${packet.channel} · contact: ${packet.recipient?.email || packet.recipient?.profile || "—"}`),
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
      el("p", { class: "sub" }, "Approval binds to the exact packet shown. Export prepares CSV/copy text only — sending is always a human act, and email stays blocked until the CAN-SPAM gate passes."),
      msg,
      el("h2", {}, "Waiting for review"),
      el("div", { class: "card table-wrap" }, el("table", {},
        el("thead", {}, el("tr", {}, ["", "Draft", "Channel", "Status", "Updated", ""].map((h) => el("th", {}, h)))),
        el("tbody", {}, draftsResult.body.drafts.length ? draftsResult.body.drafts.map((d) => draftRow(d, "draft"))
          : el("tr", {}, el("td", { colspan: "6", class: "muted" }, "Nothing waiting."))))),
      el("h2", {}, "Approved — ready to export"),
      el("div", { class: "card table-wrap" },
        el("table", {},
          el("thead", {}, el("tr", {}, ["Select", "Draft", "Channel", "Status", "Updated", ""].map((h) => el("th", {}, h)))),
          el("tbody", {}, approvedResult.body.drafts.length ? approvedResult.body.drafts.map((d) => draftRow(d, "approved"))
            : el("tr", {}, el("td", { colspan: "6", class: "muted" }, "None approved.")))),
        el("div", { class: "btn-row" }, el("button", { class: "btn", onclick: async () => {
          if (selected.size === 0) return msg.replaceChildren(errBox("Select drafts first."));
          const exported = await api("POST", "/api/exports", { draft_ids: [...selected] });
          if (exported.status !== 200) return msg.replaceChildren(errBox(exported.body));
          msg.replaceChildren(el("p", { class: "ok" },
            `Exported ${exported.body.exported}. Blocked: ${exported.body.blocked.map((b) => `${b.draftId.slice(0, 14)}→${b.reason}`).join(", ") || "none"}.`));
          if (exported.body.exported > 0) download(`reachwright-export-${Date.now()}.csv`, exported.body.csv);
          approvalsScreen();
        } }, "Export selected (CSV — no sending)"))),
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
    const campaigns = (await api("GET", "/api/campaigns")).body?.campaigns ?? [];
    const select = el("select", {},
      el("option", { value: "" }, "— choose campaign —"),
      campaigns.map((c) => el("option", { value: c.id, selected: c.id === campaignId ? "" : undefined }, c.name)));
    select.addEventListener("change", () => { if (select.value) location.hash = `#/reports/${select.value}`; });
    const body = el("div");

    if (campaignId) {
      const report = await api("GET", `/api/reports/campaigns/${campaignId}`);
      if (report.status === 200) {
        const r = report.body;
        const rows = [["Candidates", r.candidates], ["Duplicates merged", r.duplicates_merged],
          ["Dossiers scored", r.dossiers_scored], ["Drafts created", r.drafts_created],
          ["Drafts approved", r.drafts_approved], ["Prepared/exported", r.prepared_or_exported],
          ["Sent (manual)", r.sent], ["Replies", r.replies], ["Positive replies", r.positive_replies],
          ["Opt-outs", r.opt_outs], ["Booked", r.bookings_booked], ["Held calls", r.calls_held]];
        body.replaceChildren(
          el("div", { class: "grid cols-3" },
            rows.map(([label, n]) => el("div", { class: "stat" }, el("div", { class: "n" }, String(n)), el("div", { class: "l" }, label)))),
          el("h2", {}, "Disqualification reasons"),
          el("div", { class: "card" }, Object.keys(r.disqualification_reasons).length
            ? Object.entries(r.disqualification_reasons).map(([reason, count]) => el("p", { class: "small" }, `${count} × ${reason}`))
            : el("p", { class: "muted small" }, "None recorded.")),
          el("h2", {}, "Provider credit usage"),
          el("div", { class: "card table-wrap" }, el("table", {},
            el("thead", {}, el("tr", {}, ["Provider", "Operation", "Requests", "Est. credits"].map((h) => el("th", {}, h)))),
            el("tbody", {}, r.provider_usage.length ? r.provider_usage.map((u) => el("tr", {},
              el("td", {}, u.provider), el("td", { class: "mono" }, u.operation),
              el("td", {}, String(u.requests)), el("td", {}, String(u.credits))))
              : el("tr", {}, el("td", { colspan: "4", class: "muted" }, "No usage yet.")))))
        );
      } else body.replaceChildren(errBox(report.body));
    }

    const auditResult = await api("GET", "/api/audit");
    setView(
      el("h1", {}, "Reporting"),
      el("p", { class: "sub" }, "Audited counts only. Candidates are never reported as leads; bookings are never reported as held calls."),
      el("div", { class: "card" }, el("label", {}, "Campaign"), select),
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
  }

  // ------------------------------------------------------------------ router
  async function route() {
    if (!state.token) return loginScreen();
    nav.hidden = false;
    await refreshBanner();
    const hash = location.hash || "#/dashboard";
    for (const link of nav.querySelectorAll("a")) {
      link.classList.toggle("active", hash.startsWith(link.getAttribute("href")));
    }
    const [, screen, arg] = hash.slice(1).split("/");
    try {
      if (screen === "campaigns" && arg) return await campaignScreen(arg);
      if (screen === "campaigns") return await campaignsScreen();
      if (screen === "dossier" && arg) return await dossierScreen(arg);
      if (screen === "approvals") return await approvalsScreen();
      if (screen === "qualify") return await qualifyScreen();
      if (screen === "suppression") return await suppressionScreen();
      if (screen === "reports") return await reportsScreen(arg);
      return await dashboardScreen();
    } catch (cause) {
      setView(errBox(`Screen failed to load: ${cause?.message ?? "unknown"}`));
    }
  }

  window.addEventListener("hashchange", route);
  route();
})();
