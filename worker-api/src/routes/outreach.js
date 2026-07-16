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

async function createDraft({ request, env }) {
  const body = await readBody(request, env);
  const check = validateBody(body, {
    campaign_id: { type: "string", required: true, max: 60 },
    organization_id: { type: "string", required: true, max: 60 },
    person_id: { type: "string", max: 60 },
    channel: { type: "string", required: true, enum: ["linkedin-manual", "email", "dm", "phone"] },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const { campaign_id, organization_id, person_id, channel } = check.value;

  const campaign = await one(env.DB, "SELECT * FROM campaigns WHERE id = ?", campaign_id);
  const org = await one(env.DB, "SELECT * FROM organizations WHERE id = ?", organization_id);
  if (!campaign || !org) return error(env, 404, "not-found");
  const person = person_id ? await one(env.DB, "SELECT * FROM people WHERE id = ?", person_id) : null;
  if (person_id && !person) return error(env, 404, "not-found");
  if (person?.do_not_contact) return json(env, { error: "do-not-contact" }, 409);
  if (!parseJsonColumn(campaign.allowed_channels, []).includes(channel)) {
    return json(env, { error: "channel-not-allowed" }, 409);
  }

  const sup = await prospectSuppression(env, org, person);
  if (sup.suppressed) return json(env, { error: "suppressed", matches: sup.matches }, 409);

  const evidence = await all(env.DB,
    "SELECT * FROM evidence_items WHERE organization_id = ? AND reviewer_state = 'accepted'", org.id);
  const assembled = assembleDraft({ campaign, organization: org, person, evidence, channel });
  if (!assembled.ok) {
    return json(env, { error: assembled.reason === INSUFFICIENT ? "insufficient-evidence" : "draft-failed", detail: assembled.reason }, 422);
  }

  const hash = await contentHash(assembled.body);
  const id = makeId("d");
  const now = nowIso();
  await run(env.DB,
    `INSERT INTO outreach_drafts (id, campaign_id, organization_id, person_id, channel, evidence_ids,
       model_provider, model_version, prompt_version, body, content_hash, status, editor_history, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'deterministic-template', 'n/a', ?, ?, ?, 'draft', ?, ?, ?)`,
    id, campaign_id, organization_id, person_id || null, channel,
    JSON.stringify(assembled.evidence_ids), PROMPT_VERSION, assembled.body, hash,
    JSON.stringify([{ at: now, actor: "operator", content_hash: hash, note: "created" }]), now, now);
  await audit(env.DB, { action: "draft.create", subjectType: "draft", subjectId: id, detail: { channel, evidence_ids: assembled.evidence_ids } });
  return json(env, { draft_id: id, body: assembled.body, content_hash: hash, evidence_ids: assembled.evidence_ids }, 201);
}

async function listDrafts({ env, url }) {
  const status = url.searchParams.get("status");
  const rows = status
    ? await all(env.DB, "SELECT * FROM outreach_drafts WHERE status = ? ORDER BY updated_at DESC LIMIT 200", status)
    : await all(env.DB, "SELECT * FROM outreach_drafts ORDER BY updated_at DESC LIMIT 200");
  return json(env, { drafts: rows });
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
    const item = await one(env.DB, "SELECT id, claim, source_url, observed_at, strength FROM evidence_items WHERE id = ?", evidenceId);
    if (item) evidence.push(item);
  }
  const sup = await prospectSuppression(env, org, person);
  const prior = await one(env.DB,
    "SELECT COUNT(*) AS n FROM contact_attempts WHERE organization_id = ? AND direction = 'outbound'",
    draft.organization_id);
  const packet = {
    draft_id: draft.id,
    recipient: person ? { name: person.full_name, title: person.title, email: person.business_email, profile: person.public_profile_url } : null,
    company: org ? { name: org.display_name, domain: org.normalized_domain, location: org.location } : null,
    campaign: campaign ? { id: campaign.id, name: campaign.name } : null,
    channel: draft.channel,
    exact_message: draft.body,
    content_hash: draft.content_hash,
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

  // Approval binds to the EXACT packet the operator saw.
  const { packet_hash } = await approvalPacket(env, draft);
  if (check.value.packet_hash !== packet_hash) {
    return json(env, { error: "packet-stale", detail: "record changed since the packet was shown — re-open it" }, 409);
  }

  // Suppression checkpoint 2 (at approval).
  const org = await one(env.DB, "SELECT * FROM organizations WHERE id = ?", draft.organization_id);
  const person = draft.person_id ? await one(env.DB, "SELECT * FROM people WHERE id = ?", draft.person_id) : null;
  const sup = await prospectSuppression(env, org, person);
  if (sup.suppressed) return json(env, { error: "suppressed", matches: sup.matches }, 409);

  if (check.value.contacted_elsewhere === "yes") {
    return json(env, { error: "contacted-elsewhere", detail: "record the prior contact as an attempt first, then re-review" }, 409);
  }

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
    const sup = await prospectSuppression(env, org, person);
    if (sup.suppressed) { blocked.push({ draftId, reason: "suppressed" }); continue; }

    rows.push({
      company: org?.display_name ?? "", domain: org?.normalized_domain ?? "",
      recipient: person?.full_name ?? "", title: person?.title ?? "",
      contact: draft.channel === "email" ? (person?.business_email ?? "") : (person?.public_profile_url ?? ""),
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
  const person = value.person_id ? await one(env.DB, "SELECT * FROM people WHERE id = ?", value.person_id) : null;

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
  ["POST", "/api/attempts", recordAttempt],
];
