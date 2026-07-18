/**
 * Outreach routes — drafts, approvals, suppression, exports, attempts.
 *
 * State machine (playbook): draft → approved → ready-to-send → exported/sent
 *                                    ↘ killed;  edit-after-approve → draft.
 * Suppression checkpoints: at draft creation, at approval, and again at
 * export (checkpoints 2 and 3; checkpoint 1 lives in research search).
 * No automatic sending exists anywhere in this codebase — export produces
 * CSV/copyable text and records a `prepared`/`exported` contact attempt.
 */

import { json, error, readBody } from "../index.js";
import { all, audit, one, run, parseJsonColumn } from "../db.js";
import { makeId, nowIso, validateBody, LIMITS } from "../lib/validate.js";
import { assembleDraft, contentHash, INSUFFICIENT, PROMPT_VERSION } from "../lib/drafts.js";
import {
  suppressionKeysFor, checkSuppression, normalizeSuppressionValue, expandOptOut,
} from "../lib/suppression.js";
import { toCsv } from "../lib/csv.js";
import { dossierAuditChecklistComplete, dossierFingerprint } from "../lib/dossier.js";
import { DEFAULT_THRESHOLDS, passesQueueThreshold } from "../lib/scoring.js";
import { contactForChannel } from "../lib/contact.js";

async function loadSuppression(env) {
  return all(env.DB, "SELECT key_type, key_value, reason, expires_at FROM suppression_entries");
}

async function prospectSuppression(env, org, person) {
  const rows = await loadSuppression(env);
  return checkSuppression(
    suppressionKeysFor({
      organization: { domain: org?.normalized_domain, name: org?.normalized_name },
      person: person ?? {},
    }),
    rows,
  );
}

async function latestDossierAudit(env, campaignId, organizationId) {
  return one(env.DB,
     `SELECT * FROM dossier_audits WHERE campaign_id = ? AND organization_id = ?
     ORDER BY audited_at DESC, rowid DESC LIMIT 1`, campaignId, organizationId);
}

async function latestCampaignScores(env, campaignId, organizationId) {
  const rows = await all(env.DB,
    `SELECT * FROM fit_scores WHERE campaign_id = ? AND organization_id = ?
     ORDER BY scored_at DESC, rowid DESC`, campaignId, organizationId);
  return {
    fit: rows.find((row) => row.kind === "fit") ?? null,
    evidence: rows.find((row) => row.kind === "evidence") ?? null,
  };
}

async function organizationInCampaign(env, organizationId, campaignId) {
  return Boolean(await one(env.DB,
    "SELECT id FROM evidence_items WHERE organization_id = ? AND campaign_id = ? LIMIT 1",
    organizationId, campaignId));
}

async function currentDraftDossierGate(env, draft) {
  const [evidence, people, dossierAudit, scores] = await Promise.all([
    all(env.DB, "SELECT * FROM evidence_items WHERE organization_id = ? AND campaign_id = ?",
      draft.organization_id, draft.campaign_id),
    all(env.DB, "SELECT * FROM people WHERE organization_id = ?", draft.organization_id),
    latestDossierAudit(env, draft.campaign_id, draft.organization_id),
    latestCampaignScores(env, draft.campaign_id, draft.organization_id),
  ]);
  const fingerprint = await dossierFingerprint(evidence, people);
  if (dossierAudit?.verdict !== "accurate" || !dossierAuditChecklistComplete(dossierAudit)
    || dossierAudit.evidence_hash !== fingerprint) {
    return { ok: false, error: "dossier-audit-stale" };
  }
  if (!scores.fit || !scores.evidence || scores.fit.evidence_hash !== fingerprint
    || scores.evidence.evidence_hash !== fingerprint) {
    return { ok: false, error: "dossier-scores-stale" };
  }
  if (!passesQueueThreshold(scores.fit, scores.evidence)) {
    return { ok: false, error: "below-queue-threshold" };
  }
  const usedIds = new Set(parseJsonColumn(draft.evidence_ids, []));
  const used = evidence.filter((item) => usedIds.has(item.id));
  if (used.length !== usedIds.size || used.some((item) => item.reviewer_state !== "accepted"
    || !["first-party", "authoritative-directory"].includes(item.strength)
    || item.contradiction_state === "contradicted")) {
    return { ok: false, error: "draft-evidence-no-longer-eligible" };
  }
  return { ok: true, fingerprint, evidence, people };
}

