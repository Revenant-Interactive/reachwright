/**
 * Research routes — Scout's engine room.
 *
 * Flow: preview (credits, no call) → search (capped, metered, deduped,
 * suppression-checked before expansion) → people → evidence → scoring.
 * Provider records become internal records immediately; nothing downstream
 * touches provider response shapes.
 */

import { json, error, readBody } from "../index.js";
import { all, audit, one, run, parseJsonColumn } from "../db.js";
import { makeId, nowIso, today, validateBody, LIMITS } from "../lib/validate.js";
import { getProvider, providerStatus } from "../providers/registry.js";
import { identityKeys, normalizeDomain, normalizeName } from "../lib/normalize.js";
import { findDuplicate, mergedIdentityKeys } from "../lib/dedupe.js";
import { suppressionKeysFor, checkSuppression } from "../lib/suppression.js";
import {
  deriveEvidenceInputs, scoreEvidence, scoreFit, RULE_VERSION,
} from "../lib/scoring.js";
import { briefComplete } from "./campaigns.js";

const searchSchema = {
  locations: { type: "array", items: { type: "string", max: LIMITS.shortText }, default: [] },
  keywords: { type: "array", items: { type: "string", max: LIMITS.shortText }, default: [] },
  employeeRanges: { type: "array", items: { type: "string", max: 20 }, default: [] },
  name: { type: "string", max: LIMITS.shortText },
  batch: { type: "number", integer: true, min: 1, max: 100 },
};

async function creditCeilingRemaining(env) {
  const ceiling = Number.parseInt(env.PROVIDER_CREDIT_CEILING || "0", 10);
  if (!ceiling) return Infinity;
  const month = new Date().toISOString().slice(0, 7);
  const row = await one(env.DB,
    "SELECT COALESCE(SUM(credits_estimated), 0) AS used FROM provider_usage WHERE occurred_at LIKE ?",
    `${month}%`);
  return ceiling - (row?.used ?? 0);
}

async function previewSearch({ request, env, params }) {
  const campaign = await one(env.DB, "SELECT * FROM campaigns WHERE id = ?", params.id);
  if (!campaign) return error(env, 404, "not-found");
  const provider = getProvider(env);
  if (!provider) return json(env, { error: "provider-not-configured", provider: providerStatus(env) }, 503);
  const body = await readBody(request, env);
  const check = validateBody(body ?? {}, searchSchema);
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const batch = Math.min(check.value.batch ?? campaign.max_batch_size, campaign.max_batch_size);
  const estimate = provider.estimateCredits({ operation: "searchOrganizations", pages: 1, perPage: batch });
  const remaining = await creditCeilingRemaining(env);
  return json(env, {
    provider: provider.name,
    query: { ...check.value, batch },
    estimate,
    credit_ceiling_remaining: remaining === Infinity ? null : remaining,
    would_exceed_ceiling: estimate.estimated > remaining,
  });
}

