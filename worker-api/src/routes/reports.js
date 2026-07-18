/**
 * Reporting — audited counts only, with the two honesty rules enforced in
 * naming: generated records are "candidates", never "leads", until they pass
 * the campaign threshold; bookings are never counted as held calls.
 */

import { json, readBody } from "../index.js";
import { all, audit, one, parseJsonColumn, run } from "../db.js";
import { dossierAuditChecklistComplete, dossierFingerprint } from "../lib/dossier.js";
import { DEFAULT_THRESHOLDS, passesQueueThreshold } from "../lib/scoring.js";
import { checkSuppression, suppressionKeysFor } from "../lib/suppression.js";
import { nowIso } from "../lib/validate.js";

async function countRuleReadyDossiers(env, campaignId = null) {
  const pairs = campaignId
    ? await all(env.DB,
      `SELECT DISTINCT e.campaign_id, e.organization_id, o.normalized_domain, o.normalized_name
       FROM evidence_items e JOIN organizations o ON o.id = e.organization_id
       WHERE e.campaign_id = ? AND o.merge_state != 'merged'`, campaignId)
    : await all(env.DB,
      `SELECT DISTINCT e.campaign_id, e.organization_id, o.normalized_domain, o.normalized_name
       FROM evidence_items e JOIN organizations o ON o.id = e.organization_id
       WHERE e.campaign_id IS NOT NULL AND o.merge_state != 'merged'`);
  const suppressionRows = await all(env.DB,
    "SELECT key_type, key_value, reason, expires_at FROM suppression_entries");
  let ready = 0;
  for (const pair of pairs) {
    const evidence = await all(env.DB,
      "SELECT * FROM evidence_items WHERE campaign_id = ? AND organization_id = ?",
      pair.campaign_id, pair.organization_id);
    const people = await all(env.DB, "SELECT * FROM people WHERE organization_id = ?", pair.organization_id);
    const acceptedStrong = evidence.filter((item) => item.reviewer_state === "accepted"
      && ["first-party", "authoritative-directory"].includes(item.strength));
    const newest = acceptedStrong.map((item) => item.observed_at).sort().at(-1);
    const ageDays = newest
      ? Math.floor((Date.now() - new Date(`${newest}T00:00:00Z`)) / 86_400_000) : Infinity;
    if (!acceptedStrong.length || ageDays > 60
      || evidence.some((item) => item.reviewer_state === "unreviewed"
        || item.contradiction_state === "contradicted")) continue;
    if (checkSuppression(suppressionKeysFor({ organization: {
      domain: pair.normalized_domain, name: pair.normalized_name,
    } }), suppressionRows).suppressed) continue;
    const hash = await dossierFingerprint(evidence, people);
    const auditRow = await one(env.DB,
      `SELECT verdict, evidence_hash, checklist FROM dossier_audits WHERE campaign_id = ? AND organization_id = ?
       ORDER BY audited_at DESC, rowid DESC LIMIT 1`, pair.campaign_id, pair.organization_id);
    if (auditRow?.verdict !== "accurate" || auditRow.evidence_hash !== hash
      || !dossierAuditChecklistComplete(auditRow)) continue;
    const scores = await all(env.DB,
      `SELECT * FROM fit_scores WHERE campaign_id = ? AND organization_id = ?
       ORDER BY scored_at DESC, rowid DESC`, pair.campaign_id, pair.organization_id);
    const fit = scores.find((score) => score.kind === "fit");
    const evidenceScore = scores.find((score) => score.kind === "evidence");
    if (!fit || !evidenceScore || fit.evidence_hash !== hash || evidenceScore.evidence_hash !== hash) continue;
    if (passesQueueThreshold(fit, evidenceScore)) ready += 1;
  }
  return ready;
}

async function dashboard({ env }) {
  const count = async (sql, ...binds) => (await one(env.DB, sql, ...binds))?.n ?? 0;
  const hideDev = env.OPERATOR_FEED_HIDE_FIXTURES === "true";
  return json(env, {
    campaigns_active: await count(`SELECT COUNT(*) AS n FROM campaigns WHERE status = 'researching'
      ${hideDev ? "AND UPPER(name) NOT LIKE 'DEV SEED%' AND LOWER(name) NOT LIKE '%browser test%'" : ""}`),
    candidates_found: await count(`SELECT COUNT(*) AS n FROM organizations WHERE merge_state != 'merged'
      ${hideDev ? "AND provider != 'local-fixtures' AND display_name NOT LIKE '[FIXTURE]%'" : ""}`),
    dossiers_with_accepted_evidence: await count(
      "SELECT COUNT(DISTINCT organization_id) AS n FROM evidence_items WHERE reviewer_state = 'accepted'"),
    rule_ready_dossiers: await countRuleReadyDossiers(env),
    approvals_waiting: await count("SELECT COUNT(*) AS n FROM outreach_drafts WHERE status = 'draft'"),
    outreach_prepared: await count("SELECT COUNT(*) AS n FROM outreach_drafts WHERE status IN ('approved','exported')"),
    replies: await count("SELECT COUNT(DISTINCT organization_id) AS n FROM contact_attempts WHERE status IN ('replied','positive-reply')"),
    qualified_conversations: await count("SELECT COUNT(*) AS n FROM qualification_outcomes WHERE verdict = 'strong'"),
    bookings_booked: await count("SELECT COUNT(*) AS n FROM bookings WHERE status IN ('booked','rescheduled')"),
    calls_held: await count("SELECT COUNT(*) AS n FROM bookings WHERE status = 'held'"),
    opt_outs: await count("SELECT COUNT(DISTINCT organization_id) AS n FROM contact_attempts WHERE status = 'opted-out'"),
  });
}