async function outreachPolicy(env, organizationId, outreachKind, excludeDraftId = "") {
  const anySent = await one(env.DB,
    `SELECT id, draft_id, occurred_at FROM contact_attempts
     WHERE organization_id = ? AND status = 'sent'
     ORDER BY occurred_at ASC LIMIT 1`, organizationId);
  const sentInitial = await one(env.DB,
    `SELECT occurred_at FROM contact_attempts a
     JOIN outreach_drafts d ON d.id = a.draft_id
     WHERE a.organization_id = ? AND a.status = 'sent' AND d.outreach_kind = 'initial'
     ORDER BY a.occurred_at ASC LIMIT 1`, organizationId);
  const terminal = await one(env.DB,
    `SELECT occurred_at FROM contact_attempts WHERE organization_id = ?
     AND status IN ('replied','positive-reply','opted-out','closed') ORDER BY occurred_at DESC LIMIT 1`, organizationId);
  const existing = await one(env.DB,
    `SELECT id, status FROM outreach_drafts WHERE organization_id = ? AND outreach_kind = ?
     AND id != ? AND status != 'killed' LIMIT 1`, organizationId, outreachKind, excludeDraftId);
  if (existing) return { ok: false, error: `existing-${outreachKind}`, draft_id: existing.id };
  if (outreachKind === "initial") {
    if (anySent) return { ok: false, error: "initial-already-sent" };
    return { ok: true };
  }
  if (!sentInitial) return { ok: false, error: "follow-up-no-initial-send" };
  if (terminal) return { ok: false, error: "follow-up-conversation-closed" };
  const eligibleAt = new Date(new Date(sentInitial.occurred_at).getTime() + 7 * 86_400_000);
  if (Date.now() < eligibleAt.getTime()) {
    return { ok: false, error: "follow-up-too-early", eligible_at: eligibleAt.toISOString() };
  }
  return { ok: true, eligible_at: eligibleAt.toISOString() };
}

/**
 * Record outreach that happened outside Reachwright (for example, an earlier
 * LinkedIn message). This records history; it never sends anything. Once
 * stored, the organization-wide policy refuses another initial draft.
 */