async function runSearch({ request, env, params }) {
  const campaign = await one(env.DB, "SELECT * FROM campaigns WHERE id = ?", params.id);
  if (!campaign) return error(env, 404, "not-found");
  if (!briefComplete(campaign)) return json(env, { error: "brief-incomplete" }, 409);
  if (campaign.status !== "researching") {
    return json(env, { error: "campaign-not-researching", detail: "set status to researching first" }, 409);
  }
  const provider = getProvider(env);
  if (!provider) return json(env, { error: "provider-not-configured", provider: providerStatus(env) }, 503);

  const body = await readBody(request, env);
  const check = validateBody(body ?? {}, searchSchema);
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const batch = Math.min(check.value.batch ?? campaign.max_batch_size, campaign.max_batch_size);

  const estimate = provider.estimateCredits({ operation: "searchOrganizations", pages: 1, perPage: batch });
  const remaining = await creditCeilingRemaining(env);
  if (estimate.estimated > remaining) {
    return json(env, { error: "credit-ceiling", estimate, remaining }, 409);
  }

  const result = await provider.searchOrganizations({ ...check.value, perPage: batch });
  if (result.error) return json(env, { error: "provider-failure", detail: result.error }, 502);

  await run(env.DB,
    `INSERT INTO provider_usage (id, provider, operation, request_count, credits_estimated, campaign_id, occurred_at)
     VALUES (?, ?, ?, 1, ?, ?, ?)`,
    makeId("u"), provider.name, "searchOrganizations", estimate.estimated, campaign.id, nowIso());

  const existing = await all(env.DB,
    "SELECT id, identity_keys, merge_state, normalized_domain, normalized_name FROM organizations");
  const suppressionRows = await all(env.DB, "SELECT key_type, key_value, reason, expires_at FROM suppression_entries");

  const summary = { stored: 0, merged: 0, suppressed: 0, skipped: 0 };
  const storedIds = [];

  for (const record of result.records.slice(0, batch)) {
    const domain = normalizeDomain(record.domain);
    const name = normalizeName(record.name);
    if (!name && !domain) { summary.skipped += 1; continue; }

    // Suppression BEFORE research expands (playbook checkpoint 1).
    const supKeys = suppressionKeysFor({ organization: { domain, name: record.name } });
    const supCheck = checkSuppression(supKeys, suppressionRows);
    if (supCheck.suppressed) { summary.suppressed += 1; continue; }

    const dup = findDuplicate(
      { domain: record.domain, name: record.name, location: record.location, phone: record.phone },
      existing,
    );
    if (dup.match) {
      // Merge: refresh keys + last_verified; evidence attaches to the canonical record.
      const keys = mergedIdentityKeys(dup.match.identity_keys, identityKeys({
        domain: record.domain, name: record.name, location: record.location, phone: record.phone,
      }));
      await run(env.DB,
        "UPDATE organizations SET identity_keys = ?, last_verified = ?, updated_at = ? WHERE id = ?",
        JSON.stringify(keys), today(), nowIso(), dup.match.id);
      summary.merged += 1;
      storedIds.push(dup.match.id);
      continue;
    }

    const id = makeId("o");
    const keys = identityKeys({ domain: record.domain, name: record.name, location: record.location, phone: record.phone });
    await run(env.DB,
      `INSERT INTO organizations (id, normalized_domain, normalized_name, display_name, location, country,
         provider, provider_id, identity_keys, merge_state, first_seen, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      id, domain || null, name, record.name, record.location || "", record.country || "",
      record.provider, record.provider_id, JSON.stringify(keys), today(), nowIso(), nowIso());
    existing.push({ id, identity_keys: keys, merge_state: "active", normalized_domain: domain, normalized_name: name });

    // Provider provenance is itself an evidence item (strength: secondary —
    // licensed directory data still needs first-party corroboration).
    await run(env.DB,
      `INSERT INTO evidence_items (id, organization_id, campaign_id, claim, source_url, observed_at,
         source_type, strength, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'provider', 'secondary', ?)`,
      makeId("e"), id, campaign.id,
      `${provider.name} lists ${record.name}${record.industry ? ` (${record.industry})` : ""}${record.employee_count ? `, ~${record.employee_count} employees` : ""}${record.location ? `, ${record.location}` : ""}`,
      record.source_url || `provider:${provider.name}`, record.observed_at, nowIso());

    summary.stored += 1;
    storedIds.push(id);
  }

  await audit(env.DB, {
    action: "research.search", subjectType: "campaign", subjectId: campaign.id,
    detail: { provider: provider.name, batch, ...summary },
  });
  return json(env, { summary, organization_ids: storedIds, provider: provider.name });
}

async function searchPeopleForOrg({ request, env, params }) {
  const org = await one(env.DB, "SELECT * FROM organizations WHERE id = ?", params.id);
  if (!org) return error(env, 404, "not-found");
  const provider = getProvider(env);
  if (!provider) return json(env, { error: "provider-not-configured" }, 503);
  const body = await readBody(request, env);
  const check = validateBody(body ?? {}, {
    titles: { type: "array", items: { type: "string", max: LIMITS.shortText }, default: [] },
    seniorities: { type: "array", items: { type: "string", max: 40 }, default: [] },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);

  const result = await provider.searchPeople(
    { provider_id: org.provider_id, domain: org.normalized_domain },
    { titles: check.value.titles, seniorities: check.value.seniorities, perPage: 10 },
  );
  if (result.error) return json(env, { error: "provider-failure", detail: result.error }, 502);

  await run(env.DB,
    `INSERT INTO provider_usage (id, provider, operation, request_count, credits_estimated, occurred_at)
     VALUES (?, ?, 'searchPeople', 1, 0, ?)`, makeId("u"), provider.name, nowIso());

  const stored = [];
  for (const person of result.records) {
    const id = makeId("p");
    await run(env.DB,
      `INSERT INTO people (id, organization_id, full_name, title, seniority, business_email, email_status,
         business_phone, public_profile_url, source_provider, provider_id, observed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, org.id, person.full_name, person.title, person.seniority, person.business_email,
      person.email_status, person.business_phone, person.public_profile_url,
      person.provider, person.provider_id, person.observed_at, nowIso(), nowIso());
    stored.push(id);
  }
  await audit(env.DB, { action: "research.people", subjectType: "organization", subjectId: org.id, detail: { count: stored.length } });
  return json(env, { people_ids: stored, count: stored.length });
}

async function addEvidence({ request, env, params }) {
  const org = await one(env.DB, "SELECT id FROM organizations WHERE id = ?", params.id);
  if (!org) return error(env, 404, "not-found");
  const body = await readBody(request, env);
  const check = validateBody(body, {
    claim: { type: "string", required: true, max: LIMITS.mediumText },
    source_url: { type: "string", required: true, max: LIMITS.url, pattern: /^https?:\/\// },
    observed_at: { type: "string", required: true, pattern: /^\d{4}-\d{2}-\d{2}$/, max: 10 },
    strength: { type: "string", required: true, enum: ["first-party", "authoritative-directory", "secondary", "weak"] },
    campaign_id: { type: "string", max: 60 },
    person_id: { type: "string", max: 60 },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const value = check.value;
  const id = makeId("e");
  await run(env.DB,
    `INSERT INTO evidence_items (id, organization_id, person_id, campaign_id, claim, source_url, observed_at,
       source_type, strength, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, params.id, value.person_id || null, value.campaign_id || null, value.claim,
    value.source_url, value.observed_at, value.strength, value.strength, nowIso());
  await run(env.DB, "UPDATE organizations SET last_verified = ?, updated_at = ? WHERE id = ?", today(), nowIso(), params.id);
  await audit(env.DB, { action: "evidence.add", subjectType: "organization", subjectId: params.id, detail: { evidence_id: id } });
  return json(env, { evidence_id: id }, 201);
}

async function reviewEvidence({ request, env, params }) {
  const item = await one(env.DB, "SELECT * FROM evidence_items WHERE id = ?", params.id);
  if (!item) return error(env, 404, "not-found");
  const body = await readBody(request, env);
  const check = validateBody(body, {
    reviewer_state: { type: "string", enum: ["unreviewed", "accepted", "rejected"] },
    contradiction_state: { type: "string", enum: ["none", "contradicted", "resolved"] },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const reviewer = check.value.reviewer_state ?? item.reviewer_state;
  const contradiction = check.value.contradiction_state ?? item.contradiction_state;
  await run(env.DB, "UPDATE evidence_items SET reviewer_state = ?, contradiction_state = ? WHERE id = ?",
    reviewer, contradiction, params.id);
  await audit(env.DB, { action: "evidence.review", subjectType: "evidence", subjectId: params.id, detail: check.value });
  return json(env, { ok: true });
}

/**
 * Score an organization for a campaign. Fit inputs are the operator's explicit
 * judgments (each 0..1); evidence inputs derive deterministically from stored
 * evidence. Both rows persist with rule version + factor breakdown.
 */
async function scoreOrganization({ request, env, params }) {
  const campaign = await one(env.DB, "SELECT * FROM campaigns WHERE id = ?", params.cid);
  const org = await one(env.DB, "SELECT * FROM organizations WHERE id = ?", params.oid);
  if (!campaign || !org) return error(env, 404, "not-found");
  const body = await readBody(request, env);
  const check = validateBody(body, {
    fit_inputs: { type: "object", required: true },
    disqualifiers: { type: "array", default: [], items: { type: "object" } },
    contact_verified: { type: "boolean", default: false },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);

  const evidence = await all(env.DB, "SELECT * FROM evidence_items WHERE organization_id = ?", org.id);
  const fit = scoreFit(check.value.fit_inputs, check.value.disqualifiers);
  const evidenceScore = scoreEvidence(
    deriveEvidenceInputs(evidence, { contactVerified: check.value.contact_verified, today: today() }),
  );

  for (const [kind, score] of [["fit", fit], ["evidence", evidenceScore]]) {
    await run(env.DB,
      `INSERT INTO fit_scores (id, campaign_id, organization_id, kind, total, rule_version, factors, disqualifiers, scored_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      makeId("s"), campaign.id, org.id, kind, score.total, RULE_VERSION,
      JSON.stringify(score.factors), JSON.stringify(score.disqualifiers), nowIso());
  }
  await audit(env.DB, {
    action: "research.score", subjectType: "organization", subjectId: org.id,
    detail: { campaign: campaign.id, fit: fit.total, evidence: evidenceScore.total, rule_version: RULE_VERSION },
  });
  return json(env, { fit, evidence: evidenceScore, rule_version: RULE_VERSION });
}

async function overrideScore({ request, env, params }) {
  const row = await one(env.DB, "SELECT * FROM fit_scores WHERE id = ?", params.id);
  if (!row) return error(env, 404, "not-found");
  const body = await readBody(request, env);
  const check = validateBody(body, {
    override_total: { type: "number", required: true, integer: true, min: 0, max: 100 },
    override_reason: { type: "string", required: true, max: LIMITS.mediumText },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  // Overrides never erase the original score (playbook): stored beside it.
  await run(env.DB,
    "UPDATE fit_scores SET override_total = ?, override_reason = ?, override_by = 'operator' WHERE id = ?",
    check.value.override_total, check.value.override_reason, params.id);
  await audit(env.DB, { action: "score.override", subjectType: "score", subjectId: params.id, detail: check.value });
  return json(env, { ok: true });
}

/** Research queue: latest scores per org for a campaign + states the reviewer needs. */
async function researchQueue({ env, params }) {
  const campaign = await one(env.DB, "SELECT * FROM campaigns WHERE id = ?", params.id);
  if (!campaign) return error(env, 404, "not-found");
  const orgs = await all(env.DB,
    `SELECT DISTINCT o.* FROM organizations o
     LEFT JOIN fit_scores s ON s.organization_id = o.id AND s.campaign_id = ?
     LEFT JOIN evidence_items e ON e.organization_id = o.id AND e.campaign_id = ?
     WHERE (s.id IS NOT NULL OR e.id IS NOT NULL) AND o.merge_state != 'merged'
     ORDER BY o.updated_at DESC LIMIT 200`, campaign.id, campaign.id);
  const suppressionRows = await all(env.DB, "SELECT key_type, key_value, reason, expires_at FROM suppression_entries");

  const queue = [];
  for (const org of orgs) {
    const scores = await all(env.DB,
      `SELECT * FROM fit_scores WHERE campaign_id = ? AND organization_id = ? ORDER BY scored_at DESC`,
      campaign.id, org.id);
    const latest = (kind) => scores.find((s) => s.kind === kind) ?? null;
    const evidence = await all(env.DB,
      "SELECT id, strength, observed_at, reviewer_state, contradiction_state FROM evidence_items WHERE organization_id = ?",
      org.id);
    const sup = checkSuppression(
      suppressionKeysFor({ organization: { domain: org.normalized_domain, name: org.normalized_name } }),
      suppressionRows,
    );
    const unknownFields = [];
    if (!org.normalized_domain) unknownFields.push("domain");
    if (!org.location) unknownFields.push("location");
    if (!org.last_verified) unknownFields.push("last_verified");
    const staleDays = org.last_verified
      ? Math.floor((Date.now() - new Date(`${org.last_verified}T00:00:00Z`)) / 86_400_000)
      : null;
    queue.push({
      organization: org,
      fit: latest("fit"),
      evidence_score: latest("evidence"),
      evidence_counts: {
        total: evidence.length,
        accepted: evidence.filter((e) => e.reviewer_state === "accepted").length,
        contradicted: evidence.filter((e) => e.contradiction_state === "contradicted").length,
      },
      evidence_freshness_days: staleDays,
      stale: staleDays === null || staleDays > 60,
      duplicate_state: org.merge_state,
      suppression: sup,
      unknown_fields: unknownFields,
    });
  }
  return json(env, { campaign: campaign.id, queue });
}

/** Full dossier for one organization. */
async function dossier({ env, params }) {
  const org = await one(env.DB, "SELECT * FROM organizations WHERE id = ?", params.id);
  if (!org) return error(env, 404, "not-found");
  const [people, evidence, scores, drafts, attempts] = await Promise.all([
    all(env.DB, "SELECT * FROM people WHERE organization_id = ?", org.id),
    all(env.DB, "SELECT * FROM evidence_items WHERE organization_id = ? ORDER BY observed_at DESC", org.id),
    all(env.DB, "SELECT * FROM fit_scores WHERE organization_id = ? ORDER BY scored_at DESC LIMIT 10", org.id),
    all(env.DB, "SELECT * FROM outreach_drafts WHERE organization_id = ? ORDER BY created_at DESC", org.id),
    all(env.DB, "SELECT * FROM contact_attempts WHERE organization_id = ? ORDER BY occurred_at DESC", org.id),
  ]);
  const suppressionRows = await all(env.DB, "SELECT key_type, key_value, reason, expires_at FROM suppression_entries");
  const sup = checkSuppression(
    suppressionKeysFor({ organization: { domain: org.normalized_domain, name: org.normalized_name } }),
    suppressionRows,
  );
  return json(env, {
    organization: { ...org, identity_keys: parseJsonColumn(org.identity_keys, []) },
    people, evidence,
    scores: scores.map((s) => ({ ...s, factors: parseJsonColumn(s.factors, []), disqualifiers: parseJsonColumn(s.disqualifiers, []) })),
    drafts, contact_attempts: attempts, suppression: sup,
  });
}

export const researchRoutes = [
  ["POST", "/api/campaigns/:id/preview-search", previewSearch],
  ["POST", "/api/campaigns/:id/search", runSearch],
  ["GET", "/api/campaigns/:id/queue", researchQueue],
  ["POST", "/api/organizations/:id/people", searchPeopleForOrg],
  ["POST", "/api/organizations/:id/evidence", addEvidence],
  ["PATCH", "/api/evidence/:id", reviewEvidence],
  ["GET", "/api/organizations/:id/dossier", dossier],
  ["POST", "/api/campaigns/:cid/organizations/:oid/score", scoreOrganization],
  ["POST", "/api/scores/:id/override", overrideScore],
];