async function today({ env }) {
  const hideDev = env.OPERATOR_FEED_HIDE_FIXTURES === "true";
  const orgs = await all(env.DB,
    `SELECT o.id, o.display_name, o.normalized_domain, o.last_verified,
            e.campaign_id, c.name AS campaign_name
     FROM organizations o
     JOIN evidence_items e ON e.organization_id = o.id
     JOIN campaigns c ON c.id = e.campaign_id
     WHERE o.merge_state != 'merged' AND c.status = 'researching'
       ${hideDev ? "AND o.provider != 'local-fixtures' AND o.display_name NOT LIKE '[FIXTURE]%'" : ""}
       ${hideDev ? "AND UPPER(c.name) NOT LIKE 'DEV SEED%' AND LOWER(c.name) NOT LIKE '%browser test%'" : ""}
     GROUP BY o.id, e.campaign_id ORDER BY o.updated_at DESC LIMIT 200`);
  const tasks = [];
  for (const org of orgs) {
    const base = { organization_id: org.id, organization_name: org.display_name,
      campaign_id: org.campaign_id, campaign_name: org.campaign_name };
    const terminal = await one(env.DB,
      `SELECT status FROM contact_attempts WHERE organization_id = ?
       AND status IN ('replied','positive-reply','opted-out','closed') ORDER BY occurred_at DESC LIMIT 1`, org.id);
    if (terminal) continue;

    const externalSent = await one(env.DB,
      `SELECT id, channel, occurred_at FROM contact_attempts WHERE organization_id = ?
       AND campaign_id = ? AND status = 'sent' AND draft_id IS NULL
       ORDER BY occurred_at DESC LIMIT 1`, org.id, org.campaign_id);
    if (externalSent) {
      tasks.push({ ...base, kind: "record-outcome", attempt_id: externalSent.id,
        detail: `Prior ${externalSent.channel} contact recorded ${externalSent.occurred_at.slice(0, 10)}` });
      continue;
    }

    const unreviewed = await one(env.DB,
      "SELECT COUNT(*) AS n FROM evidence_items WHERE organization_id = ? AND campaign_id = ? AND reviewer_state = 'unreviewed'",
      org.id, org.campaign_id);
    if ((unreviewed?.n ?? 0) > 0) {
      tasks.push({ ...base, kind: "review-evidence", detail: `${unreviewed.n} item(s)` });
      continue;
    }

    const verified = await one(env.DB,
      `SELECT MAX(observed_at) AS verified_at FROM evidence_items
       WHERE organization_id = ? AND campaign_id = ? AND reviewer_state = 'accepted'
       AND strength IN ('first-party','authoritative-directory')`, org.id, org.campaign_id);
    const ageDays = verified?.verified_at
      ? Math.floor((Date.now() - new Date(`${verified.verified_at}T00:00:00Z`)) / 86_400_000) : null;
    if (ageDays === null || ageDays > 60) {
      tasks.push({ ...base, kind: "reverify",
        detail: ageDays === null ? "No accepted strong campaign evidence" : `${ageDays} days old` });
      continue;
    }

    const audit = await one(env.DB,
      `SELECT verdict, audited_at, evidence_hash, checklist FROM dossier_audits WHERE organization_id = ? AND campaign_id = ?
       ORDER BY audited_at DESC, rowid DESC LIMIT 1`, org.id, org.campaign_id);
    const evidence = await all(env.DB,
      "SELECT * FROM evidence_items WHERE organization_id = ? AND campaign_id = ?", org.id, org.campaign_id);
    const people = await all(env.DB, "SELECT * FROM people WHERE organization_id = ?", org.id);
    const currentHash = await dossierFingerprint(evidence, people);
    if (!audit || audit.verdict !== "accurate" || audit.evidence_hash !== currentHash
      || !dossierAuditChecklistComplete(audit)) {
      const detail = audit?.verdict === "accurate" && !dossierAuditChecklistComplete(audit)
        ? "Verification checklist required"
        : audit?.verdict === "accurate" ? "Evidence changed since audit" : audit?.verdict ?? "Not audited";
      tasks.push({ ...base, kind: "audit-dossier", detail });
      continue;
    }


    const scores = await all(env.DB,
      `SELECT * FROM fit_scores WHERE campaign_id = ? AND organization_id = ?
       ORDER BY scored_at DESC, rowid DESC`, org.campaign_id, org.id);
    const fit = scores.find((score) => score.kind === "fit") ?? null;
    const evidenceScore = scores.find((score) => score.kind === "evidence") ?? null;
    if (!fit || !evidenceScore || fit.evidence_hash !== currentHash || evidenceScore.evidence_hash !== currentHash) {
      tasks.push({ ...base, kind: "score-dossier", detail: !fit || !evidenceScore
        ? "Fit and evidence scores required" : "Evidence changed since scoring" });
      continue;
    }
    if (!passesQueueThreshold(fit, evidenceScore)) {
      const effective = (score) => Number.isInteger(score.override_total) ? score.override_total : score.total;
      tasks.push({ ...base, kind: "review-score",
        detail: `Fit ${effective(fit)}/${DEFAULT_THRESHOLDS.fit}; evidence ${effective(evidenceScore)}/${DEFAULT_THRESHOLDS.evidence}` });
      continue;
    }

    const initial = await one(env.DB,
      `SELECT id, status FROM outreach_drafts WHERE organization_id = ? AND outreach_kind = 'initial'
       AND status != 'killed' ORDER BY updated_at DESC LIMIT 1`, org.id);
    if (!initial) {
      tasks.push({ ...base, kind: "draft-outreach", detail: "Accurate dossier; no initial draft" });
      continue;
    }
    if (initial.status === "draft") {
      tasks.push({ ...base, kind: "approve-draft", draft_id: initial.id, detail: "Review initial packet" });
      continue;
    }
    if (initial.status === "approved") {
      tasks.push({ ...base, kind: "export-approved", draft_id: initial.id, detail: "Export one approved initial" });
      continue;
    }
    if (initial.status === "exported") {
      tasks.push({ ...base, kind: "record-send", draft_id: initial.id, detail: "Confirm the manual send" });
      continue;
    }

    const sent = await one(env.DB,
      "SELECT occurred_at FROM contact_attempts WHERE draft_id = ? AND status = 'sent' ORDER BY occurred_at ASC LIMIT 1",
      initial.id);
    if (!sent) continue;
    const followup = await one(env.DB,
      `SELECT id, status FROM outreach_drafts WHERE organization_id = ? AND outreach_kind = 'follow-up'
       AND status != 'killed' ORDER BY updated_at DESC LIMIT 1`, org.id);
    if (!followup) {
      const eligible = new Date(new Date(sent.occurred_at).getTime() + 7 * 86_400_000);
      if (Date.now() >= eligible.getTime()) {
        tasks.push({ ...base, kind: "follow-up-due", detail: `Eligible since ${eligible.toISOString().slice(0, 10)}` });
      }
      continue;
    }
    if (followup.status === "draft") {
      tasks.push({ ...base, kind: "approve-draft", draft_id: followup.id, detail: "Review follow-up packet" });
    } else if (followup.status === "approved") {
      tasks.push({ ...base, kind: "export-approved", draft_id: followup.id, detail: "Export one approved follow-up" });
    } else if (followup.status === "exported") {
      tasks.push({ ...base, kind: "record-send", draft_id: followup.id, detail: "Confirm the manual follow-up send" });
    } else if (followup.status === "sent") {
      tasks.push({ ...base, kind: "record-outcome", draft_id: followup.id, detail: "Record reply, opt-out, or close" });
    }
  }
  const priority = { "follow-up-due": 1, "record-send": 2, "record-outcome": 3,
    "review-evidence": 4, "audit-dossier": 5, "approve-draft": 6,
    "score-dossier": 6, "review-score": 7, "export-approved": 8,
    "draft-outreach": 9, reverify: 10 };
  tasks.sort((a, b) => (priority[a.kind] ?? 99) - (priority[b.kind] ?? 99));
  return json(env, { tasks });
}