async function recordExternalContact({ request, env }) {
  const body = await readBody(request, env);
  const check = validateBody(body, {
    campaign_id: { type: "string", required: true, max: 60 },
    organization_id: { type: "string", required: true, max: 60 },
    person_id: { type: "string", max: 60 },
    channel: { type: "string", required: true, enum: ["linkedin-manual", "email", "dm", "phone"] },
    contacted_on: { type: "string", required: true, pattern: /^\d{4}-\d{2}-\d{2}$/ },
    notes: { type: "string", required: true, max: LIMITS.mediumText },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const value = check.value;
  const date = new Date(`${value.contacted_on}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value.contacted_on
    || value.contacted_on > nowIso().slice(0, 10)) {
    return json(env, { error: "invalid-contact-date" }, 422);
  }
  const org = await one(env.DB, "SELECT id FROM organizations WHERE id = ?", value.organization_id);
  const campaign = await one(env.DB, "SELECT id FROM campaigns WHERE id = ?", value.campaign_id);
  if (!org || !campaign) return error(env, 404, "not-found");
  if (!(await organizationInCampaign(env, value.organization_id, value.campaign_id))) {
    return json(env, { error: "organization-not-in-campaign" }, 409);
  }
  const person = value.person_id ? await one(env.DB, "SELECT * FROM people WHERE id = ?", value.person_id) : null;
  if (value.person_id && (!person || person.organization_id !== value.organization_id)) {
    return json(env, { error: "person-organization-mismatch" }, 409);
  }
  const duplicate = await one(env.DB,
    `SELECT id FROM contact_attempts WHERE campaign_id = ? AND organization_id = ?
     AND draft_id IS NULL AND channel = ? AND status = 'sent' AND occurred_at LIKE ? LIMIT 1`,
    value.campaign_id, value.organization_id, value.channel, `${value.contacted_on}%`);
  if (duplicate) return json(env, { error: "external-contact-already-recorded", attempt_id: duplicate.id }, 409);

  const id = makeId("t");
  await run(env.DB,
    `INSERT INTO contact_attempts (id, campaign_id, organization_id, person_id, draft_id,
       channel, direction, status, notes, occurred_at)
     VALUES (?, ?, ?, ?, NULL, ?, 'outbound', 'sent', ?, ?)`,
    id, value.campaign_id, value.organization_id, value.person_id || null,
    value.channel, value.notes, date.toISOString());
  await run(env.DB,
    `UPDATE outreach_drafts SET status = 'killed', updated_at = ?
     WHERE organization_id = ? AND status IN ('draft','approved')`,
    nowIso(), value.organization_id);
  await audit(env.DB, { action: "attempt.external-contact", subjectType: "attempt", subjectId: id,
    detail: { campaign_id: value.campaign_id, channel: value.channel, contacted_on: value.contacted_on } });
  return json(env, { attempt_id: id, status: "sent", source: "external" }, 201);
}

async function createDraft({ request, env }) {
  const body = await readBody(request, env);
  const check = validateBody(body, {
    campaign_id: { type: "string", required: true, max: 60 },
    organization_id: { type: "string", required: true, max: 60 },
    person_id: { type: "string", max: 60 },
    channel: { type: "string", required: true, enum: ["linkedin-manual", "email", "dm", "phone"] },
    outreach_kind: { type: "string", enum: ["initial", "follow-up"], default: "initial" },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const { campaign_id, organization_id, person_id, channel, outreach_kind } = check.value;

  const campaign = await one(env.DB, "SELECT * FROM campaigns WHERE id = ?", campaign_id);
  const org = await one(env.DB, "SELECT * FROM organizations WHERE id = ?", organization_id);
  if (!campaign || !org) return error(env, 404, "not-found");
  if (!(await organizationInCampaign(env, organization_id, campaign_id))) {
    return json(env, { error: "organization-not-in-campaign" }, 409);
  }
  const dossierAudit = await latestDossierAudit(env, campaign_id, organization_id);
  if (dossierAudit?.verdict !== "accurate") {
    return json(env, { error: "dossier-not-accurate", latest_verdict: dossierAudit?.verdict ?? null }, 409);
  }
  if (!dossierAuditChecklistComplete(dossierAudit)) {
    return json(env, { error: "dossier-audit-checklist-required" }, 409);
  }
  const [campaignEvidence, organizationPeople] = await Promise.all([
    all(env.DB, "SELECT * FROM evidence_items WHERE organization_id = ? AND campaign_id = ?",
      organization_id, campaign_id),
    all(env.DB, "SELECT * FROM people WHERE organization_id = ?", organization_id),
  ]);
  const evidenceHash = await dossierFingerprint(campaignEvidence, organizationPeople);
  if (!dossierAudit.evidence_hash || dossierAudit.evidence_hash !== evidenceHash) {
    return json(env, { error: "dossier-changed-since-audit" }, 409);
  }
  const scores = await latestCampaignScores(env, campaign_id, organization_id);
  if (!scores.fit || !scores.evidence) {
    return json(env, { error: "scores-required", thresholds: DEFAULT_THRESHOLDS }, 409);
  }
  if (scores.fit.evidence_hash !== evidenceHash || scores.evidence.evidence_hash !== evidenceHash) {
    return json(env, { error: "scores-stale", thresholds: DEFAULT_THRESHOLDS }, 409);
  }
  if (!passesQueueThreshold(scores.fit, scores.evidence)) {
    const effective = (score) => Number.isInteger(score.override_total) ? score.override_total : score.total;
    return json(env, {
      error: "below-queue-threshold", thresholds: DEFAULT_THRESHOLDS,
      scores: { fit: effective(scores.fit), evidence: effective(scores.evidence) },
    }, 409);
  }
  if (!parseJsonColumn(campaign.allowed_channels, []).includes(channel)) {
    return json(env, { error: "channel-not-allowed" }, 409);
  }
  let person = person_id ? organizationPeople.find((item) => item.id === person_id) : null;
  if (person_id && !person) return error(env, 404, "not-found");
  if (!person_id) {
    const eligible = organizationPeople.filter((item) => contactForChannel(item, channel));
    if (eligible.length === 1) person = eligible[0];
    else return json(env, {
      error: eligible.length === 0 ? "channel-contact-required" : "person-selection-required",
      channel, eligible_people: eligible.map((item) => item.id),
    }, 409);
  }
  if (person.organization_id !== organization_id) {
    return json(env, { error: "person-organization-mismatch" }, 409);
  }
  if (person?.do_not_contact) return json(env, { error: "do-not-contact" }, 409);
  const contact = contactForChannel(person, channel);
  if (!contact) {
    return json(env, { error: "channel-contact-required", channel, person_id: person.id }, 409);
  }

  const sup = await prospectSuppression(env, org, person);
  if (sup.suppressed) return json(env, { error: "suppressed", matches: sup.matches }, 409);
  const policy = await outreachPolicy(env, organization_id, outreach_kind);
  if (!policy.ok) return json(env, policy, 409);

  const evidence = campaignEvidence.filter((item) => item.reviewer_state === "accepted");
  const assembled = assembleDraft({ campaign, organization: org, person, evidence, channel });
  if (!assembled.ok) {
    return json(env, { error: assembled.reason === INSUFFICIENT ? "insufficient-evidence" : "draft-failed", detail: assembled.reason }, 422);
  }

  const hash = await contentHash(assembled.body);
  const id = makeId("d");
  const now = nowIso();
  await run(env.DB,
    `INSERT INTO outreach_drafts (id, campaign_id, organization_id, person_id, channel, outreach_kind, evidence_ids,
       model_provider, model_version, prompt_version, body, content_hash, status, editor_history, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'deterministic-template', 'n/a', ?, ?, ?, 'draft', ?, ?, ?)`,
    id, campaign_id, organization_id, person.id, channel, outreach_kind,
    JSON.stringify(assembled.evidence_ids), PROMPT_VERSION, assembled.body, hash,
    JSON.stringify([{ at: now, actor: "operator", content_hash: hash, note: "created" }]), now, now);
  await audit(env.DB, { action: "draft.create", subjectType: "draft", subjectId: id, detail: { channel, outreach_kind, evidence_ids: assembled.evidence_ids } });
  return json(env, { draft_id: id, body: assembled.body, content_hash: hash, evidence_ids: assembled.evidence_ids }, 201);
}

async function listDrafts({ env, url }) {
  const status = url.searchParams.get("status");
  const select = `SELECT d.*, o.display_name AS organization_name, p.full_name AS person_name,
                  c.name AS campaign_name
                  FROM outreach_drafts d
                  JOIN organizations o ON o.id = d.organization_id
                  JOIN campaigns c ON c.id = d.campaign_id
                  LEFT JOIN people p ON p.id = d.person_id`;
  const rows = status
    ? await all(env.DB, `${select} WHERE d.status = ? ORDER BY d.updated_at DESC LIMIT 200`, status)
    : await all(env.DB, `${select} ORDER BY d.updated_at DESC LIMIT 200`);
  return json(env, { drafts: rows });
}

function auditPacketSnapshot(row) {
  if (!row) return null;
  return {
    id: row.id,
    verdict: row.verdict,
    notes: row.notes,
    auditor: row.auditor,
    audited_at: row.audited_at,
    evidence_hash: row.evidence_hash,
    checklist: parseJsonColumn(row.checklist, {}),
  };
}

function scorePacketSnapshot(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    total: row.total,
    override_total: Number.isInteger(row.override_total) ? row.override_total : null,
    override_reason: row.override_reason || "",
    override_by: row.override_by || "",
    rule_version: row.rule_version,
    factors: parseJsonColumn(row.factors, []),
    disqualifiers: parseJsonColumn(row.disqualifiers, []),
    scored_at: row.scored_at,
    evidence_hash: row.evidence_hash,
  };
}

function evidencePacketSnapshot(items) {
  return [...items].sort((a, b) => a.id.localeCompare(b.id)).map((item) => ({
    id: item.id,
    person_id: item.person_id || null,
    claim: item.claim,
    source_url: item.source_url,
    observed_at: item.observed_at,
    strength: item.strength,
    reviewer_state: item.reviewer_state,
    contradiction_state: item.contradiction_state,
  }));
}

/** The exact packet the approver must see, with its own hash. */
async function approvalPacket(env, draft) {
  const [org, person, campaign] = await Promise.all([
    one(env.DB, "SELECT * FROM organizations WHERE id = ?", draft.organization_id),
    draft.person_id ? one(env.DB, "SELECT * FROM people WHERE id = ?", draft.person_id) : null,
    one(env.DB, "SELECT * FROM campaigns WHERE id = ?", draft.campaign_id),
  ]);
  const evidenceIds = parseJsonColumn(draft.evidence_ids, []);
  const evidence = [];
  for (const evidenceId of evidenceIds) {
    const item = await one(env.DB,
      `SELECT id, claim, source_url, observed_at, strength, reviewer_state, contradiction_state
       FROM evidence_items WHERE id = ?`, evidenceId);
    if (item) evidence.push(item);
  }
  const [campaignEvidence, people, dossierAudit, scores] = await Promise.all([
    all(env.DB, "SELECT * FROM evidence_items WHERE organization_id = ? AND campaign_id = ?",
      draft.organization_id, draft.campaign_id),
    all(env.DB, "SELECT * FROM people WHERE organization_id = ?", draft.organization_id),
    latestDossierAudit(env, draft.campaign_id, draft.organization_id),
    latestCampaignScores(env, draft.campaign_id, draft.organization_id),
  ]);
  const dossierFingerprintValue = await dossierFingerprint(campaignEvidence, people);
  const sup = await prospectSuppression(env, org, person);
  const prior = await one(env.DB,
    "SELECT COUNT(*) AS n FROM contact_attempts WHERE organization_id = ? AND direction = 'outbound'",
    draft.organization_id);
  const packet = {
    draft_id: draft.id,
    recipient: person ? {
      name: person.full_name, title: person.title, email: person.business_email,
      phone: person.business_phone, profile: person.public_profile_url,
    } : null,
    company: org ? { name: org.display_name, domain: org.normalized_domain, location: org.location } : null,
    campaign: campaign ? { id: campaign.id, name: campaign.name } : null,
    channel: draft.channel,
    contact_for_channel: contactForChannel(person, draft.channel),
    exact_message: draft.body,
    content_hash: draft.content_hash,
    dossier_fingerprint: dossierFingerprintValue,
    dossier_state: {
      fingerprint: dossierFingerprintValue,
      audit: auditPacketSnapshot(dossierAudit),
      scores: {
        fit: scorePacketSnapshot(scores.fit),
        evidence: scorePacketSnapshot(scores.evidence),
      },
      evidence: evidencePacketSnapshot(campaignEvidence),
    },
    evidence_used: evidence,
    suppression: sup,
    prior_contact_count: prior?.n ?? 0,
    confirm_question: "Have you contacted this business anywhere outside Reachwright?",
  };
  return { packet, packet_hash: await contentHash(JSON.stringify(packet)) };
}

async function getPacket({ env, params }) {
  const draft = await one(env.DB, "SELECT * FROM outreach_drafts WHERE id = ?", params.id);
  if (!draft) return error(env, 404, "not-found");
  const { packet, packet_hash } = await approvalPacket(env, draft);
  return json(env, { packet, packet_hash });
}

async function editDraft({ request, env, params }) {
  const draft = await one(env.DB, "SELECT * FROM outreach_drafts WHERE id = ?", params.id);
  if (!draft) return error(env, 404, "not-found");
  if (["exported", "sent"].includes(draft.status)) return json(env, { error: "immutable-after-export" }, 409);
  const body = await readBody(request, env);
  const check = validateBody(body, { body: { type: "string", required: true, max: LIMITS.longText } });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);

  const hash = await contentHash(check.value.body);
  const history = parseJsonColumn(draft.editor_history, []);
  history.push({ at: nowIso(), actor: "operator", content_hash: hash, note: "edited" });
  // ANY edit returns the draft to `draft` — an approval never covers changed text.
  await run(env.DB,
    `UPDATE outreach_drafts SET body = ?, content_hash = ?, status = 'draft',
       approved_at = NULL, approved_by = NULL, editor_history = ?, updated_at = ? WHERE id = ?`,
    check.value.body, hash, JSON.stringify(history), nowIso(), params.id);
  if (draft.status === "approved" || draft.status === "ready-to-send") {
    await run(env.DB,
      `INSERT INTO approval_events (id, subject_type, subject_id, action, actor, reason, created_at)
       VALUES (?, 'draft', ?, 'revoke', 'system', 'edit invalidated approval', ?)`,
      makeId("a"), params.id, nowIso());
  }
  await audit(env.DB, { action: "draft.edit", subjectType: "draft", subjectId: params.id, detail: { content_hash: hash, approval_invalidated: draft.status !== "draft" } });
  return json(env, { draft_id: params.id, status: "draft", content_hash: hash });
}

async function approveDraft({ request, env, params }) {
  const draft = await one(env.DB, "SELECT * FROM outreach_drafts WHERE id = ?", params.id);
  if (!draft) return error(env, 404, "not-found");
  if (draft.status !== "draft") return json(env, { error: "not-in-draft" }, 409);
  const body = await readBody(request, env);
  const check = validateBody(body, {
    packet_hash: { type: "string", required: true, max: 128 },
    contacted_elsewhere: { type: "string", required: true, enum: ["no", "yes"] },
    reason: { type: "string", max: LIMITS.mediumText, default: "" },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);

  const dossierGate = await currentDraftDossierGate(env, draft);
  if (!dossierGate.ok) return json(env, { error: dossierGate.error }, 409);

  // Approval binds to the EXACT packet the operator saw.
  const { packet_hash } = await approvalPacket(env, draft);
  if (check.value.packet_hash !== packet_hash) {
    return json(env, { error: "packet-stale", detail: "record changed since the packet was shown — re-open it" }, 409);
  }

  // Suppression checkpoint 2 (at approval).
  const org = await one(env.DB, "SELECT * FROM organizations WHERE id = ?", draft.organization_id);
  const person = draft.person_id ? await one(env.DB, "SELECT * FROM people WHERE id = ?", draft.person_id) : null;
  const contact = contactForChannel(person, draft.channel);
  if (!contact) return json(env, { error: "channel-contact-required", channel: draft.channel }, 409);
  const sup = await prospectSuppression(env, org, person);
  if (sup.suppressed) return json(env, { error: "suppressed", matches: sup.matches }, 409);

  if (check.value.contacted_elsewhere === "yes") {
    return json(env, { error: "contacted-elsewhere", detail: "record the prior contact as an attempt first, then re-review" }, 409);
  }
  const policy = await outreachPolicy(env, draft.organization_id, draft.outreach_kind, draft.id);
  if (!policy.ok) return json(env, policy, 409);

  const now = nowIso();
  await run(env.DB,
    "UPDATE outreach_drafts SET status = 'approved', approved_at = ?, approved_by = 'operator', updated_at = ? WHERE id = ?",
    now, now, params.id);
  await run(env.DB,
    `INSERT INTO approval_events (id, subject_type, subject_id, action, actor, reason, packet_hash, contacted_elsewhere_answer, created_at)
     VALUES (?, 'draft', ?, 'approve', 'operator', ?, ?, ?, ?)`,
    makeId("a"), params.id, check.value.reason, packet_hash, check.value.contacted_elsewhere, now);
  await audit(env.DB, { action: "draft.approve", subjectType: "draft", subjectId: params.id, detail: { packet_hash } });
  return json(env, { draft_id: params.id, status: "approved" });
}

async function rejectDraft({ request, env, params }) {
  const draft = await one(env.DB, "SELECT * FROM outreach_drafts WHERE id = ?", params.id);
  if (!draft) return error(env, 404, "not-found");
  const body = await readBody(request, env);
  const check = validateBody(body, { reason: { type: "string", required: true, max: LIMITS.mediumText } });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  await run(env.DB, "UPDATE outreach_drafts SET status = 'killed', updated_at = ? WHERE id = ?", nowIso(), params.id);
  await run(env.DB,
    `INSERT INTO approval_events (id, subject_type, subject_id, action, actor, reason, created_at)
     VALUES (?, 'draft', ?, 'reject', 'operator', ?, ?)`,
    makeId("a"), params.id, check.value.reason, nowIso());
  await audit(env.DB, { action: "draft.reject", subjectType: "draft", subjectId: params.id, detail: { reason: check.value.reason } });
  return json(env, { draft_id: params.id, status: "killed" });
}

async function invalidateDraftApproval(env, draft, reason) {
  const now = nowIso();
  await run(env.DB,
    `UPDATE outreach_drafts SET status = 'draft', approved_at = NULL, approved_by = NULL, updated_at = ?
     WHERE id = ? AND status = 'approved'`, now, draft.id);
  await run(env.DB,
    `INSERT INTO approval_events (id, subject_type, subject_id, action, actor, reason, created_at)
     VALUES (?, 'draft', ?, 'revoke', 'system', ?, ?)`,
    makeId("a"), draft.id, reason, now);
  await audit(env.DB, { action: "draft.approval-invalidated", subjectType: "draft", subjectId: draft.id,
    detail: { reason } });
}

/**
 * Export approved drafts as CSV. NO SENDING HAPPENS HERE OR ANYWHERE.
 * Email-channel drafts are blocked until the CAN-SPAM gate passes.
 * Suppression checkpoint 3 runs per draft immediately before inclusion.
 */
async function exportDrafts({ request, env }) {
  const body = await readBody(request, env);
  const check = validateBody(body, {
    draft_ids: { type: "array", required: true, maxItems: 50, items: { type: "string", max: 60 } },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);

  const rows = [];
  const blocked = [];
  for (const draftId of check.value.draft_ids) {
    const draft = await one(env.DB, "SELECT * FROM outreach_drafts WHERE id = ?", draftId);
    if (!draft || draft.status !== "approved") { blocked.push({ draftId, reason: "not-approved" }); continue; }
    if (draft.channel === "email" && env.EMAIL_GATE_PASSED !== "true") {
      blocked.push({ draftId, reason: "email-gate" }); continue;
    }
    const org = await one(env.DB, "SELECT * FROM organizations WHERE id = ?", draft.organization_id);
    const person = draft.person_id ? await one(env.DB, "SELECT * FROM people WHERE id = ?", draft.person_id) : null;
    const contact = contactForChannel(person, draft.channel);
    if (!contact) {
      await invalidateDraftApproval(env, draft, "channel contact changed or is missing");
      blocked.push({ draftId, reason: "channel-contact-required" }); continue;
    }
    const sup = await prospectSuppression(env, org, person);
    if (sup.suppressed) { blocked.push({ draftId, reason: "suppressed" }); continue; }
    const policy = await outreachPolicy(env, draft.organization_id, draft.outreach_kind, draft.id);
    if (!policy.ok) { blocked.push({ draftId, reason: policy.error }); continue; }

    // Rebuild the complete current packet first. This binds export to the
    // approved recipient/contact plus the exact audit, score, and evidence
    // state that was reviewed, even when a replacement row has equal values.
    const latestApproval = await one(env.DB,
      `SELECT action, packet_hash FROM approval_events WHERE subject_type = 'draft' AND subject_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`, draft.id);
    const currentPacket = await approvalPacket(env, draft);
    if (latestApproval?.action !== "approve" || !latestApproval.packet_hash
      || latestApproval.packet_hash !== currentPacket.packet_hash) {
      await invalidateDraftApproval(env, draft, "approval packet changed before export");
      blocked.push({ draftId, reason: "packet-stale" }); continue;
    }
    const dossierGate = await currentDraftDossierGate(env, draft);
    if (!dossierGate.ok) {
      await invalidateDraftApproval(env, draft, dossierGate.error);
      blocked.push({ draftId, reason: dossierGate.error }); continue;
    }

    rows.push({
      company: org?.display_name ?? "", domain: org?.normalized_domain ?? "",
      recipient: person?.full_name ?? "", title: person?.title ?? "",
      contact,
      channel: draft.channel, message: draft.body, content_hash: draft.content_hash,
    });
    const now = nowIso();
    await run(env.DB, "UPDATE outreach_drafts SET status = 'exported', updated_at = ? WHERE id = ?", now, draftId);
    await run(env.DB,
      `INSERT INTO contact_attempts (id, campaign_id, organization_id, person_id, draft_id, channel, direction, status, content_hash, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, 'outbound', 'exported', ?, ?)`,
      makeId("t"), draft.campaign_id, draft.organization_id, draft.person_id || null, draftId,
      draft.channel, draft.content_hash, now);
  }
  await audit(env.DB, { action: "export.run", subjectType: "export", subjectId: makeId("a"), detail: { exported: rows.length, blocked } });
  const csv = toCsv(["company", "domain", "recipient", "title", "contact", "channel", "message", "content_hash"], rows);
  return json(env, { exported: rows.length, blocked, csv });
}

async function addSuppression({ request, env }) {
  const body = await readBody(request, env);
  const check = validateBody(body, {
    key_type: { type: "string", required: true, enum: ["email", "domain", "phone", "handle", "org", "alias"] },
    key_value: { type: "string", required: true, max: LIMITS.shortText },
    reason: { type: "string", required: true, max: LIMITS.mediumText },
    source_channel: { type: "string", max: 40, default: "" },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const normalized = normalizeSuppressionValue(check.value.key_type, check.value.key_value);
  if (!normalized) return json(env, { error: "unnormalizable-value" }, 422);
  await run(env.DB,
    `INSERT OR IGNORE INTO suppression_entries (id, key_type, key_value, reason, source_channel, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    makeId("x"), check.value.key_type, normalized, check.value.reason, check.value.source_channel, nowIso());
  await audit(env.DB, { action: "suppression.add", subjectType: "suppression", subjectId: normalized, detail: { key_type: check.value.key_type } });
  return json(env, { ok: true, key_type: check.value.key_type, key_value: normalized }, 201);
}

async function listSuppression({ env }) {
  const rows = await all(env.DB, "SELECT * FROM suppression_entries ORDER BY created_at DESC LIMIT 500");
  return json(env, { entries: rows });
}

/** Record a contact outcome. Opt-outs expand to all known channels. */
async function recordAttempt({ request, env }) {
  const body = await readBody(request, env);
  const check = validateBody(body, {
    campaign_id: { type: "string", required: true, max: 60 },
    organization_id: { type: "string", required: true, max: 60 },
    person_id: { type: "string", max: 60 },
    draft_id: { type: "string", max: 60 },
    channel: { type: "string", required: true, max: 40 },
    direction: { type: "string", required: true, enum: ["outbound", "inbound"] },
    status: { type: "string", required: true, enum: ["prepared", "exported", "sent", "replied", "positive-reply", "opted-out", "bounced", "closed"] },
    notes: { type: "string", max: LIMITS.mediumText, default: "" },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const value = check.value;
  const org = await one(env.DB, "SELECT * FROM organizations WHERE id = ?", value.organization_id);
  if (!org) return error(env, 404, "not-found");
  const campaign = await one(env.DB, "SELECT id FROM campaigns WHERE id = ?", value.campaign_id);
  if (!campaign) return error(env, 404, "campaign-not-found");
  const person = value.person_id ? await one(env.DB, "SELECT * FROM people WHERE id = ?", value.person_id) : null;
  if (value.person_id && (!person || person.organization_id !== value.organization_id)) {
    return json(env, { error: "person-organization-mismatch" }, 409);
  }
  const draft = value.draft_id ? await one(env.DB, "SELECT * FROM outreach_drafts WHERE id = ?", value.draft_id) : null;
  if (value.draft_id && (!draft || draft.organization_id !== value.organization_id
    || draft.campaign_id !== value.campaign_id || (value.person_id && draft.person_id !== value.person_id))) {
    return json(env, { error: "attempt-draft-mismatch" }, 409);
  }
  if (["prepared", "exported"].includes(value.status)) {
    return json(env, { error: "system-managed-attempt-status" }, 409);
  }
  if (value.status === "sent" && value.direction !== "outbound") {
    return json(env, { error: "attempt-direction-mismatch" }, 409);
  }
  if (["replied", "positive-reply", "opted-out", "bounced", "closed"].includes(value.status)
    && value.direction !== "inbound") {
    return json(env, { error: "attempt-direction-mismatch" }, 409);
  }
  if (value.status === "sent") {
    if (!draft || draft.status !== "exported") return json(env, { error: "draft-not-exported" }, 409);
    const priorSent = await one(env.DB,
      "SELECT id FROM contact_attempts WHERE draft_id = ? AND status = 'sent' LIMIT 1", draft.id);
    if (priorSent) return json(env, { error: "already-recorded-sent" }, 409);
  }
  if (["replied", "positive-reply", "opted-out", "bounced", "closed"].includes(value.status)) {
    const sent = await one(env.DB,
      `SELECT id FROM contact_attempts WHERE organization_id = ? AND campaign_id = ?
       AND status = 'sent' LIMIT 1`, value.organization_id, value.campaign_id);
    if (!sent) return json(env, { error: "outcome-without-send" }, 409);
    const duplicateOutcome = await one(env.DB,
      `SELECT id FROM contact_attempts WHERE organization_id = ? AND campaign_id = ? AND status = ? LIMIT 1`,
      value.organization_id, value.campaign_id, value.status);
    if (duplicateOutcome) return json(env, { error: "outcome-already-recorded", attempt_id: duplicateOutcome.id }, 409);
  }

  const id = makeId("t");
  await run(env.DB,
    `INSERT INTO contact_attempts (id, campaign_id, organization_id, person_id, draft_id, channel, direction, status, notes, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, value.campaign_id, value.organization_id, value.person_id || null, value.draft_id || null,
    value.channel, value.direction, value.status, value.notes, nowIso());

  if (value.status === "sent" && value.draft_id) {
    await run(env.DB, "UPDATE outreach_drafts SET status = 'sent', updated_at = ? WHERE id = ?", nowIso(), value.draft_id);
  }
  if (value.status === "opted-out") {
    const entries = expandOptOut(
      { organization: { domain: org.normalized_domain, name: org.normalized_name }, person: person ?? {} },
      "opt-out", value.channel,
    );
    for (const entry of entries) {
      await run(env.DB,
        `INSERT OR IGNORE INTO suppression_entries (id, key_type, key_value, reason, source_channel, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        makeId("x"), entry.key_type, entry.key_value, entry.reason, entry.source_channel, nowIso());
    }
    if (person) await run(env.DB, "UPDATE people SET do_not_contact = 1, updated_at = ? WHERE id = ?", nowIso(), person.id);
  }
  await audit(env.DB, { action: "attempt.record", subjectType: "attempt", subjectId: id, detail: { status: value.status, channel: value.channel } });
  return json(env, { attempt_id: id }, 201);
}

export const outreachRoutes = [
  ["POST", "/api/drafts", createDraft],
  ["GET", "/api/drafts", listDrafts],
  ["GET", "/api/drafts/:id/packet", getPacket],
  ["PATCH", "/api/drafts/:id", editDraft],
  ["POST", "/api/drafts/:id/approve", approveDraft],
  ["POST", "/api/drafts/:id/reject", rejectDraft],
  ["POST", "/api/exports", exportDrafts],
  ["POST", "/api/suppression", addSuppression],
  ["GET", "/api/suppression", listSuppression],
  ["POST", "/api/attempts/external", recordExternalContact],
  ["POST", "/api/attempts", recordAttempt],
];
