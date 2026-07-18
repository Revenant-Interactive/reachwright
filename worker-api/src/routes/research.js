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
import { makeId, nowIso, today, validObservedDate, validateBody, LIMITS } from "../lib/validate.js";
import { getProvider, providerStatus } from "../providers/registry.js";
import { identityKeys, normalizeDomain, normalizeName } from "../lib/normalize.js";
import { findDuplicate, mergedIdentityKeys } from "../lib/dedupe.js";
import { suppressionKeysFor, checkSuppression } from "../lib/suppression.js";
import {
  deriveEvidenceInputs, scoreEvidence, scoreFit, passesQueueThreshold, RULE_VERSION,
} from "../lib/scoring.js";
import {
  dossierAuditChecklistComplete, dossierFingerprint, REQUIRED_DOSSIER_AUDIT_CHECKS,
} from "../lib/dossier.js";
import { hasAllowedContact } from "../lib/contact.js";
import { briefComplete } from "./campaigns.js";

const searchSchema = {
  locations: { type: "array", items: { type: "string", max: LIMITS.shortText }, default: [] },
  keywords: { type: "array", items: { type: "string", max: LIMITS.shortText }, default: [] },
  employeeRanges: { type: "array", items: { type: "string", max: 20 }, default: [] },
  name: { type: "string", max: LIMITS.shortText },
  batch: { type: "number", integer: true, min: 1, max: 100 },
  start_page: { type: "number", integer: true, min: 1, max: 500, default: 1 },
  continuation_token: { type: "string", max: 512, default: "" },
};

const PROVIDER_PAGE_CAP = 25;

/** Build a constant-size page plan so a requested batch can traverse beyond
 * Apollo's first page without skipping or repeating records. */
function providerSearchPlan(batch, startPage = 1, continuationPageSize = null) {
  const requested = Math.max(1, Math.min(100, Number(batch) || 1));
  let pages;
  let perPage;
  if (continuationPageSize) {
    perPage = Number(continuationPageSize);
    if (!Number.isInteger(perPage) || perPage < 1 || perPage > PROVIDER_PAGE_CAP
      || requested % perPage !== 0 || requested / perPage > 4) {
      return { error: "continuation-batch-incompatible", requested, page_size: perPage };
    }
    pages = requested / perPage;
  } else if (requested <= PROVIDER_PAGE_CAP) {
    pages = 1;
    perPage = requested;
  } else {
    const minimumPages = Math.ceil(requested / PROVIDER_PAGE_CAP);
    pages = [minimumPages, minimumPages + 1, minimumPages + 2, minimumPages + 3]
      .find((candidate) => candidate <= 4 && requested % candidate === 0
        && requested / candidate <= PROVIDER_PAGE_CAP);
    if (!pages) {
      return { error: "batch-not-page-stable", requested,
        valid_examples: [25, 30, 40, 50, 60, 75, 80, 100] };
    }
    perPage = requested / pages;
  }
  const start = Math.max(1, Math.min(500, Number(startPage) || 1));
  const availablePages = 501 - start;
  return { requested, pages: Math.min(pages, availablePages), perPage, startPage: start };
}

function providerSearchEstimate(provider, batch, startPage, pagesOverride, continuationPageSize = null) {
  const plan = providerSearchPlan(batch, startPage, continuationPageSize);
  if (plan.error) return { plan, estimate: null };
  const pages = pagesOverride ?? plan.pages;
  return {
    plan,
    estimate: provider.estimateCredits({
      operation: "searchOrganizations", pages, perPage: plan.perPage,
    }),
  };
}

function searchContext(value) {
  return {
    locations: value.locations || [], keywords: value.keywords || [],
    employeeRanges: value.employeeRanges || [], name: value.name || "",
  };
}