function scopeClause(scope, alias = "gr") {
  if (scope.campaignId) return { sql: `${alias}.campaign_id = ?`, binds: [scope.campaignId] };
  return { sql: `${alias}.client_id = ?`, binds: [scope.clientId] };
}

const rate = (numerator, denominator) => denominator ? numerator / denominator : null;

async function generationPerformance(env, scope) {
  const runScope = scopeClause(scope);
  const count = async (sql, ...binds) => Number((await one(env.DB, sql, ...binds))?.n || 0);
  const runsByStatus = await all(env.DB,
    `SELECT gr.status, COUNT(*) AS n FROM generation_runs gr
     WHERE ${runScope.sql} GROUP BY gr.status`, ...runScope.binds);
  const statuses = Object.fromEntries(runsByStatus.map((row) => [row.status, Number(row.n)]));
  const candidates = await count(
    `SELECT COUNT(*) AS n FROM generation_candidates gc JOIN generation_runs gr ON gr.id = gc.run_id
     WHERE ${runScope.sql}`, ...runScope.binds);
  const researched = await count(
    `SELECT COUNT(DISTINCT gc.id) AS n FROM generation_candidates gc
     JOIN generation_runs gr ON gr.id = gc.run_id
     JOIN website_research wr ON wr.run_id = gc.run_id AND wr.organization_id = gc.organization_id
     WHERE ${runScope.sql}`, ...runScope.binds);
  const contactable = await count(
    `SELECT COUNT(*) AS n FROM generation_candidates gc JOIN generation_runs gr ON gr.id = gc.run_id
     WHERE ${runScope.sql} AND gc.contact_route_id IS NOT NULL`, ...runScope.binds);
  const ready = await count(
    `SELECT COUNT(*) AS n FROM generation_candidates gc JOIN generation_runs gr ON gr.id = gc.run_id
     WHERE ${runScope.sql} AND gc.stage = 'message-ready'`, ...runScope.binds);
  const failures = await count(
    `SELECT COUNT(DISTINCT ge.candidate_id) AS n FROM generation_events ge
     JOIN generation_runs gr ON gr.id = ge.run_id
     WHERE ${runScope.sql} AND ge.candidate_id IS NOT NULL AND ge.status = 'failed'`, ...runScope.binds);
  const credits = Number((await one(env.DB,
    `SELECT COALESCE(SUM(ge.credits_estimated), 0) AS n FROM generation_events ge
     JOIN generation_runs gr ON gr.id = ge.run_id
     WHERE ${runScope.sql} AND ge.event_type = 'provider-call'
       AND ge.status IN ('succeeded','failed')`, ...runScope.binds))?.n || 0);
  const options = await count(
    `SELECT COUNT(*) AS n FROM strategic_message_options smo
     JOIN generation_runs gr ON gr.id = smo.run_id WHERE ${runScope.sql}`, ...runScope.binds);
  const draftScope = scope.campaignId ? "d.campaign_id = ?" : "c.client_id = ?";
  const outcomeBind = scope.campaignId ?? scope.clientId;
  const messagesSelected = await count(
    `SELECT COUNT(DISTINCT d.id) AS n FROM outreach_drafts d
     JOIN campaigns c ON c.id = d.campaign_id
     WHERE ${draftScope} AND d.generation_candidate_id IS NOT NULL`, outcomeBind);
  const messagesSent = await count(
    `SELECT COUNT(DISTINCT ca.draft_id) AS n FROM contact_attempts ca
     JOIN outreach_drafts d ON d.id = ca.draft_id JOIN campaigns c ON c.id = d.campaign_id
     WHERE ${draftScope} AND d.generation_candidate_id IS NOT NULL AND ca.status = 'sent'`, outcomeBind);
  const replies = await count(
    `SELECT COUNT(DISTINCT d.generation_candidate_id) AS n FROM contact_attempts ca
     JOIN outreach_drafts d ON d.id = ca.draft_id JOIN campaigns c ON c.id = d.campaign_id
     WHERE ${draftScope} AND d.generation_candidate_id IS NOT NULL
       AND ca.status IN ('replied','positive-reply')`, outcomeBind);
  const positiveReplies = await count(
    `SELECT COUNT(DISTINCT d.generation_candidate_id) AS n FROM contact_attempts ca
     JOIN outreach_drafts d ON d.id = ca.draft_id JOIN campaigns c ON c.id = d.campaign_id
     WHERE ${draftScope} AND d.generation_candidate_id IS NOT NULL AND ca.status = 'positive-reply'`, outcomeBind);
  const bookingScope = scope.campaignId ? "b.campaign_id = ?" : "b.client_id = ?";
  const booked = await count(
    `SELECT COUNT(DISTINCT b.generation_candidate_id) AS n FROM bookings b
     WHERE ${bookingScope} AND b.generation_candidate_id IS NOT NULL
       AND b.status IN ('booked','rescheduled')`, outcomeBind);
  const held = await count(
    `SELECT COUNT(DISTINCT b.generation_candidate_id) AS n FROM bookings b
     WHERE ${bookingScope} AND b.generation_candidate_id IS NOT NULL AND b.status = 'held'`, outcomeBind);
  const sales = await count(
    `SELECT COUNT(DISTINCT b.generation_candidate_id) AS n FROM bookings b
     WHERE ${bookingScope} AND b.generation_candidate_id IS NOT NULL
       AND b.payment_status = 'operator-confirmed-paid'`, outcomeBind);
  return {
    runs_started: Object.values(statuses).reduce((sum, value) => sum + value, 0),
    runs_completed: statuses.completed || 0, runs_partial: statuses.partial || 0,
    candidates_discovered: candidates, candidates_researched: researched,
    research_failures: failures, contactable_prospects: contactable,
    message_ready_prospects: ready, message_options_prepared: options,
    messages_selected: messagesSelected, messages_sent: messagesSent,
    replies, positive_replies: positiveReplies,
    bookings_booked: booked, calls_held: held, operator_confirmed_sales: sales,
    provider_credits_estimated: credits,
    candidate_to_ready_yield: rate(ready, candidates),
    contactability_rate: rate(contactable, researched),
    reply_rate: rate(replies, messagesSent),
    held_call_rate: rate(held, messagesSent), sale_rate: rate(sales, messagesSent),
  };
}

