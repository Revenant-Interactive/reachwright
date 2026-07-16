/**
 * End-to-end API tests: real router, real route handlers, real migration
 * schema (via the node:sqlite D1 shim), fixture provider. Covers the
 * working-MVP criteria that live above the pure-logic layer.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createFakeD1 } from "./helpers/fake-d1.mjs";
import { handleRequest } from "../worker-api/src/index.js";

const TOKEN = "test-operator-token-0123456789abcdef";

function makeEnv(overrides = {}) {
  return {
    DB: createFakeD1(),
    OPERATOR_TOKEN: TOKEN,
    APP_ORIGIN: "http://localhost:8123",
    DEV_FIXTURES: "true",
    EMAIL_GATE_PASSED: "false",
    BODY_MAX_BYTES: "65536",
    PROVIDER_TIMEOUT_MS: "1000",
    PROVIDER_CREDIT_CEILING: "50",
    ...overrides,
  };
}

async function call(env, method, path, body, { token = TOKEN, origin } = {}) {
  const request = new Request(`https://api.test${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(origin ? { origin } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const response = await handleRequest(request, env);
  return { status: response.status, body: await response.json() };
}

const CAMPAIGN = {
  name: "Roofing pilot", owner: "michael", offer: "We book qualified sales calls for roofing contractors",
  icp: "local commercial roofing companies, 5-50 employees", geography: "Illinois",
  min_economics: "customer value ≥ $2,000", allowed_channels: ["linkedin-manual", "dm", "email"],
  max_batch_size: 10,
};

async function setupCampaignWithProspect(env) {
  const created = await call(env, "POST", "/api/campaigns", CAMPAIGN);
  const campaignId = created.body.campaign.id;
  await call(env, "PATCH", `/api/campaigns/${campaignId}`, { status: "researching" });
  const search = await call(env, "POST", `/api/campaigns/${campaignId}/search`, {});
  const orgId = search.body.organization_ids[0];
  await call(env, "POST", `/api/organizations/${orgId}/people`, {});
  const evidence = await call(env, "POST", `/api/organizations/${orgId}/evidence`, {
    claim: "The company's website lists commercial roofing as a primary service",
    source_url: "https://fixture-harbor-roofing.example/services",
    observed_at: "2026-07-14", strength: "first-party", campaign_id: campaignId,
  });
  await call(env, "PATCH", `/api/evidence/${evidence.body.evidence_id}`, { reviewer_state: "accepted" });
  return { campaignId, orgId, search };
}

// ------------------------------------------------------------------ auth
test("auth boundary: missing/wrong token 401, wrong origin 403, no open mode", async () => {
  const env = makeEnv();
  assert.equal((await call(env, "GET", "/api/health", null, { token: null })).status, 401);
  assert.equal((await call(env, "GET", "/api/health", null, { token: "wrong" })).status, 401);
  assert.equal((await call(env, "GET", "/api/health", null, { origin: "https://evil.example" })).status, 403);
  assert.equal((await call(env, "GET", "/api/health", null, { origin: "http://localhost:8123" })).status, 200);
  // A worker with no configured token refuses everything rather than running open.
  const openEnv = makeEnv({ OPERATOR_TOKEN: "" });
  assert.equal((await call(openEnv, "GET", "/api/health")).status, 401);
});

// ------------------------------------------------- provider configuration
test("no provider key and no fixtures → provider-not-configured, never sample leads", async () => {
  const env = makeEnv({ DEV_FIXTURES: "false" });
  const health = await call(env, "GET", "/api/health");
  assert.equal(health.body.provider.configured, false);
  const created = await call(env, "POST", "/api/campaigns", CAMPAIGN);
  const id = created.body.campaign.id;
  await call(env, "PATCH", `/api/campaigns/${id}`, { status: "researching" });
  const search = await call(env, "POST", `/api/campaigns/${id}/search`, {});
  assert.equal(search.status, 503);
  assert.equal(search.body.error, "provider-not-configured");
});

// ------------------------------------------------------ campaign lifecycle
test("campaign creation validates the brief; incomplete briefs cannot research", async () => {
  const env = makeEnv();
  const bad = await call(env, "POST", "/api/campaigns", { name: "x" });
  assert.equal(bad.status, 422);
  const good = await call(env, "POST", "/api/campaigns", CAMPAIGN);
  assert.equal(good.status, 201);
  assert.equal(good.body.campaign.brief_complete, true);
  const noChannels = await call(env, "POST", "/api/campaigns", { ...CAMPAIGN, allowed_channels: [] });
  assert.equal(noChannels.status, 422);
});

// ----------------------------------------------- search, dedupe, provenance
test("search stores normalized orgs, merges the fixture duplicate, records provenance + usage", async () => {
  const env = makeEnv();
  const { search, orgId } = await setupCampaignWithProspect(env);
  // Fixtures contain 3 orgs where #3 duplicates #1 → 2 stored, 1 merged.
  assert.equal(search.body.summary.stored, 2);
  assert.equal(search.body.summary.merged, 1);
  const dossier = await call(env, "GET", `/api/organizations/${orgId}/dossier`);
  assert.equal(dossier.body.organization.provider, "local-fixtures");
  const providerEvidence = dossier.body.evidence.find((e) => e.source_type === "provider");
  assert.ok(providerEvidence, "provider provenance must be recorded as evidence");
  assert.ok(providerEvidence.observed_at, "evidence must carry an observed date");
  assert.ok(dossier.body.people.length > 0, "people search stored people");
});

// -------------------------------------------------------- scoring pipeline
test("scoring persists deterministic, explainable fit + evidence rows", async () => {
  const env = makeEnv();
  const { campaignId, orgId } = await setupCampaignWithProspect(env);
  const scored = await call(env, "POST", `/api/campaigns/${campaignId}/organizations/${orgId}/score`, {
    fit_inputs: { offer_match: 1, timing_signal: 0.5, geography: 1, economics: 1, capacity_growth: 0.5, reachable: 1 },
    contact_verified: true,
  });
  assert.equal(scored.status, 200);
  assert.equal(scored.body.fit.total, 30 + 10 + 15 + 15 + 5 + 10);
  assert.equal(scored.body.rule_version, "playbook-0.1");
  const queue = await call(env, "GET", `/api/campaigns/${campaignId}/queue`);
  const entry = queue.body.queue.find((q) => q.organization.id === orgId);
  assert.ok(entry.fit && entry.evidence_score, "queue shows both scores");
  assert.equal(entry.suppression.suppressed, false);
});

// ------------------------------------- drafts, packets, approvals, exports
test("draft lifecycle: evidence-only creation, packet-bound approval, edit invalidation, gated export", async () => {
  const env = makeEnv();
  const { campaignId, orgId } = await setupCampaignWithProspect(env);
  const dossier = await call(env, "GET", `/api/organizations/${orgId}/dossier`);
  const personId = dossier.body.people[0].id;

  const draft = await call(env, "POST", "/api/drafts", {
    campaign_id: campaignId, organization_id: orgId, person_id: personId, channel: "linkedin-manual",
  });
  assert.equal(draft.status, 201);
  assert.ok(draft.body.body.includes("commercial roofing"), "draft cites accepted evidence");

  // Approval requires the exact packet hash the operator saw.
  const stale = await call(env, "POST", `/api/drafts/${draft.body.draft_id}/approve`, {
    packet_hash: "wrong", contacted_elsewhere: "no",
  });
  assert.equal(stale.status, 409);
  const packet = await call(env, "GET", `/api/drafts/${draft.body.draft_id}/packet`);
  assert.equal(packet.body.packet.confirm_question, "Have you contacted this business anywhere outside Reachwright?");
  const approve = await call(env, "POST", `/api/drafts/${draft.body.draft_id}/approve`, {
    packet_hash: packet.body.packet_hash, contacted_elsewhere: "no",
  });
  assert.equal(approve.status, 200);

  // Editing an approved draft returns it to draft and revokes approval.
  const edit = await call(env, "PATCH", `/api/drafts/${draft.body.draft_id}`, { body: "Edited message body." });
  assert.equal(edit.body.status, "draft");
  const exportBlocked = await call(env, "POST", "/api/exports", { draft_ids: [draft.body.draft_id] });
  assert.equal(exportBlocked.body.exported, 0);
  assert.equal(exportBlocked.body.blocked[0].reason, "not-approved");

  // Re-approve with the fresh packet, then export (non-email channel passes).
  const packet2 = await call(env, "GET", `/api/drafts/${draft.body.draft_id}/packet`);
  await call(env, "POST", `/api/drafts/${draft.body.draft_id}/approve`, {
    packet_hash: packet2.body.packet_hash, contacted_elsewhere: "no",
  });
  const exported = await call(env, "POST", "/api/exports", { draft_ids: [draft.body.draft_id] });
  assert.equal(exported.body.exported, 1);
  assert.ok(exported.body.csv.includes("Edited message body."));
});

test("email exports stay blocked until the CAN-SPAM gate passes", async () => {
  const env = makeEnv();
  const { campaignId, orgId } = await setupCampaignWithProspect(env);
  const dossier = await call(env, "GET", `/api/organizations/${orgId}/dossier`);
  const personId = dossier.body.people[0].id;
  const draft = await call(env, "POST", "/api/drafts", {
    campaign_id: campaignId, organization_id: orgId, person_id: personId, channel: "email",
  });
  const packet = await call(env, "GET", `/api/drafts/${draft.body.draft_id}/packet`);
  await call(env, "POST", `/api/drafts/${draft.body.draft_id}/approve`, {
    packet_hash: packet.body.packet_hash, contacted_elsewhere: "no",
  });
  const exported = await call(env, "POST", "/api/exports", { draft_ids: [draft.body.draft_id] });
  assert.equal(exported.body.exported, 0);
  assert.equal(exported.body.blocked[0].reason, "email-gate");
});

test("insufficient evidence yields the honest outcome, not filler", async () => {
  const env = makeEnv();
  const created = await call(env, "POST", "/api/campaigns", CAMPAIGN);
  const campaignId = created.body.campaign.id;
  await call(env, "PATCH", `/api/campaigns/${campaignId}`, { status: "researching" });
  const search = await call(env, "POST", `/api/campaigns/${campaignId}/search`, {});
  const orgId = search.body.organization_ids[0]; // only provider (secondary) evidence exists
  const draft = await call(env, "POST", "/api/drafts", {
    campaign_id: campaignId, organization_id: orgId, channel: "dm",
  });
  assert.equal(draft.status, 422);
  assert.equal(draft.body.error, "insufficient-evidence");
});

// ------------------------------------------------------------- suppression
test("suppression blocks drafts, approval, and export; opt-out expands across channels", async () => {
  const env = makeEnv();
  const { campaignId, orgId } = await setupCampaignWithProspect(env);
  const dossier = await call(env, "GET", `/api/organizations/${orgId}/dossier`);
  const personId = dossier.body.people[0].id;

  // Approve a draft, then suppress the domain, then try to export.
  const draft = await call(env, "POST", "/api/drafts", {
    campaign_id: campaignId, organization_id: orgId, person_id: personId, channel: "linkedin-manual",
  });
  const packet = await call(env, "GET", `/api/drafts/${draft.body.draft_id}/packet`);
  await call(env, "POST", `/api/drafts/${draft.body.draft_id}/approve`, {
    packet_hash: packet.body.packet_hash, contacted_elsewhere: "no",
  });
  await call(env, "POST", "/api/suppression", {
    key_type: "domain", key_value: "fixture-harbor-roofing.example", reason: "asked us to stop",
  });
  const exported = await call(env, "POST", "/api/exports", { draft_ids: [draft.body.draft_id] });
  assert.equal(exported.body.exported, 0);
  assert.equal(exported.body.blocked[0].reason, "suppressed");

  // New drafts for the suppressed org are refused outright.
  const blockedDraft = await call(env, "POST", "/api/drafts", {
    campaign_id: campaignId, organization_id: orgId, channel: "dm",
  });
  assert.equal(blockedDraft.status, 409);
  assert.equal(blockedDraft.body.error, "suppressed");
});

test("an opt-out recorded on one channel suppresses the whole company", async () => {
  const env = makeEnv();
  const { campaignId, orgId } = await setupCampaignWithProspect(env);
  const dossier = await call(env, "GET", `/api/organizations/${orgId}/dossier`);
  const personId = dossier.body.people[0].id;
  await call(env, "POST", "/api/attempts", {
    campaign_id: campaignId, organization_id: orgId, person_id: personId,
    channel: "dm", direction: "inbound", status: "opted-out",
  });
  const after = await call(env, "GET", `/api/organizations/${orgId}/dossier`);
  assert.equal(after.body.suppression.suppressed, true);
  const draft = await call(env, "POST", "/api/drafts", {
    campaign_id: campaignId, organization_id: orgId, channel: "linkedin-manual",
  });
  assert.equal(draft.status, 409);
});

// ---------------------------------------------------------- qualify + book
test("qualification flows: create, validate, activate, deterministic preview", async () => {
  const env = makeEnv();
  const invalid = await call(env, "POST", "/api/qualify/flows", { name: "bad", definition: { questions: [] } });
  assert.equal(invalid.status, 422);

  const definition = {
    questions: [
      { id: "q1", field: "size", prompt: "How many trucks do you run?",
        options: [{ value: "small", label: "1–3" }, { value: "big", label: "4+" }] },
    ],
    rules: {
      disqualifiers: [], humanReview: [{ when: { field: "size", in: ["small"] }, reason: "capacity unclear" }],
      scoring: [{ when: { field: "size", in: ["big"] }, points: 6 }], strongAt: 6, maybeAt: 3,
    },
    verdictCopy: { strong: "Good fit for the pilot.", maybe: "Needs one more look.", no: "Not yet.", "human-review": "A human will follow up." },
    route: { strong: "booking", maybe: "human", no: "none", "human-review": "human" },
  };
  const created = await call(env, "POST", "/api/qualify/flows", { name: "trucks", definition });
  assert.equal(created.status, 201);
  assert.equal(created.body.version, 1);
  const activated = await call(env, "POST", `/api/qualify/flows/${created.body.flow_id}/activate`, {});
  assert.equal(activated.status, 200);

  const strong = await call(env, "POST", "/api/qualify/preview", { flow_id: created.body.flow_id, answers: { size: "big" } });
  assert.equal(strong.body.decision.verdict, "strong");
  const review = await call(env, "POST", "/api/qualify/preview", { flow_id: created.body.flow_id, answers: { size: "small" } });
  assert.equal(review.body.decision.verdict, "human-review");
  const badAnswers = await call(env, "POST", "/api/qualify/preview", { flow_id: created.body.flow_id, answers: { size: "enormous" } });
  assert.equal(badAnswers.status, 422);
});

test("bookings: booked ≠ held; held only via transition after the call", async () => {
  const env = makeEnv();
  const direct = await call(env, "POST", "/api/bookings", { status: "held" });
  assert.equal(direct.status, 422);
  const booked = await call(env, "POST", "/api/bookings", {
    status: "booked", scheduled_for: "2026-07-20T15:00:00-05:00", timezone: "America/Chicago",
  });
  assert.equal(booked.status, 201);
  const held = await call(env, "PATCH", `/api/bookings/${booked.body.booking_id}`, { status: "held" });
  assert.equal(held.status, 200);
  const cancelHeld = await call(env, "PATCH", `/api/bookings/${booked.body.booking_id}`, { status: "canceled" });
  assert.equal(cancelHeld.status, 409, "held is terminal");
});

// ---------------------------------------------------------------- reports
test("dashboard and campaign report count honestly (candidates ≠ leads, booked ≠ held)", async () => {
  const env = makeEnv();
  const { campaignId } = await setupCampaignWithProspect(env);
  const dashboard = await call(env, "GET", "/api/dashboard");
  assert.equal(dashboard.body.candidates_found, 2);
  assert.equal(dashboard.body.calls_held, 0);
  const report = await call(env, "GET", `/api/reports/campaigns/${campaignId}`);
  assert.ok(report.body.provider_usage.length > 0, "provider usage is tracked");
  assert.equal(report.body.calls_held, 0);
  assert.equal(report.body.bookings_booked, 0);
});