async function searchContextHash(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(searchContext(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function encodeContinuation(value) {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeContinuation(token) {
  try {
    const base64 = token.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const value = JSON.parse(atob(padded));
    return value && typeof value === "object" ? value : null;
  } catch { return null; }
}

async function resolveContinuation(value) {
  if (value.start_page === 1) {
    return value.continuation_token
      ? { ok: false, error: "continuation-token-unexpected" }
      : { ok: true, pageSize: null, contextHash: await searchContextHash(value) };
  }
  if (!value.continuation_token) return { ok: false, error: "continuation-token-required" };
  const cursor = decodeContinuation(value.continuation_token);
  const contextHash = await searchContextHash(value);
  if (!cursor || cursor.next_page !== value.start_page || cursor.context_hash !== contextHash) {
    return { ok: false, error: "continuation-token-mismatch" };
  }
  return { ok: true, pageSize: cursor.page_size, contextHash };
}

const manualOrganizationSchema = {
  display_name: { type: "string", required: true, max: LIMITS.shortText },
  domain: { type: "string", max: LIMITS.url, default: "" },
  location: { type: "string", required: true, max: LIMITS.shortText },
  country: { type: "string", max: LIMITS.shortText, default: "US" },
  phone: { type: "string", max: LIMITS.shortText, default: "" },
  campaign_id: { type: "string", required: true, max: 60 },
  source_url: { type: "string", required: true, max: LIMITS.url, pattern: /^https?:\/\// },
  source_strength: { type: "string", enum: ["first-party", "authoritative-directory", "secondary", "weak"], default: "authoritative-directory" },
  observed_at: { type: "string", required: true, pattern: /^\d{4}-\d{2}-\d{2}$/, max: 10 },
  claim: { type: "string", max: LIMITS.mediumText, default: "" },
  evidence_reviewed: { type: "boolean", default: false },
  contact_name: { type: "string", max: LIMITS.shortText, default: "" },
  contact_title: { type: "string", max: LIMITS.shortText, default: "" },
  contact_email: { type: "string", max: LIMITS.shortText, default: "" },
  contact_phone: { type: "string", max: LIMITS.shortText, default: "" },
  contact_source_url: { type: "string", max: LIMITS.url, pattern: /^https?:\/\//, default: "" },
};

async function organizationInCampaign(env, organizationId, campaignId) {
  return Boolean(await one(env.DB,
    "SELECT id FROM evidence_items WHERE organization_id = ? AND campaign_id = ? LIMIT 1",
    organizationId, campaignId));
}

async function refreshOrganizationVerifiedDate(env, organizationId) {
  const latest = await one(env.DB,
    `SELECT MAX(observed_at) AS verified_at FROM evidence_items
     WHERE organization_id = ? AND reviewer_state = 'accepted'
     AND strength IN ('first-party','authoritative-directory')`, organizationId);
  await run(env.DB, "UPDATE organizations SET last_verified = ?, updated_at = ? WHERE id = ?",
    latest?.verified_at || null, nowIso(), organizationId);
}

async function createManualOrganization({ request, env }) {
  const body = await readBody(request, env);
  const check = validateBody(body, manualOrganizationSchema);
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const value = check.value;
  if (!validObservedDate(value.observed_at)) {
    return json(env, { error: "invalid-observed-date" }, 422);
  }
  if (!value.contact_name && (value.contact_title || value.contact_email || value.contact_phone || value.contact_source_url)) {
    return json(env, { error: "validation", details: ["contact_name is required when contact details are provided"] }, 422);
  }
  if (value.contact_name && !value.contact_title) {
    return json(env, { error: "validation", details: ["contact_title is required for a decision-maker"] }, 422);
  }
  if (value.contact_name && !value.contact_email && !value.contact_phone && !value.contact_source_url) {
    return json(env, { error: "validation", details: ["a business email, business phone, or usable public contact profile is required"] }, 422);
  }
  const campaign = await one(env.DB, "SELECT id FROM campaigns WHERE id = ?", value.campaign_id);
  if (!campaign) return error(env, 404, "campaign-not-found");
  const domain = normalizeDomain(value.domain);
  const name = normalizeName(value.display_name);
  const candidate = { domain, name: value.display_name, location: value.location, phone: value.phone };
  const suppressionRows = await all(env.DB, "SELECT key_type, key_value, reason, expires_at FROM suppression_entries");
  const sup = checkSuppression(suppressionKeysFor({
    organization: candidate,
    person: value.contact_name ? {
      full_name: value.contact_name, business_email: value.contact_email,
      business_phone: value.contact_phone, public_profile_url: value.contact_source_url || value.source_url,
    } : {},
  }), suppressionRows);
  if (sup.suppressed) return json(env, { error: "suppressed", matches: sup.matches }, 409);
  const existing = await all(env.DB,
    "SELECT id, identity_keys, merge_state, normalized_domain, normalized_name FROM organizations");
  const duplicate = findDuplicate(candidate, existing);
  if (duplicate.match) {
    return json(env, { error: "duplicate", organization_id: duplicate.match.id, reasons: duplicate.reasons }, 409);
  }
  const id = makeId("o");
  const now = nowIso();
  const keys = identityKeys(candidate);
  await run(env.DB,
    `INSERT INTO organizations (id, normalized_domain, normalized_name, display_name, location, country,
       provider, provider_id, identity_keys, merge_state, first_seen, last_verified, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'manual', '', ?, 'active', ?, ?, ?, ?)`,
    id, domain || null, name, value.display_name, value.location, value.country,
    JSON.stringify(keys), today(), null, now, now);
  const personId = value.contact_name ? makeId("p") : null;
  if (personId) {
    await run(env.DB,
      `INSERT INTO people (id, organization_id, full_name, title, business_email, email_status,
         business_phone, public_profile_url, source_provider, observed_at, verification_state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, 'unverified', ?, ?)`,
      personId, id, value.contact_name, value.contact_title, value.contact_email,
      "unknown", value.contact_phone,
      value.contact_source_url, value.observed_at, now, now);
  }
  const evidenceId = makeId("e");
  const claim = value.claim || `Manual identity record for ${value.display_name} at ${value.location}${domain ? ` (${domain})` : ""}`;
  const reviewerState = value.claim && value.evidence_reviewed ? "accepted" : "unreviewed";
  await run(env.DB,
    `INSERT INTO evidence_items (id, organization_id, person_id, campaign_id, claim, source_url, observed_at,
       source_type, strength, reviewer_state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    evidenceId, id, personId, value.campaign_id, claim,
    value.source_url, value.observed_at, value.source_strength, value.source_strength, reviewerState, now);
  await refreshOrganizationVerifiedDate(env, id);
  await audit(env.DB, { action: "organization.manual-create", subjectType: "organization", subjectId: id,
    detail: { campaign_id: value.campaign_id, evidence_id: evidenceId, person_id: personId, evidence_reviewed: reviewerState === "accepted" } });
  return json(env, { organization_id: id, evidence_id: evidenceId, person_id: personId }, 201);
}

async function createManualPerson({ request, env, params }) {
  const org = await one(env.DB, "SELECT * FROM organizations WHERE id = ?", params.id);
  if (!org) return error(env, 404, "not-found");
  const body = await readBody(request, env);
  const check = validateBody(body, {
    full_name: { type: "string", required: true, max: LIMITS.shortText },
    title: { type: "string", required: true, max: LIMITS.shortText },
    business_email: { type: "string", max: LIMITS.shortText, default: "" },
    business_phone: { type: "string", max: LIMITS.shortText, default: "" },
    public_profile_url: { type: "string", max: LIMITS.url, pattern: /^https?:\/\//, default: "" },
    observed_at: { type: "string", required: true, pattern: /^\d{4}-\d{2}-\d{2}$/, max: 10 },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const value = check.value;
  if (!validObservedDate(value.observed_at)) {
    return json(env, { error: "invalid-observed-date" }, 422);
  }
  if (!value.business_email && !value.business_phone && !value.public_profile_url) {
    return json(env, { error: "validation", details: ["a business email, business phone, or usable public contact profile is required"] }, 422);
  }
  const sup = await checkSuppression(
    suppressionKeysFor({ organization: { domain: org.normalized_domain, name: org.normalized_name }, person: value }),
    await all(env.DB, "SELECT key_type, key_value, reason, expires_at FROM suppression_entries"));
  if (sup.suppressed) return json(env, { error: "suppressed", matches: sup.matches }, 409);
  const duplicate = await one(env.DB,
    `SELECT id FROM people WHERE organization_id = ? AND
     (lower(full_name) = lower(?) OR (? != '' AND lower(business_email) = lower(?)) OR
      (? != '' AND business_phone = ?) OR lower(public_profile_url) = lower(?)) LIMIT 1`,
    org.id, value.full_name, value.business_email, value.business_email,
    value.business_phone, value.business_phone, value.public_profile_url);
  if (duplicate) return json(env, { error: "duplicate", person_id: duplicate.id }, 409);
  const id = makeId("p");
  const now = nowIso();
  await run(env.DB,
    `INSERT INTO people (id, organization_id, full_name, title, business_email, email_status,
       business_phone, public_profile_url, source_provider, observed_at, verification_state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, 'unverified', ?, ?)`,
    id, org.id, value.full_name, value.title, value.business_email,
    "unknown", value.business_phone,
    value.public_profile_url, value.observed_at, now, now);
  await audit(env.DB, { action: "person.manual-create", subjectType: "person", subjectId: id,
    detail: { organization_id: org.id, source_url: value.public_profile_url } });
  return json(env, { person_id: id }, 201);
}

async function updatePerson({ request, env, params }) {
  const person = await one(env.DB, "SELECT * FROM people WHERE id = ?", params.id);
  if (!person) return error(env, 404, "not-found");
  const org = await one(env.DB, "SELECT * FROM organizations WHERE id = ?", person.organization_id);
  if (!org) return error(env, 404, "not-found");
  const body = await readBody(request, env);
  const check = validateBody(body, {
    full_name: { type: "string", max: LIMITS.shortText },
    title: { type: "string", max: LIMITS.shortText },
    business_email: { type: "string", max: LIMITS.shortText },
    business_phone: { type: "string", max: LIMITS.shortText },
    public_profile_url: { type: "string", max: LIMITS.url, pattern: /^https?:\/\// },
    clear_fields: { type: "array", maxItems: 3, items: { type: "string",
      enum: ["business_email", "business_phone", "public_profile_url"] }, default: [] },
    observed_at: { type: "string", required: true, pattern: /^\d{4}-\d{2}-\d{2}$/, max: 10 },
    confirmed: { type: "boolean", required: true },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const value = check.value;
  if (!validObservedDate(value.observed_at)) return json(env, { error: "invalid-observed-date" }, 422);
  const clear = new Set(value.clear_fields);
  const candidate = {
    ...person,
    full_name: value.full_name ?? person.full_name,
    title: value.title ?? person.title,
    business_email: clear.has("business_email") ? "" : value.business_email ?? person.business_email,
    business_phone: clear.has("business_phone") ? "" : value.business_phone ?? person.business_phone,
    public_profile_url: clear.has("public_profile_url") ? "" : value.public_profile_url ?? person.public_profile_url,
  };
  if (!candidate.full_name || !candidate.title) {
    return json(env, { error: "validation", details: ["name and title are required"] }, 422);
  }
  if (!candidate.business_email && !candidate.business_phone && !candidate.public_profile_url) {
    return json(env, { error: "validation", details: ["at least one usable contact path is required"] }, 422);
  }
  const suppressionRows = await all(env.DB,
    "SELECT key_type, key_value, reason, expires_at FROM suppression_entries");
  const sup = checkSuppression(suppressionKeysFor({
    organization: { domain: org.normalized_domain, name: org.normalized_name }, person: candidate,
  }), suppressionRows);
  if (sup.suppressed) return json(env, { error: "suppressed", matches: sup.matches }, 409);
  const duplicate = await one(env.DB,
    `SELECT id FROM people WHERE organization_id = ? AND id != ? AND
     (lower(full_name) = lower(?) OR (? != '' AND lower(business_email) = lower(?)) OR
      (? != '' AND business_phone = ?) OR (? != '' AND lower(public_profile_url) = lower(?))) LIMIT 1`,
    person.organization_id, person.id, candidate.full_name,
    candidate.business_email, candidate.business_email,
    candidate.business_phone, candidate.business_phone,
    candidate.public_profile_url, candidate.public_profile_url);
  if (duplicate) return json(env, { error: "duplicate", person_id: duplicate.id }, 409);

  const now = nowIso();
  await run(env.DB,
    `UPDATE people SET full_name = ?, title = ?, business_email = ?,
       email_status = CASE WHEN ? = 1 AND ? != '' THEN 'operator-verified' ELSE email_status END,
       business_phone = ?, public_profile_url = ?, observed_at = ?, verification_state = ?, updated_at = ? WHERE id = ?`,
    candidate.full_name, candidate.title, candidate.business_email,
    value.confirmed ? 1 : 0, candidate.business_email, candidate.business_phone,
    candidate.public_profile_url, value.observed_at, value.confirmed ? "verified" : "unverified", now, person.id);
  const invalidated = await all(env.DB,
    "SELECT id, status FROM outreach_drafts WHERE person_id = ? AND status IN ('draft','approved')", person.id);
  await run(env.DB,
    `UPDATE outreach_drafts SET status = 'killed', approved_at = NULL, approved_by = NULL, updated_at = ?
     WHERE person_id = ? AND status IN ('draft','approved')`, now, person.id);
  for (const draft of invalidated.filter((item) => item.status === "approved")) {
    await run(env.DB,
      `INSERT INTO approval_events (id, subject_type, subject_id, action, actor, reason, created_at)
       VALUES (?, 'draft', ?, 'revoke', 'system', 'person correction invalidated approval', ?)`,
      makeId("a"), draft.id, now);
  }
  await audit(env.DB, { action: "person.correct", subjectType: "person", subjectId: person.id,
    detail: { confirmed: value.confirmed, drafts_invalidated: invalidated.length } });
  return json(env, { person_id: person.id, verification_state: value.confirmed ? "verified" : "unverified",
    drafts_invalidated: invalidated.length });
}

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
  const batch = Math.min(check.value.batch ?? campaign.max_batch_size, campaign.max_batch_size,
    Number(provider.maxSearchBatch) || campaign.max_batch_size);
  const continuation = await resolveContinuation(check.value);
  if (!continuation.ok) return json(env, { error: continuation.error }, 422);
  const { plan, estimate } = providerSearchEstimate(
    provider, batch, check.value.start_page, undefined, continuation.pageSize,
  );
  if (plan.error) return json(env, { error: plan.error, page_plan: plan }, 422);
  const remaining = await creditCeilingRemaining(env);
  return json(env, {
    provider: provider.name,
    query: { ...check.value, batch },
    page_plan: plan,
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
  const batch = Math.min(check.value.batch ?? campaign.max_batch_size, campaign.max_batch_size,
    Number(provider.maxSearchBatch) || campaign.max_batch_size);

  const continuation = await resolveContinuation(check.value);
  if (!continuation.ok) return json(env, { error: continuation.error }, 422);
  const { plan, estimate } = providerSearchEstimate(
    provider, batch, check.value.start_page, undefined, continuation.pageSize,
  );
  if (plan.error) return json(env, { error: plan.error, page_plan: plan }, 422);
  const remaining = await creditCeilingRemaining(env);
  if (estimate.estimated > remaining) {
    return json(env, { error: "credit-ceiling", estimate, remaining }, 409);
  }

  const records = [];
  let pagesFetched = 0;
  let providerTotalEntries = null;
  let lastPageFetched = null;
  for (let offset = 0; offset < plan.pages && records.length < batch; offset += 1) {
    const page = plan.startPage + offset;
    const result = await provider.searchOrganizations({ ...check.value, page, perPage: plan.perPage });
    pagesFetched += 1;
    lastPageFetched = page;
    if (result.error) {
      const partial = providerSearchEstimate(
        provider, batch, plan.startPage, pagesFetched, plan.perPage,
      ).estimate;
      await run(env.DB,
        `INSERT INTO provider_usage (id, provider, operation, request_count, credits_estimated, campaign_id, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        makeId("u"), provider.name, "searchOrganizations", pagesFetched,
        partial.estimated, campaign.id, nowIso());
      await audit(env.DB, { action: "research.search-failed", subjectType: "campaign", subjectId: campaign.id,
        detail: { provider: provider.name, batch, page, pages_fetched: pagesFetched, error: result.error } });
      return json(env, { error: "provider-failure", detail: result.error, failed_page: page }, 502);
    }
    records.push(...result.records);
    providerTotalEntries = result.pagination?.total_entries ?? providerTotalEntries;
    const totalPages = Number(result.pagination?.total_pages) || 0;
    if ((totalPages && page >= totalPages) || result.records.length < plan.perPage) break;
  }

  const actualEstimate = providerSearchEstimate(
    provider, batch, plan.startPage, pagesFetched, plan.perPage,
  ).estimate;

  await run(env.DB,
    `INSERT INTO provider_usage (id, provider, operation, request_count, credits_estimated, campaign_id, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    makeId("u"), provider.name, "searchOrganizations", pagesFetched,
    actualEstimate.estimated, campaign.id, nowIso());

  const existing = await all(env.DB,
    "SELECT id, identity_keys, merge_state, normalized_domain, normalized_name FROM organizations");
  const suppressionRows = await all(env.DB, "SELECT key_type, key_value, reason, expires_at FROM suppression_entries");

  const summary = { stored: 0, merged: 0, attached: 0, suppressed: 0, skipped: 0 };
  const storedIds = [];

  const attachProviderEvidence = async (organizationId, record) => {
    const claim = record.evidence_claim
      || `${provider.name} lists ${record.name}${record.industry ? ` (${record.industry})` : ""}${record.employee_count ? `, ~${record.employee_count} employees` : ""}${record.location ? `, ${record.location}` : ""}`;
    const sourceUrl = record.source_url || `provider:${provider.name}`;
    const duplicateEvidence = await one(env.DB,
      `SELECT id FROM evidence_items WHERE organization_id = ? AND campaign_id = ?
       AND claim = ? AND source_url = ? LIMIT 1`,
      organizationId, campaign.id, claim, sourceUrl);
    if (duplicateEvidence) return false;
    await run(env.DB,
      `INSERT INTO evidence_items (id, organization_id, campaign_id, claim, source_url, observed_at,
         source_type, strength, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'provider', 'secondary', ?)`,
      makeId("e"), organizationId, campaign.id, claim, sourceUrl, record.observed_at, nowIso());
    return true;
  };

  for (const record of records.slice(0, batch)) {
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
      // Merge identity keys, then attach this campaign's provider provenance to
      // the canonical record. A directory hit alone is not verification and
      // must not refresh last_verified.
      const keys = mergedIdentityKeys(dup.match.identity_keys, identityKeys({
        domain: record.domain, name: record.name, location: record.location, phone: record.phone,
      }));
      await run(env.DB,
        "UPDATE organizations SET identity_keys = ?, updated_at = ? WHERE id = ?",
        JSON.stringify(keys), nowIso(), dup.match.id);
      if (await attachProviderEvidence(dup.match.id, record)) summary.attached += 1;
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
    await attachProviderEvidence(id, record);

    summary.stored += 1;
    storedIds.push(id);
  }

  await audit(env.DB, {
    action: "research.search", subjectType: "campaign", subjectId: campaign.id,
    detail: { provider: provider.name, batch, pages_fetched: pagesFetched, ...summary },
  });
  const nextPage = lastPageFetched && (!providerTotalEntries
    || lastPageFetched * plan.perPage < providerTotalEntries) && lastPageFetched < 500
    ? lastPageFetched + 1 : null;
  return json(env, {
    summary, organization_ids: [...new Set(storedIds)], provider: provider.name,
    pagination: { requested: batch, pages_fetched: pagesFetched, per_page: plan.perPage,
      start_page: plan.startPage, last_page: lastPageFetched,
      next_page: nextPage,
      continuation_token: nextPage ? encodeContinuation({
        next_page: nextPage, page_size: plan.perPage, context_hash: continuation.contextHash,
      }) : null,
      provider_total_entries: providerTotalEntries },
  });
}

async function searchPeopleForOrg({ request, env, params }) {
  const org = await one(env.DB, "SELECT * FROM organizations WHERE id = ?", params.id);
  if (!org) return error(env, 404, "not-found");
  const provider = getProvider(env);
  if (!provider) return json(env, { error: "provider-not-configured" }, 503);
  const suppressionRowsBeforeSearch = await all(env.DB, "SELECT key_type, key_value, reason, expires_at FROM suppression_entries");
  const organizationSuppression = checkSuppression(suppressionKeysFor({
    organization: { domain: org.normalized_domain, name: org.normalized_name },
  }), suppressionRowsBeforeSearch);
  if (organizationSuppression.suppressed) {
    return json(env, { error: "suppressed", matches: organizationSuppression.matches }, 409);
  }
  const body = await readBody(request, env);
  const check = validateBody(body ?? {}, {
    titles: { type: "array", items: { type: "string", max: LIMITS.shortText }, default: [] },
    seniorities: { type: "array", items: { type: "string", max: 40 }, default: [] },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);

  const estimate = provider.estimateCredits({ operation: "searchPeople" });
  const remaining = await creditCeilingRemaining(env);
  if (estimate.estimated > remaining) {
    return json(env, { error: "credit-ceiling", estimate, remaining }, 409);
  }

  const result = await provider.searchPeople(
    { provider_id: org.provider_id, domain: org.normalized_domain },
    { titles: check.value.titles, seniorities: check.value.seniorities, perPage: 10 },
  );
  if (result.error) return json(env, { error: "provider-failure", detail: result.error }, 502);

  await run(env.DB,
    `INSERT INTO provider_usage (id, provider, operation, request_count, credits_estimated, occurred_at)
     VALUES (?, ?, 'searchPeople', 1, ?, ?)`, makeId("u"), provider.name, estimate.estimated, nowIso());

  const suppressionRows = await all(env.DB, "SELECT key_type, key_value, reason, expires_at FROM suppression_entries");
  const stored = [];
  const updated = [];
  let suppressed = 0;
  for (const person of result.records) {
    const sup = checkSuppression(suppressionKeysFor({
      organization: { domain: org.normalized_domain, name: org.normalized_name }, person,
    }), suppressionRows);
    if (sup.suppressed) { suppressed += 1; continue; }

    const duplicate = await one(env.DB,
      `SELECT id FROM people WHERE organization_id = ? AND (
         (? != '' AND source_provider = ? AND provider_id = ?) OR
         (? != '' AND lower(business_email) = lower(?)) OR
         (? != '' AND lower(public_profile_url) = lower(?)) OR
         (lower(full_name) = lower(?) AND lower(title) = lower(?))
       ) LIMIT 1`,
      org.id,
      person.provider_id, person.provider, person.provider_id,
      person.business_email, person.business_email,
      person.public_profile_url, person.public_profile_url,
      person.full_name, person.title);
    if (duplicate) {
      await run(env.DB,
        `UPDATE people SET
           full_name = CASE WHEN ? != '' THEN ? ELSE full_name END,
           title = CASE WHEN ? != '' THEN ? ELSE title END,
           seniority = CASE WHEN ? != '' THEN ? ELSE seniority END,
           business_email = CASE WHEN ? != '' THEN ? ELSE business_email END,
           email_status = CASE WHEN ? != '' THEN ? ELSE email_status END,
           public_profile_url = CASE WHEN ? != '' THEN ? ELSE public_profile_url END,
           source_provider = CASE WHEN ? != '' THEN ? ELSE source_provider END,
           provider_id = CASE WHEN ? != '' THEN ? ELSE provider_id END,
           observed_at = ?, updated_at = ? WHERE id = ?`,
        person.full_name, person.full_name, person.title, person.title,
        person.seniority, person.seniority, person.business_email, person.business_email,
        person.email_status, person.email_status, person.public_profile_url, person.public_profile_url,
        person.provider, person.provider, person.provider_id, person.provider_id,
        person.observed_at, nowIso(), duplicate.id);
      updated.push(duplicate.id);
      continue;
    }
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
  await audit(env.DB, { action: "research.people", subjectType: "organization", subjectId: org.id,
    detail: { stored: stored.length, updated: updated.length, suppressed } });
  return json(env, {
    people_ids: [...stored, ...updated], count: stored.length + updated.length,
    stored: stored.length, updated: updated.length, suppressed, estimate,
  });
}

async function enrichPersonFromProvider({ env, params }) {
  const person = await one(env.DB, "SELECT * FROM people WHERE id = ?", params.id);
  if (!person) return error(env, 404, "not-found");
  const org = await one(env.DB, "SELECT * FROM organizations WHERE id = ?", person.organization_id);
  if (!org) return error(env, 404, "not-found");
  const provider = getProvider(env);
  if (!provider) return json(env, { error: "provider-not-configured" }, 503);

  const currentSuppression = checkSuppression(suppressionKeysFor({
    organization: { domain: org.normalized_domain, name: org.normalized_name }, person,
  }), await all(env.DB, "SELECT key_type, key_value, reason, expires_at FROM suppression_entries"));
  if (currentSuppression.suppressed) {
    return json(env, { error: "suppressed", matches: currentSuppression.matches }, 409);
  }

  const estimate = provider.estimateCredits({ operation: "enrichPerson" });
  const remaining = await creditCeilingRemaining(env);
  if (estimate.estimated > remaining) {
    return json(env, { error: "credit-ceiling", estimate, remaining }, 409);
  }
  const result = await provider.enrichPerson({
    provider_id: person.provider_id, full_name: person.full_name,
    title: person.title, domain: org.normalized_domain, organization_name: org.display_name,
  });
  if (result.error) return json(env, { error: "provider-failure", detail: result.error }, 502);

  const enriched = result.record;
  const enrichedSuppression = checkSuppression(suppressionKeysFor({
    organization: { domain: org.normalized_domain, name: org.normalized_name }, person: enriched,
  }), await all(env.DB, "SELECT key_type, key_value, reason, expires_at FROM suppression_entries"));
  if (enrichedSuppression.suppressed) {
    await run(env.DB, "UPDATE people SET do_not_contact = 1, updated_at = ? WHERE id = ?", nowIso(), person.id);
    await audit(env.DB, { action: "research.person-enrich-suppressed", subjectType: "person", subjectId: person.id,
      detail: { provider: provider.name } });
    return json(env, { error: "suppressed", matches: enrichedSuppression.matches }, 409);
  }

  const verificationState = enriched.business_email && enriched.email_status === "verified" ? "verified" : "unverified";
  await run(env.DB,
    `UPDATE people SET
       full_name = CASE WHEN ? != '' THEN ? ELSE full_name END,
       title = CASE WHEN ? != '' THEN ? ELSE title END,
       seniority = CASE WHEN ? != '' THEN ? ELSE seniority END,
       business_email = CASE WHEN ? != '' THEN ? ELSE business_email END,
       email_status = CASE WHEN ? != '' THEN ? ELSE email_status END,
       public_profile_url = CASE WHEN ? != '' THEN ? ELSE public_profile_url END,
       source_provider = CASE WHEN ? != '' THEN ? ELSE source_provider END,
       provider_id = CASE WHEN ? != '' THEN ? ELSE provider_id END,
       observed_at = ?, verification_state = ?, updated_at = ? WHERE id = ?`,
    enriched.full_name, enriched.full_name, enriched.title, enriched.title,
    enriched.seniority, enriched.seniority, enriched.business_email, enriched.business_email,
    enriched.email_status, enriched.email_status, enriched.public_profile_url, enriched.public_profile_url,
    enriched.provider, enriched.provider, enriched.provider_id, enriched.provider_id,
    enriched.observed_at, verificationState, nowIso(), person.id);
  await run(env.DB,
    `INSERT INTO provider_usage (id, provider, operation, request_count, credits_estimated, occurred_at)
     VALUES (?, ?, 'enrichPerson', 1, ?, ?)`,
    makeId("u"), provider.name, estimate.estimated, nowIso());
  await audit(env.DB, { action: "research.person-enrich", subjectType: "person", subjectId: person.id,
    detail: { provider: provider.name, email_status: enriched.email_status || "unknown" } });
  return json(env, {
    person_id: person.id, business_email: enriched.business_email || person.business_email,
    email_status: enriched.email_status || person.email_status,
    verification_state: verificationState, estimate,
  });
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
    reviewer_state: { type: "string", enum: ["unreviewed", "accepted"], default: "unreviewed" },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const value = check.value;
  if (!validObservedDate(value.observed_at)) {
    return json(env, { error: "invalid-observed-date" }, 422);
  }
  if (value.campaign_id) {
    const campaign = await one(env.DB, "SELECT id FROM campaigns WHERE id = ?", value.campaign_id);
    if (!campaign) return error(env, 404, "campaign-not-found");
  }
  if (value.person_id) {
    const person = await one(env.DB, "SELECT id FROM people WHERE id = ? AND organization_id = ?", value.person_id, params.id);
    if (!person) return json(env, { error: "evidence-person-mismatch" }, 409);
  }
  const id = makeId("e");
  await run(env.DB,
    `INSERT INTO evidence_items (id, organization_id, person_id, campaign_id, claim, source_url, observed_at,
       source_type, strength, reviewer_state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, params.id, value.person_id || null, value.campaign_id || null, value.claim,
    value.source_url, value.observed_at, value.strength, value.strength, value.reviewer_state, nowIso());
  await refreshOrganizationVerifiedDate(env, params.id);
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
  await refreshOrganizationVerifiedDate(env, item.organization_id);
  await audit(env.DB, { action: "evidence.review", subjectType: "evidence", subjectId: params.id, detail: check.value });
  return json(env, { ok: true });
}

async function auditDossier({ request, env, params }) {
  const campaign = await one(env.DB, "SELECT * FROM campaigns WHERE id = ?", params.cid);
  const org = await one(env.DB, "SELECT * FROM organizations WHERE id = ?", params.oid);
  if (!campaign || !org) return error(env, 404, "not-found");
  if (!(await organizationInCampaign(env, params.oid, params.cid))) {
    return json(env, { error: "organization-not-in-campaign" }, 409);
  }
  const body = await readBody(request, env);
  const check = validateBody(body, {
    verdict: { type: "string", required: true, enum: ["accurate", "partly-accurate", "reject"] },
    notes: { type: "string", max: LIMITS.mediumText, default: "" },
    checklist: { type: "object", default: {} },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const id = makeId("a");
  const [evidence, people] = await Promise.all([
    all(env.DB, "SELECT * FROM evidence_items WHERE organization_id = ? AND campaign_id = ?", params.oid, params.cid),
    all(env.DB, "SELECT * FROM people WHERE organization_id = ?", params.oid),
  ]);
  if (check.value.verdict === "accurate") {
    if (check.value.notes.trim().length < 10) {
      return json(env, { error: "audit-notes-required", detail: "Record what was checked." }, 422);
    }
    const missingChecks = REQUIRED_DOSSIER_AUDIT_CHECKS.filter((name) => check.value.checklist?.[name] !== true);
    if (missingChecks.length) {
      return json(env, { error: "audit-checklist-incomplete", missing_checks: missingChecks }, 422);
    }
    const allowedChannels = parseJsonColumn(campaign.allowed_channels, []);
    const suppressionRows = await all(env.DB,
      "SELECT key_type, key_value, reason, expires_at FROM suppression_entries");
    const eligibleDecisionMakers = people.filter((person) => person.full_name && person.title
      && !person.do_not_contact && hasAllowedContact(person, allowedChannels)
      && !checkSuppression(suppressionKeysFor({
        organization: { domain: org.normalized_domain, name: org.normalized_name }, person,
      }), suppressionRows).suppressed);
    const hasDecisionMaker = eligibleDecisionMakers.length > 0;
    const hasContactPath = hasDecisionMaker;
    const unreviewed = evidence.filter((item) => item.reviewer_state === "unreviewed");
    const contradicted = evidence.filter((item) => item.contradiction_state === "contradicted");
    const acceptedStrong = evidence.filter((item) => item.reviewer_state === "accepted"
      && ["first-party", "authoritative-directory"].includes(item.strength));
    if (unreviewed.length || contradicted.length || acceptedStrong.length === 0
      || !hasDecisionMaker || !hasContactPath) {
      return json(env, {
        error: "audit-incomplete",
        unresolved: { unreviewed: unreviewed.length, contradicted: contradicted.length,
          accepted_strong: acceptedStrong.length, decision_maker: hasDecisionMaker,
          contact_path: hasContactPath },
      }, 409);
    }
  }
  const evidenceHash = await dossierFingerprint(evidence, people);
  await run(env.DB,
    `INSERT INTO dossier_audits (id, campaign_id, organization_id, verdict, notes, auditor, audited_at,
       evidence_hash, checklist)
     VALUES (?, ?, ?, ?, ?, 'operator', ?, ?, ?)`,
    id, params.cid, params.oid, check.value.verdict, check.value.notes, nowIso(), evidenceHash,
    JSON.stringify(check.value.checklist));
  await audit(env.DB, { action: "dossier.audit", subjectType: "dossier", subjectId: params.oid,
    detail: { campaign_id: params.cid, verdict: check.value.verdict } });
  return json(env, { audit_id: id, verdict: check.value.verdict, checklist: check.value.checklist }, 201);
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
  if (!(await organizationInCampaign(env, org.id, campaign.id))) {
    return json(env, { error: "organization-not-in-campaign" }, 409);
  }
  const body = await readBody(request, env);
  const check = validateBody(body, {
    fit_inputs: { type: "object", required: true },
    disqualifiers: { type: "array", default: [], items: { type: "object" } },
    contact_verified: { type: "boolean", default: false },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);

  const evidence = await all(env.DB,
    "SELECT * FROM evidence_items WHERE organization_id = ? AND campaign_id = ?", org.id, campaign.id);
  const people = await all(env.DB, "SELECT * FROM people WHERE organization_id = ?", org.id);
  const fit = scoreFit(check.value.fit_inputs, check.value.disqualifiers);
  const evidenceScore = scoreEvidence(
    deriveEvidenceInputs(evidence, { contactVerified: check.value.contact_verified, today: today() }),
  );
  const evidenceHash = await dossierFingerprint(evidence, people);
  const scoredAt = nowIso();

  for (const [kind, score] of [["fit", fit], ["evidence", evidenceScore]]) {
    await run(env.DB,
      `INSERT INTO fit_scores (id, campaign_id, organization_id, kind, total, rule_version, factors, disqualifiers,
         scored_at, evidence_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      makeId("s"), campaign.id, org.id, kind, score.total, RULE_VERSION,
      JSON.stringify(score.factors), JSON.stringify(score.disqualifiers), scoredAt, evidenceHash);
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
      `SELECT * FROM fit_scores WHERE campaign_id = ? AND organization_id = ?
       ORDER BY scored_at DESC, rowid DESC`,
      campaign.id, org.id);
    const latest = (kind) => scores.find((s) => s.kind === kind) ?? null;
    const evidence = await all(env.DB,
      `SELECT * FROM evidence_items WHERE organization_id = ? AND campaign_id = ?`,
      org.id, campaign.id);
    const people = await all(env.DB, "SELECT * FROM people WHERE organization_id = ?", org.id);
    const sup = checkSuppression(
      suppressionKeysFor({ organization: { domain: org.normalized_domain, name: org.normalized_name } }),
      suppressionRows,
    );
    const unknownFields = [];
    if (!org.normalized_domain) unknownFields.push("domain");
    if (!org.location) unknownFields.push("location");
    const campaignVerifiedAt = evidence
      .filter((item) => item.reviewer_state === "accepted"
        && ["first-party", "authoritative-directory"].includes(item.strength))
      .map((item) => item.observed_at).sort().at(-1) || null;
    if (!campaignVerifiedAt) unknownFields.push("campaign_verification");
    const staleDays = campaignVerifiedAt
      ? Math.floor((Date.now() - new Date(`${campaignVerifiedAt}T00:00:00Z`)) / 86_400_000)
      : null;
    const evidenceHash = await dossierFingerprint(evidence, people);
    const auditRow = await one(env.DB,
      `SELECT verdict, evidence_hash, checklist FROM dossier_audits WHERE organization_id = ? AND campaign_id = ?
       ORDER BY audited_at DESC, rowid DESC LIMIT 1`, org.id, campaign.id);
    const fit = latest("fit");
    const evidenceScore = latest("evidence");
    const scoresCurrent = Boolean(fit && evidenceScore
      && fit.evidence_hash === evidenceHash && evidenceScore.evidence_hash === evidenceHash);
    const auditCurrent = auditRow?.verdict === "accurate" && auditRow.evidence_hash === evidenceHash
      && dossierAuditChecklistComplete(auditRow);
    const evidenceResolved = evidence.every((item) => item.reviewer_state !== "unreviewed"
      && item.contradiction_state !== "contradicted");
    const ruleReady = Boolean(auditCurrent && scoresCurrent && passesQueueThreshold(fit, evidenceScore)
      && evidenceResolved && staleDays !== null && staleDays <= 60 && !sup.suppressed);
    const readinessReasons = [];
    if (!evidenceResolved) readinessReasons.push("evidence-review");
    if (staleDays === null || staleDays > 60) readinessReasons.push("freshness");
    if (!auditCurrent) readinessReasons.push("audit");
    if (!scoresCurrent) readinessReasons.push("scores-current");
    else if (!passesQueueThreshold(fit, evidenceScore)) readinessReasons.push("threshold");
    if (sup.suppressed) readinessReasons.push("suppressed");
    queue.push({
      organization: org,
      fit,
      evidence_score: evidenceScore,
      evidence_counts: {
        total: evidence.length,
        accepted: evidence.filter((e) => e.reviewer_state === "accepted").length,
        contradicted: evidence.filter((e) => e.contradiction_state === "contradicted").length,
      },
      evidence_freshness_days: staleDays,
      campaign_verified_at: campaignVerifiedAt,
      stale: staleDays === null || staleDays > 60,
      duplicate_state: org.merge_state,
      suppression: sup,
      unknown_fields: unknownFields,
      rule_ready: ruleReady,
      readiness_reasons: readinessReasons,
    });
  }
  return json(env, { campaign: campaign.id, queue });
}

/** Full dossier for one organization. */
async function dossier({ env, params }) {
  const org = await one(env.DB, "SELECT * FROM organizations WHERE id = ?", params.id);
  if (!org) return error(env, 404, "not-found");
  const [people, evidence, scores, drafts, attempts, audits, campaignLinks] = await Promise.all([
    all(env.DB, "SELECT * FROM people WHERE organization_id = ?", org.id),
    all(env.DB, "SELECT * FROM evidence_items WHERE organization_id = ? ORDER BY observed_at DESC", org.id),
    all(env.DB,
      "SELECT * FROM fit_scores WHERE organization_id = ? ORDER BY scored_at DESC, rowid DESC LIMIT 10",
      org.id),
    all(env.DB, "SELECT * FROM outreach_drafts WHERE organization_id = ? ORDER BY created_at DESC", org.id),
    all(env.DB, "SELECT * FROM contact_attempts WHERE organization_id = ? ORDER BY occurred_at DESC", org.id),
    all(env.DB, "SELECT * FROM dossier_audits WHERE organization_id = ? ORDER BY audited_at DESC, rowid DESC", org.id),
    all(env.DB,
      `SELECT campaign_id FROM evidence_items WHERE organization_id = ? AND campaign_id IS NOT NULL
       UNION SELECT campaign_id FROM fit_scores WHERE organization_id = ?
       UNION SELECT campaign_id FROM outreach_drafts WHERE organization_id = ?
       UNION SELECT campaign_id FROM dossier_audits WHERE organization_id = ?`,
      org.id, org.id, org.id, org.id),
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
    drafts, contact_attempts: attempts, audits,
    campaign_ids: campaignLinks.map((row) => row.campaign_id), suppression: sup,
  });
}

export const researchRoutes = [
  ["POST", "/api/organizations/manual", createManualOrganization],
  ["POST", "/api/organizations/:id/people/manual", createManualPerson],
  ["PATCH", "/api/people/:id", updatePerson],
  ["POST", "/api/campaigns/:id/preview-search", previewSearch],
  ["POST", "/api/campaigns/:id/search", runSearch],
  ["GET", "/api/campaigns/:id/queue", researchQueue],
  ["POST", "/api/organizations/:id/people", searchPeopleForOrg],
  ["POST", "/api/people/:id/enrich", enrichPersonFromProvider],
  ["POST", "/api/organizations/:id/evidence", addEvidence],
  ["PATCH", "/api/evidence/:id", reviewEvidence],
  ["POST", "/api/campaigns/:cid/organizations/:oid/audit", auditDossier],
  ["GET", "/api/organizations/:id/dossier", dossier],
  ["POST", "/api/campaigns/:cid/organizations/:oid/score", scoreOrganization],
  ["POST", "/api/scores/:id/override", overrideScore],
];