function aggregateCohorts(rows, key, { selectedOnly = false } = {}) {
  const groups = new Map();
  for (const row of rows) {
    const label = row[key] || (selectedOnly ? "" : "Unclassified");
    if (!label || (selectedOnly && !row.message_selected)) continue;
    if (!groups.has(label)) groups.set(label, { label, candidates: 0, message_ready: 0,
      messages_selected: 0, sent: 0, replies: 0, positive_replies: 0,
      booked: 0, held: 0, sales: 0 });
    const group = groups.get(label);
    group.candidates += 1;
    for (const metric of ["message_ready", "message_selected", "sent", "replies",
      "positive_replies", "booked", "held", "sales"]) group[metric === "message_selected" ? "messages_selected" : metric] += Number(row[metric] || 0);
  }
  return [...groups.values()].map((group) => ({ ...group,
    ready_rate: rate(group.message_ready, group.candidates),
    reply_rate: rate(group.replies, group.sent),
    positive_reply_rate: rate(group.positive_replies, group.sent),
    held_call_rate: rate(group.held, group.sent), sale_rate: rate(group.sales, group.sent),
    low_sample: group.sent < 5,
  })).sort((a, b) => b.sent - a.sent || b.message_ready - a.message_ready || a.label.localeCompare(b.label));
}

