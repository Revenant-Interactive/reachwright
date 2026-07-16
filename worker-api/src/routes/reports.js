/**
 * Reporting — audited counts only, with the two honesty rules enforced in
 * naming: generated records are "candidates", never "leads", until they pass
 * the campaign threshold; bookings are never counted as held calls.
 */

import { json } from "../index.js";
import { all, one } from "../db.js";

async function dashboard({ env }) {
  const count = async (sql, ...binds) => (await one(env.DB, sql, ...binds))?.n ?? 0;
  return json(env, {
    campaigns_active: await count("SELECT COUNT(*) AS n FROM campaigns WHERE status = 'researching'"),
    candidates_found: await count("SELECT COUNT(*) AS n FROM organizations WHERE merge_state != 'merged'"),
    dossiers_with_accepted_evidence: await count(
      "SELECT COUNT(DISTINCT organization_id) AS n FROM evidence_items WHERE reviewer_state = 'accepted'"),
    approvals_waiting: await count("SELECT COUNT(*) AS n FROM outreach_drafts WHERE status = 'draft'"),
    outreach_prepared: await count("SELECT COUNT(*) AS n FROM outreach_drafts WHERE status IN ('approved','exported')"),
    replies: await count("SELECT COUNT(*) AS n FROM contact_attempts WHERE status IN ('replied','positive-reply')"),
    qualified_conversations: await count("SELECT COUNT(*) AS n FROM qualification_outcomes WHERE verdict = 'strong'"),
    bookings_booked: await count("SELECT COUNT(*) AS n FROM bookings WHERE status IN ('booked','rescheduled')"),
    calls_held: await count("SELECT COUNT(*) AS n FROM bookings WHERE status = 'held'"),
    opt_outs: await count("SELECT COUNT(*) AS n FROM contact_attempts WHERE status = 'opted-out'"),
  });
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
  return json(env, {
    campaign_id: campaignId,
    candidates: await count(
      `SELECT COUNT(DISTINCT organization_id) AS n FROM evidence_items WHERE campaign_id = ?`, campaignId),
    duplicates_merged: duplicatesMerged,
    dossiers_scored: await count(
      `SELECT COUNT(DISTINCT organization_id) AS n FROM fit_scores WHERE campaign_id = ?`, campaignId),
    drafts_created: await count("SELECT COUNT(*) AS n FROM outreach_drafts WHERE campaign_id = ?", campaignId),
    drafts_approved: await count(
      "SELECT COUNT(*) AS n FROM outreach_drafts WHERE campaign_id = ? AND status IN ('approved','exported','sent')", campaignId),
    prepared_or_exported: await count(
      "SELECT COUNT(*) AS n FROM contact_attempts WHERE campaign_id = ? AND status IN ('prepared','exported')", campaignId),
    sent: await count(
      "SELECT COUNT(*) AS n FROM contact_attempts WHERE campaign_id = ? AND status = 'sent'", campaignId),
    replies: await count(
      "SELECT COUNT(*) AS n FROM contact_attempts WHERE campaign_id = ? AND status IN ('replied','positive-reply')", campaignId),
    positive_replies: await count(
      "SELECT COUNT(*) AS n FROM contact_attempts WHERE campaign_id = ? AND status = 'positive-reply'", campaignId),
    opt_outs: await count(
      "SELECT COUNT(*) AS n FROM contact_attempts WHERE campaign_id = ? AND status = 'opted-out'", campaignId),
    bookings_booked: await count(
      "SELECT COUNT(*) AS n FROM bookings WHERE campaign_id = ? AND status IN ('booked','rescheduled')", campaignId),
    calls_held: await count(
      "SELECT COUNT(*) AS n FROM bookings WHERE campaign_id = ? AND status = 'held'", campaignId),
    disqualification_reasons: reasons,
    provider_usage: usage,
  });
}

async function auditLog({ env }) {
  const rows = await all(env.DB,
    "SELECT actor, action, subject_type, subject_id, detail, created_at FROM audit_events ORDER BY created_at DESC LIMIT 100");
  return json(env, { events: rows });
}

export const reportRoutes = [
  ["GET", "/api/dashboard", dashboard],
  ["GET", "/api/reports/campaigns/:id", campaignReport],
  ["GET", "/api/audit", auditLog],
];