async function feedbackCohorts(env, scope) {
  const runScope = scopeClause(scope);
  const rows = await all(env.DB,
    `SELECT gc.id, gc.stage = 'message-ready' AS message_ready,
            os.signal_type, cs.name AS service_name,
            smo.strategy,
            CASE WHEN smo.converted_draft_id IS NOT NULL THEN 1 ELSE 0 END AS message_selected,
            CASE WHEN EXISTS (SELECT 1 FROM contact_attempts ca WHERE ca.draft_id = smo.converted_draft_id AND ca.status = 'sent') THEN 1 ELSE 0 END AS sent,
            CASE WHEN EXISTS (SELECT 1 FROM contact_attempts ca WHERE ca.draft_id = smo.converted_draft_id AND ca.status IN ('replied','positive-reply')) THEN 1 ELSE 0 END AS replies,
            CASE WHEN EXISTS (SELECT 1 FROM contact_attempts ca WHERE ca.draft_id = smo.converted_draft_id AND ca.status = 'positive-reply') THEN 1 ELSE 0 END AS positive_replies,
            CASE WHEN EXISTS (SELECT 1 FROM bookings b WHERE b.generation_candidate_id = gc.id AND b.status IN ('booked','rescheduled')) THEN 1 ELSE 0 END AS booked,
            CASE WHEN EXISTS (SELECT 1 FROM bookings b WHERE b.generation_candidate_id = gc.id AND b.status = 'held') THEN 1 ELSE 0 END AS held,
            CASE WHEN EXISTS (SELECT 1 FROM bookings b WHERE b.generation_candidate_id = gc.id AND b.payment_status = 'operator-confirmed-paid') THEN 1 ELSE 0 END AS sales
     FROM generation_candidates gc
     JOIN generation_runs gr ON gr.id = gc.run_id
     LEFT JOIN opportunity_signals os ON os.id = gc.primary_signal_id
     LEFT JOIN client_services cs ON cs.id = gc.recommended_service_id
     LEFT JOIN strategic_message_options smo ON smo.candidate_id = gc.id AND smo.converted_draft_id IS NOT NULL
     WHERE ${runScope.sql}`, ...runScope.binds);
  return {
    by_signal: aggregateCohorts(rows, "signal_type"),
    by_service: aggregateCohorts(rows, "service_name"),
    by_strategy: aggregateCohorts(rows, "strategy", { selectedOnly: true }),
    interpretation: "Outcome rates use selected, generation-attributed messages only. Samples under five sends are flagged low-sample.",
  };
}

async function campaignReport({ env, params }) {
  const count = async (sql, ...binds) => (await one(env.DB, sql, ...binds))?.n ?? 0;
  const campaignId = params.id;
  const disqualifiers = await all(env.DB,
    `SELECT disqualifiers FROM fit_scores WHERE campaign_id = ? AND kind = 'fit' AND disqualifiers != '[]'`,
    campaignId);
  const reasons = {};
  for (const row of disqualifiers) {
    try {
      for (const dq of JSON.parse(row.disqualifiers)) reasons[dq.reason] = (reasons[dq.reason] ?? 0) + 1;
    } catch { /* unparseable rows are skipped, not guessed at */ }
  }
  const usage = await all(env.DB,
    `SELECT provider, operation, SUM(request_count) AS requests, SUM(credits_estimated) AS credits
     FROM provider_usage WHERE campaign_id = ? GROUP BY provider, operation`, campaignId);
  // Duplicates merged = sum of server-observed merge counts from search audits
  // (the search flow merges into the canonical row rather than storing a twin,
  // so counting merge_state rows would undercount).
  const searchAudits = await all(env.DB,
    "SELECT detail FROM audit_events WHERE action = 'research.search' AND subject_id = ?", campaignId);
  let duplicatesMerged = 0;
  for (const row of searchAudits) {
    try { duplicatesMerged += Number(JSON.parse(row.detail)?.merged) || 0; } catch { /* skip */ }
  }
  const campaign = await one(env.DB,
    `SELECT ca.id, ca.name, ca.client_id, cl.name AS client_name, ca.geography, ca.icp
     FROM campaigns ca JOIN clients cl ON cl.id = ca.client_id WHERE ca.id = ?`, campaignId);
  if (!campaign) return json(env, { error: "not-found" }, 404);
  return json(env, {
    campaign_id: campaignId,
    campaign_name: campaign.name, client_id: campaign.client_id, client_name: campaign.client_name,
    candidates: await count(
      `SELECT COUNT(DISTINCT organization_id) AS n FROM evidence_items WHERE campaign_id = ?`, campaignId),
    duplicates_merged: duplicatesMerged,
    dossiers_scored: await count(
      `SELECT COUNT(DISTINCT organization_id) AS n FROM fit_scores WHERE campaign_id = ?`, campaignId),
    rule_ready_dossiers: await countRuleReadyDossiers(env, campaignId),
    dossiers_audited_accurate: await count(
      `SELECT COUNT(*) AS n FROM dossier_audits da WHERE campaign_id = ? AND verdict = 'accurate'
       AND rowid = (SELECT MAX(rowid) FROM dossier_audits WHERE campaign_id = da.campaign_id AND organization_id = da.organization_id)`, campaignId),
    dossiers_audited_partly: await count(
      `SELECT COUNT(*) AS n FROM dossier_audits da WHERE campaign_id = ? AND verdict = 'partly-accurate'
       AND rowid = (SELECT MAX(rowid) FROM dossier_audits WHERE campaign_id = da.campaign_id AND organization_id = da.organization_id)`, campaignId),
    dossiers_rejected: await count(
      `SELECT COUNT(*) AS n FROM dossier_audits da WHERE campaign_id = ? AND verdict = 'reject'
       AND rowid = (SELECT MAX(rowid) FROM dossier_audits WHERE campaign_id = da.campaign_id AND organization_id = da.organization_id)`, campaignId),
    drafts_created: await count("SELECT COUNT(*) AS n FROM outreach_drafts WHERE campaign_id = ?", campaignId),
    drafts_approved: await count(
      "SELECT COUNT(*) AS n FROM outreach_drafts WHERE campaign_id = ? AND status IN ('approved','exported','sent')", campaignId),
    prepared_or_exported: await count(
      "SELECT COUNT(*) AS n FROM contact_attempts WHERE campaign_id = ? AND status IN ('prepared','exported')", campaignId),
    sent: await count(
      "SELECT COUNT(*) AS n FROM contact_attempts WHERE campaign_id = ? AND status = 'sent'", campaignId),
    replies: await count(
      "SELECT COUNT(DISTINCT organization_id) AS n FROM contact_attempts WHERE campaign_id = ? AND status IN ('replied','positive-reply')", campaignId),
    positive_replies: await count(
      "SELECT COUNT(DISTINCT organization_id) AS n FROM contact_attempts WHERE campaign_id = ? AND status = 'positive-reply'", campaignId),
    opt_outs: await count(
      "SELECT COUNT(DISTINCT organization_id) AS n FROM contact_attempts WHERE campaign_id = ? AND status = 'opted-out'", campaignId),
    bookings_booked: await count(
      "SELECT COUNT(*) AS n FROM bookings WHERE campaign_id = ? AND status IN ('booked','rescheduled')", campaignId),
    calls_held: await count(
      "SELECT COUNT(*) AS n FROM bookings WHERE campaign_id = ? AND status = 'held'", campaignId),
    disqualification_reasons: reasons,
    provider_usage: usage,
    generation_performance: await generationPerformance(env, { campaignId }),
    feedback: await feedbackCohorts(env, { campaignId }),
  });
}

async function clientReport({ env, params }) {
  const client = await one(env.DB, "SELECT * FROM clients WHERE id = ?", params.id);
  if (!client) return json(env, { error: "not-found" }, 404);
  const campaigns = await all(env.DB,
    "SELECT id, name, geography, icp, status FROM campaigns WHERE client_id = ? ORDER BY created_at DESC", client.id);
  const byCampaign = [];
  for (const campaign of campaigns) {
    byCampaign.push({ ...campaign,
      generation_performance: await generationPerformance(env, { campaignId: campaign.id }) });
  }
  return json(env, {
    client: { id: client.id, name: client.name, mode: client.mode, status: client.status },
    generation_performance: await generationPerformance(env, { clientId: client.id }),
    feedback: await feedbackCohorts(env, { clientId: client.id }),
    markets: byCampaign,
    isolation_note: "Logical operator-only separation. Canonical identities and suppression remain global safety controls.",
  });
}

async function auditLog({ env }) {
  const rows = await all(env.DB,
    "SELECT actor, action, subject_type, subject_id, detail, created_at FROM audit_events ORDER BY created_at DESC LIMIT 100");
  return json(env, { events: rows });
}

const REVENUE_PLAN_FIELDS = Object.freeze({
  target_mrr_cents: { min: 100000, max: 100000000, integer: true },
  average_client_mrr_cents: { min: 10000, max: 10000000, integer: true },
  assumed_held_call_close_rate: { min: 0.01, max: 1 },
  assumed_booking_show_rate: { min: 0.01, max: 1 },
  assumed_positive_reply_to_booking_rate: { min: 0.01, max: 1 },
  assumed_outreach_to_positive_reply_rate: { min: 0.01, max: 1 },
  weekly_outreach_days: { min: 1, max: 7, integer: true },
});

async function revenuePlan({ env }) {
  const plan = await one(env.DB, "SELECT * FROM revenue_plan WHERE id = 'owner'");
  if (!plan) return json(env, { error: "revenue-plan-not-configured" }, 503);
  const count = async (sql, ...binds) => Number((await one(env.DB, sql, ...binds))?.n || 0);
  const hideDev = env.OPERATOR_FEED_HIDE_FIXTURES === "true";
  const realCandidate = hideDev
    ? `AND o.provider != 'local-fixtures' AND o.display_name NOT LIKE '[FIXTURE]%'
       AND UPPER(c.name) NOT LIKE 'DEV SEED%' AND LOWER(c.name) NOT LIKE '%browser test%'`
    : "";
  const funnel = {
    qualified_prospects: await count(
      `SELECT COUNT(*) AS n FROM generation_candidates gc
       JOIN organizations o ON o.id = gc.organization_id
       JOIN campaigns c ON c.id = gc.campaign_id
       WHERE gc.stage = 'message-ready' ${realCandidate}`),
    messages_selected: await count(
      `SELECT COUNT(DISTINCT d.generation_candidate_id) AS n FROM outreach_drafts d
       JOIN generation_candidates gc ON gc.id = d.generation_candidate_id
       JOIN organizations o ON o.id = gc.organization_id
       JOIN campaigns c ON c.id = gc.campaign_id
       WHERE d.generation_candidate_id IS NOT NULL AND d.status != 'killed' ${realCandidate}`),
    manually_sent: await count(
      `SELECT COUNT(DISTINCT d.generation_candidate_id) AS n FROM contact_attempts ca
       JOIN outreach_drafts d ON d.id = ca.draft_id
       JOIN generation_candidates gc ON gc.id = d.generation_candidate_id
       JOIN organizations o ON o.id = gc.organization_id
       JOIN campaigns c ON c.id = gc.campaign_id
       WHERE d.generation_candidate_id IS NOT NULL AND ca.status = 'sent' ${realCandidate}`),
    replies: await count(
      `SELECT COUNT(DISTINCT d.generation_candidate_id) AS n FROM contact_attempts ca
       JOIN outreach_drafts d ON d.id = ca.draft_id
       JOIN generation_candidates gc ON gc.id = d.generation_candidate_id
       JOIN organizations o ON o.id = gc.organization_id
       JOIN campaigns c ON c.id = gc.campaign_id
       WHERE d.generation_candidate_id IS NOT NULL AND ca.status IN ('replied','positive-reply') ${realCandidate}`),
    positive_replies: await count(
      `SELECT COUNT(DISTINCT d.generation_candidate_id) AS n FROM contact_attempts ca
       JOIN outreach_drafts d ON d.id = ca.draft_id
       JOIN generation_candidates gc ON gc.id = d.generation_candidate_id
       JOIN organizations o ON o.id = gc.organization_id
       JOIN campaigns c ON c.id = gc.campaign_id
       WHERE d.generation_candidate_id IS NOT NULL AND ca.status = 'positive-reply' ${realCandidate}`),
    meetings_booked: await count(
      "SELECT COUNT(*) AS n FROM bookings WHERE archived_at IS NULL AND status IN ('booked','rescheduled')"),
    meetings_held: await count(
      "SELECT COUNT(*) AS n FROM bookings WHERE archived_at IS NULL AND status = 'held'"),
    offers_recommended: await count(
      "SELECT COUNT(*) AS n FROM bookings WHERE archived_at IS NULL AND offer_id != ''"),
    agreements_sent_or_signed: await count(
      "SELECT COUNT(*) AS n FROM bookings WHERE archived_at IS NULL AND agreement_status IN ('sent','signed')"),
    operator_confirmed_sales: await count(
      "SELECT COUNT(*) AS n FROM bookings WHERE archived_at IS NULL AND payment_status = 'operator-confirmed-paid'"),
  };
  const paid = await all(env.DB,
    `SELECT offer_snapshot FROM bookings
     WHERE archived_at IS NULL AND payment_status = 'operator-confirmed-paid'`);
  let recordedMrr = 0;
  let recordedOneTime = 0;
  let recurringClients = 0;
  for (const row of paid) {
    const offer = parseJsonColumn(row.offer_snapshot, {});
    const amount = Number(offer.amount_cents || 0);
    if (offer.cadence === "monthly") {
      recordedMrr += amount;
      recurringClients += 1;
    } else if (offer.cadence === "one-time") recordedOneTime += amount;
  }
  const targetMrr = Number(plan.target_mrr_cents);
  const averageMrr = Number(plan.average_client_mrr_cents);
  const gap = Math.max(0, targetMrr - recordedMrr);
  const winsNeeded = Math.ceil(gap / averageMrr);
  const requiredHeld = Math.ceil(winsNeeded / Number(plan.assumed_held_call_close_rate));
  const requiredBooked = Math.ceil(requiredHeld / Number(plan.assumed_booking_show_rate));
  const requiredPositive = Math.ceil(requiredBooked / Number(plan.assumed_positive_reply_to_booking_rate));
  const requiredOutreach = Math.ceil(requiredPositive / Number(plan.assumed_outreach_to_positive_reply_rate));
  const workdaysInFourWeeks = Number(plan.weekly_outreach_days) * 4;
  const bottleneck = revenueBottleneck(funnel, gap);
  return json(env, {
    plan: {
      target_mrr_cents: targetMrr,
      average_client_mrr_cents: averageMrr,
      assumed_held_call_close_rate: Number(plan.assumed_held_call_close_rate),
      assumed_booking_show_rate: Number(plan.assumed_booking_show_rate),
      assumed_positive_reply_to_booking_rate: Number(plan.assumed_positive_reply_to_booking_rate),
      assumed_outreach_to_positive_reply_rate: Number(plan.assumed_outreach_to_positive_reply_rate),
      weekly_outreach_days: Number(plan.weekly_outreach_days),
      updated_at: plan.updated_at,
    },
    actual: {
      recorded_mrr_cents: recordedMrr, recorded_one_time_revenue_cents: recordedOneTime,
      recurring_clients_recorded: recurringClients, mrr_gap_cents: gap,
      target_progress: targetMrr ? recordedMrr / targetMrr : null,
    },
    required: {
      additional_recurring_clients: winsNeeded,
      held_calls: requiredHeld,
      bookings: requiredBooked,
      positive_replies: requiredPositive,
      manual_outreaches: requiredOutreach,
      manual_outreaches_per_workday_for_four_weeks: workdaysInFourWeeks
        ? Math.ceil(requiredOutreach / workdaysInFourWeeks) : null,
    },
    funnel,
    bottleneck,
    truth: {
      assumptions_are_targets_not_benchmarks: true,
      paid_requires_operator_confirmation: true,
      recurring_status_limit: "Recorded MRR counts operator-confirmed monthly sales. Reachwright does not yet model churn, pauses, or contract end dates.",
      pipeline_limit: "Offer recommendation and agreement state are tracked; a separate proposal document state is not yet modeled.",
    },
  });
}

async function patchRevenuePlan({ request, env }) {
  const body = await readBody(request, env);
  if (!body) return json(env, { error: "validation", details: ["JSON object required"] }, 422);
  const unknown = Object.keys(body).filter((key) => !REVENUE_PLAN_FIELDS[key]);
  if (unknown.length) return json(env, { error: "validation", details: unknown.map((key) => `unknown field: ${key}`) }, 422);
  if (!Object.keys(body).length) return json(env, { error: "validation", details: ["at least one field is required"] }, 422);
  const current = await one(env.DB, "SELECT * FROM revenue_plan WHERE id = 'owner'");
  if (!current) return json(env, { error: "revenue-plan-not-configured" }, 503);
  const next = { ...current };
  const errors = [];
  for (const [key, value] of Object.entries(body)) {
    const rule = REVENUE_PLAN_FIELDS[key];
    const number = Number(value);
    if (!Number.isFinite(number) || number < rule.min || number > rule.max
      || (rule.integer && !Number.isInteger(number))) errors.push(`${key} is out of range`);
    else next[key] = number;
  }
  if (errors.length) return json(env, { error: "validation", details: errors }, 422);
  const updatedAt = nowIso();
  await run(env.DB,
    `UPDATE revenue_plan SET target_mrr_cents = ?, average_client_mrr_cents = ?,
       assumed_held_call_close_rate = ?, assumed_booking_show_rate = ?,
       assumed_positive_reply_to_booking_rate = ?, assumed_outreach_to_positive_reply_rate = ?,
       weekly_outreach_days = ?, updated_at = ? WHERE id = 'owner'`,
    next.target_mrr_cents, next.average_client_mrr_cents,
    next.assumed_held_call_close_rate, next.assumed_booking_show_rate,
    next.assumed_positive_reply_to_booking_rate, next.assumed_outreach_to_positive_reply_rate,
    next.weekly_outreach_days, updatedAt);
  await audit(env.DB, { action: "revenue-plan.update", subjectType: "revenue-plan", subjectId: "owner",
    detail: { fields: Object.keys(body) } });
  return revenuePlan({ env });
}

function revenueBottleneck(funnel, gap) {
  if (gap <= 0) return { stage: "target-reached", action: "Protect delivery quality and record retention or churn changes." };
  if (!funnel.qualified_prospects) return { stage: "qualified-prospects", action: "Generate and verify stronger current-need opportunities." };
  if (funnel.messages_selected < funnel.qualified_prospects) return { stage: "packet-review", action: "Review the strongest prospect packet and choose one evidence-bound message." };
  if (funnel.manually_sent < funnel.messages_selected) return { stage: "manual-send", action: "Approve and manually send the next prepared message, then record it." };
  if (!funnel.positive_replies) return { stage: "positive-replies", action: "Work the single follow-up and improve the signal/message pairing from recorded outcomes." };
  if (!funnel.meetings_booked) return { stage: "booking", action: "Turn the positive reply into a scheduled fit conversation." };
  if (!funnel.meetings_held) return { stage: "show", action: "Prepare the next booked call and record held or no-show truthfully." };
  if (!funnel.agreements_sent_or_signed) return { stage: "offer-and-agreement", action: "Recommend the smallest responsible offer and send its agreement." };
  if (!funnel.operator_confirmed_sales) return { stage: "payment", action: "Follow the signed-agreement payment sequence and record cleared payment only after verification." };
  return { stage: "pipeline-depth", action: "Add enough qualified opportunities to close the remaining recurring-client gap." };
}

export const reportRoutes = [
  ["GET", "/api/dashboard", dashboard],
  ["GET", "/api/today", today],
  ["GET", "/api/revenue-plan", revenuePlan],
  ["PATCH", "/api/revenue-plan", patchRevenuePlan],
  ["GET", "/api/reports/campaigns/:id", campaignReport],
  ["GET", "/api/reports/clients/:id", clientReport],
  ["GET", "/api/audit", auditLog],
];
