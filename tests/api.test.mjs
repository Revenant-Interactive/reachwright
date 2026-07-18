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

const AUDIT_CHECKLIST = {
  identity_verified: true,
  offer_signal_verified: true,
  geography_verified: true,
  decision_maker_verified: true,
  contact_path_verified: true,
  contradictions_checked: true,
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
  const dossier = await call(env, "GET", `/api/organizations/${orgId}/dossier`);
  for (const item of dossier.body.evidence.filter((entry) => entry.reviewer_state === "unreviewed")) {
    await call(env, "PATCH", `/api/evidence/${item.id}`, { reviewer_state: "rejected" });
  }
  await call(env, "POST", `/api/campaigns/${campaignId}/organizations/${orgId}/audit`, {
    verdict: "accurate", notes: "Fixture facts checked against first-party source", checklist: AUDIT_CHECKLIST,
  });
  await call(env, "POST", `/api/campaigns/${campaignId}/organizations/${orgId}/score`, {
    fit_inputs: { offer_match: 1, timing_signal: 1, geography: 1, economics: 1, capacity_growth: 1, reachable: 1 },
    contact_verified: true,
  });
  return { campaignId, orgId, search };
}

test("manual-first intake enforces suppression and dedupe and records provenance", async () => {
  const env = makeEnv({ DEV_FIXTURES: "false" });
  const campaignId = (await call(env, "POST", "/api/campaigns", CAMPAIGN)).body.campaign.id;
  const manual = await call(env, "POST", "/api/organizations/manual", {
    display_name: "Taylor Home Repair", domain: "https://taylor-repair.example/services",
    location: "Champaign, IL", country: "US", phone: "217-555-0100", campaign_id: campaignId,
    source_url: "https://taylor-repair.example/services", observed_at: "2026-07-15",
    claim: "Taylor Home Repair lists kitchen remodeling as a primary service", evidence_reviewed: true,
    contact_name: "Morgan Taylor", contact_title: "Owner",
    contact_source_url: "https://taylor-repair.example/about",
  });
  assert.equal(manual.status, 201);
  const dossier = await call(env, "GET", `/api/organizations/${manual.body.organization_id}/dossier`);
  assert.equal(dossier.body.organization.provider, "manual");
  assert.equal(dossier.body.evidence[0].source_url, "https://taylor-repair.example/services");
  assert.equal(dossier.body.evidence[0].reviewer_state, "accepted");
  assert.equal(dossier.body.people[0].full_name, "Morgan Taylor");
  assert.deepEqual(dossier.body.campaign_ids, [campaignId]);
  const duplicate = await call(env, "POST", "/api/organizations/manual", {
    display_name: "Taylor Home Repair LLC", domain: "taylor-repair.example", location: "Champaign, IL",
    campaign_id: campaignId, source_url: "https://taylor-repair.example", observed_at: "2026-07-15",
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error, "duplicate");
  const person = await call(env, "POST", `/api/organizations/${manual.body.organization_id}/people/manual`, {
    full_name: "Alex Taylor", title: "Owner", public_profile_url: "https://taylor-repair.example/team/alex",
    observed_at: "2026-07-15",
  });
  assert.equal(person.status, 201);
  const duplicatePerson = await call(env, "POST", `/api/organizations/${manual.body.organization_id}/people/manual`, {
    full_name: "Alex Taylor", title: "Owner", public_profile_url: "https://taylor-repair.example/team/alex",
    observed_at: "2026-07-15",
  });
  assert.equal(duplicatePerson.body.error, "duplicate");
  await call(env, "POST", "/api/suppression", { key_type: "domain", key_value: "blocked.example", reason: "prior opt-out" });
  const suppressed = await call(env, "POST", "/api/organizations/manual", {
    display_name: "Blocked Co", domain: "blocked.example", location: "Champaign, IL",
    campaign_id: campaignId, source_url: "https://blocked.example", observed_at: "2026-07-15",
  });
  assert.equal(suppressed.body.error, "suppressed");
});

test("verification freshness comes only from accepted strong evidence", async () => {
  const env = makeEnv({ DEV_FIXTURES: "false" });
  const campaignId = (await call(env, "POST", "/api/campaigns", CAMPAIGN)).body.campaign.id;
  const manual = await call(env, "POST", "/api/organizations/manual", {
    display_name: "Freshness Test Co", domain: "freshness-test.example", location: "Chicago, IL",
    campaign_id: campaignId, source_url: "https://directory.example/freshness-test",
    source_strength: "weak", observed_at: "2026-07-15",
  });
  let dossier = await call(env, "GET", `/api/organizations/${manual.body.organization_id}/dossier`);
  assert.equal(dossier.body.organization.last_verified, null);

  const strong = await call(env, "POST", `/api/organizations/${manual.body.organization_id}/evidence`, {
    claim: "The official site identifies the company and its service",
    source_url: "https://freshness-test.example/about", observed_at: "2026-06-01",
    strength: "first-party", campaign_id: campaignId, reviewer_state: "accepted",
  });
  dossier = await call(env, "GET", `/api/organizations/${manual.body.organization_id}/dossier`);
  assert.equal(dossier.body.organization.last_verified, "2026-06-01");

  await call(env, "POST", `/api/organizations/${manual.body.organization_id}/evidence`, {
    claim: "An unreviewed recent directory listing",
    source_url: "https://directory.example/freshness-test/recent", observed_at: "2026-07-15",
    strength: "secondary", campaign_id: campaignId,
  });
  dossier = await call(env, "GET", `/api/organizations/${manual.body.organization_id}/dossier`);
  assert.equal(dossier.body.organization.last_verified, "2026-06-01");
  assert.ok(strong.body.evidence_id);
});

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

test("Hunter free flow discovers a small business and stores only CEO/owner-class contacts", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith("/discover")) {
      return new Response(JSON.stringify({
        data: [{ domain: "acme-roofing.example", organization: "Acme Roofing", emails_count: { personal: 2, total: 2 } }],
        meta: { results: 1, limit: 100, offset: 0 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (parsed.pathname.endsWith("/domain-search")) {
      return new Response(JSON.stringify({
        data: { domain: "acme-roofing.example", organization: "Acme Roofing", emails: [
          { value: "avery@acme-roofing.example", first_name: "Avery", last_name: "Owner", position: "Owner", seniority: "executive", verification: { status: "valid", date: "2026-07-15" } },
          { value: "staff@acme-roofing.example", first_name: "Sam", last_name: "Staff", position: "Estimator", seniority: "senior", verification: { status: "valid" } },
        ] },
        meta: { results: 2, limit: 10, offset: 0 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ errors: [{ id: "unexpected" }] }), { status: 400 });
  };

  try {
    const env = makeEnv({
      DEV_FIXTURES: "false", PROSPECT_PROVIDER: "hunter", HUNTER_API_KEY: "hunter-test",
      PROVIDER_CREDIT_CEILING: "10",
    });
    const created = await call(env, "POST", "/api/campaigns", CAMPAIGN);
    const campaignId = created.body.campaign.id;
    await call(env, "PATCH", `/api/campaigns/${campaignId}`, { status: "researching" });
    const search = await call(env, "POST", `/api/campaigns/${campaignId}/search`, {
      locations: ["Champaign, Illinois"], keywords: ["roofing"], batch: 5,
    });
    assert.equal(search.status, 200);
    assert.equal(search.body.provider, "hunter");
    assert.equal(search.body.organization_ids.length, 1);

    const people = await call(env, "POST", `/api/organizations/${search.body.organization_ids[0]}/people`, {});
    assert.equal(people.status, 200);
    assert.equal(people.body.stored, 1);
    assert.equal(people.body.estimate.estimated, 1);
    const dossier = await call(env, "GET", `/api/organizations/${search.body.organization_ids[0]}/dossier`);
    assert.equal(dossier.body.people.length, 1);
    assert.equal(dossier.body.people[0].title, "Owner");
    assert.equal(dossier.body.people[0].business_email, "avery@acme-roofing.example");
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test("provider search traverses enough pages to honor a batch above 25", async () => {
  const originalFetch = globalThis.fetch;
  const pages = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    pages.push(body.page);
    const start = (body.page - 1) * body.per_page;
    const organizations = Array.from({ length: body.per_page }, (_, offset) => {
      const number = start + offset + 1;
      return {
        id: `apollo-${number}`, name: `Scale Prospect ${number}`,
        primary_domain: `scale-prospect-${number}.example.com`,
        city: "Chicago", state: "Illinois", country: "United States",
        industry: "professional services", estimated_num_employees: 12,
      };
    });
    return new Response(JSON.stringify({
      organizations,
      pagination: { page: body.page, per_page: body.per_page, total_entries: 80, total_pages: 4 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const env = makeEnv({ DEV_FIXTURES: "false", APOLLO_API_KEY: "test-key", PROVIDER_CREDIT_CEILING: "100" });
    const campaign = (await call(env, "POST", "/api/campaigns", {
      ...CAMPAIGN, name: "Scale pagination", max_batch_size: 60,
    })).body.campaign;
    await call(env, "PATCH", `/api/campaigns/${campaign.id}`, { status: "researching" });
    const preview = await call(env, "POST", `/api/campaigns/${campaign.id}/preview-search`, { batch: 60, start_page: 1 });
    assert.deepEqual(preview.body.page_plan, { requested: 60, pages: 3, perPage: 20, startPage: 1 });
    const search = await call(env, "POST", `/api/campaigns/${campaign.id}/search`, { batch: 60, start_page: 1 });
    assert.equal(search.status, 200);
    assert.equal(search.body.summary.stored, 60);
    assert.deepEqual(pages, [1, 2, 3]);
    assert.equal(search.body.pagination.pages_fetched, 3);
    assert.equal(search.body.pagination.start_page, 1);
    assert.equal(search.body.pagination.next_page, 4);
    assert.ok(search.body.pagination.continuation_token);

    const mismatched = await call(env, "POST", `/api/campaigns/${campaign.id}/search`, {
      batch: 20, start_page: 4, locations: ["Peoria"],
      continuation_token: search.body.pagination.continuation_token,
    });
    assert.equal(mismatched.body.error, "continuation-token-mismatch");

    const continued = await call(env, "POST", `/api/campaigns/${campaign.id}/search`, {
      batch: 20, start_page: 4, continuation_token: search.body.pagination.continuation_token,
    });
    assert.equal(continued.status, 200);
    assert.equal(continued.body.summary.stored, 20);
    assert.deepEqual(pages, [1, 2, 3, 4]);
    assert.equal(continued.body.pagination.next_page, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a provider duplicate attaches the canonical organization to the new campaign without faking verification", async () => {
  const env = makeEnv();
  const first = await call(env, "POST", "/api/campaigns", CAMPAIGN);
  await call(env, "PATCH", `/api/campaigns/${first.body.campaign.id}`, { status: "researching" });
  const firstSearch = await call(env, "POST", `/api/campaigns/${first.body.campaign.id}/search`, {});
  const canonicalId = firstSearch.body.organization_ids[0];
  env.DB._raw.prepare("UPDATE organizations SET last_verified = '2026-01-01' WHERE id = ?").run(canonicalId);

  const second = await call(env, "POST", "/api/campaigns", { ...CAMPAIGN, name: "Second provider campaign" });
  await call(env, "PATCH", `/api/campaigns/${second.body.campaign.id}`, { status: "researching" });
  const repeated = await call(env, "POST", `/api/campaigns/${second.body.campaign.id}/search`, {});
  assert.ok(repeated.body.summary.attached >= 2);
  const queue = await call(env, "GET", `/api/campaigns/${second.body.campaign.id}/queue`);
  assert.equal(queue.body.queue.length, 2, "canonical records remain visible in the second campaign");
  const dossier = await call(env, "GET", `/api/organizations/${canonicalId}/dossier`);
  assert.ok(dossier.body.campaign_ids.includes(second.body.campaign.id));
  assert.equal(dossier.body.organization.last_verified, "2026-01-01",
    "a repeated directory listing must not masquerade as first-party verification");
});

test("people discovery is idempotent, suppression-aware, and supports selective business-email enrichment", async () => {
  const env = makeEnv();
  const created = await call(env, "POST", "/api/campaigns", CAMPAIGN);
  const campaignId = created.body.campaign.id;
  await call(env, "PATCH", `/api/campaigns/${campaignId}`, { status: "researching" });
  const search = await call(env, "POST", `/api/campaigns/${campaignId}/search`, {});
  const orgId = search.body.organization_ids[0];
  const first = await call(env, "POST", `/api/organizations/${orgId}/people`, {});
  const second = await call(env, "POST", `/api/organizations/${orgId}/people`, {});
  assert.equal(first.body.stored, 1);
  assert.equal(second.body.stored, 0);
  assert.equal(second.body.updated, 1);
  let dossier = await call(env, "GET", `/api/organizations/${orgId}/dossier`);
  assert.equal(dossier.body.people.length, 1);
  const enriched = await call(env, "POST", `/api/people/${dossier.body.people[0].id}/enrich`, {});
  assert.equal(enriched.status, 200);
  assert.equal(enriched.body.verification_state, "verified");

  const blockedEnv = makeEnv();
  const blockedCampaign = (await call(blockedEnv, "POST", "/api/campaigns", CAMPAIGN)).body.campaign.id;
  await call(blockedEnv, "PATCH", `/api/campaigns/${blockedCampaign}`, { status: "researching" });
  const blockedSearch = await call(blockedEnv, "POST", `/api/campaigns/${blockedCampaign}/search`, {});
  await call(blockedEnv, "POST", "/api/suppression", {
    key_type: "handle", key_value: "fixture-dana-example", reason: "prior individual opt-out",
  });
  const blockedPeople = await call(blockedEnv, "POST", `/api/organizations/${blockedSearch.body.organization_ids[0]}/people`, {});
  assert.equal(blockedPeople.body.suppressed, 1);
  dossier = await call(blockedEnv, "GET", `/api/organizations/${blockedSearch.body.organization_ids[0]}/dossier`);
  assert.equal(dossier.body.people.length, 0);
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
  assert.equal(entry.rule_ready, true, "a current audit and passing current scores produce an explicit rule-ready state");
});

test("same-timestamp score rows resolve deterministically by newest rowid at every gate", async () => {
  const env = makeEnv();
  const { campaignId, orgId } = await setupCampaignWithProspect(env);
  const tiedAt = "2026-07-16T12:00:00.000Z";
  env.DB._raw.prepare("UPDATE fit_scores SET scored_at = ? WHERE campaign_id = ? AND organization_id = ?")
    .run(tiedAt, campaignId, orgId);
  const fingerprint = env.DB._raw.prepare(
    "SELECT evidence_hash FROM fit_scores WHERE campaign_id = ? AND organization_id = ? LIMIT 1",
  ).get(campaignId, orgId).evidence_hash;
  env.DB._raw.prepare(
    `INSERT INTO fit_scores
       (id, campaign_id, organization_id, kind, total, rule_version, factors, disqualifiers, scored_at, evidence_hash)
     VALUES ('rw-s-tied-latest', ?, ?, 'fit', 10, 'playbook-0.1', '[]', '[]', ?, ?)`,
  ).run(campaignId, orgId, tiedAt, fingerprint);

  const queue = await call(env, "GET", `/api/campaigns/${campaignId}/queue`);
  const entry = queue.body.queue.find((item) => item.organization.id === orgId);
  assert.equal(entry.fit.id, "rw-s-tied-latest");
  assert.equal(entry.rule_ready, false);
  assert.ok(entry.readiness_reasons.includes("threshold"));

  const draft = await call(env, "POST", "/api/drafts", {
    campaign_id: campaignId, organization_id: orgId, channel: "dm",
  });
  assert.equal(draft.status, 409);
  assert.equal(draft.body.error, "below-queue-threshold");
  assert.equal(draft.body.scores.fit, 10);
});

test("legacy accurate audits without the verification checklist stay blocked", async () => {
  const env = makeEnv();
  const { campaignId, orgId } = await setupCampaignWithProspect(env);
  env.DB._raw.prepare(
    "UPDATE dossier_audits SET checklist = '{}' WHERE campaign_id = ? AND organization_id = ?",
  ).run(campaignId, orgId);

  const queue = await call(env, "GET", `/api/campaigns/${campaignId}/queue`);
  const entry = queue.body.queue.find((item) => item.organization.id === orgId);
  assert.equal(entry.rule_ready, false);
  assert.ok(entry.readiness_reasons.includes("audit"));

  const today = await call(env, "GET", "/api/today");
  const task = today.body.tasks.find((item) => item.organization_id === orgId);
  assert.equal(task.kind, "audit-dossier");
  assert.equal(task.detail, "Verification checklist required");

  const draft = await call(env, "POST", "/api/drafts", {
    campaign_id: campaignId, organization_id: orgId, channel: "dm",
  });
  assert.equal(draft.status, 409);
  assert.equal(draft.body.error, "dossier-audit-checklist-required");

  const dashboard = await call(env, "GET", "/api/dashboard");
  assert.equal(dashboard.body.rule_ready_dossiers, 0);

  env.DB._raw.prepare(
    "UPDATE dossier_audits SET checklist = ? WHERE campaign_id = ? AND organization_id = ?",
  ).run(JSON.stringify({ ...AUDIT_CHECKLIST, contradictions_checked: false }), campaignId, orgId);
  const partialQueue = await call(env, "GET", `/api/campaigns/${campaignId}/queue`);
  assert.equal(partialQueue.body.queue.find((item) => item.organization.id === orgId).rule_ready, false,
    "five true flags cannot substitute for the complete six-flag checklist");
  const partialDraft = await call(env, "POST", "/api/drafts", {
    campaign_id: campaignId, organization_id: orgId, channel: "dm",
  });
  assert.equal(partialDraft.body.error, "dossier-audit-checklist-required");
});

test("drafting enforces current fit and evidence thresholds; overrides remain explicit", async () => {
  const env = makeEnv();
  const { campaignId, orgId } = await setupCampaignWithProspect(env);
  await call(env, "POST", `/api/campaigns/${campaignId}/organizations/${orgId}/score`, {
    fit_inputs: { offer_match: 0, timing_signal: 0, geography: 1, economics: 0, capacity_growth: 0, reachable: 1 },
    contact_verified: true,
  });
  const blocked = await call(env, "POST", "/api/drafts", {
    campaign_id: campaignId, organization_id: orgId, channel: "dm",
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, "below-queue-threshold");
  assert.equal(blocked.body.scores.fit, 25);

  const dossier = await call(env, "GET", `/api/organizations/${orgId}/dossier`);
  const latestFit = dossier.body.scores.find((score) => score.campaign_id === campaignId && score.kind === "fit");
  await call(env, "POST", `/api/scores/${latestFit.id}/override`, {
    override_total: 65, override_reason: "Operator-approved edge case for controlled pilot",
  });
  const allowed = await call(env, "POST", "/api/drafts", {
    campaign_id: campaignId, organization_id: orgId, channel: "dm",
  });
  assert.equal(allowed.status, 201);
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
  const listed = await call(env, "GET", "/api/drafts?status=draft");
  assert.equal(listed.body.drafts[0].organization_name, "[FIXTURE] Harbor Roofing Co");
  assert.equal(listed.body.drafts[0].campaign_name, "Roofing pilot");

  // Approval requires the exact packet hash the operator saw.
  const stale = await call(env, "POST", `/api/drafts/${draft.body.draft_id}/approve`, {
    packet_hash: "wrong", contacted_elsewhere: "no",
  });
  assert.equal(stale.status, 409);
  const packet = await call(env, "GET", `/api/drafts/${draft.body.draft_id}/packet`);
  assert.equal(packet.body.packet.confirm_question, "Have you contacted this business anywhere outside Reachwright?");
  assert.equal(packet.body.packet.dossier_state.audit.verdict, "accurate");
  assert.equal(packet.body.packet.dossier_state.scores.fit.kind, "fit");
  assert.equal(packet.body.packet.dossier_state.scores.evidence.kind, "evidence");
  assert.ok(packet.body.packet.dossier_state.evidence.length > 0);
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

test("channel contact is exact and post-approval contact changes fail closed", async () => {
  const env = makeEnv();
  const { campaignId, orgId } = await setupCampaignWithProspect(env);
  const dossier = await call(env, "GET", `/api/organizations/${orgId}/dossier`);
  const person = dossier.body.people[0];
  env.DB._raw.prepare("UPDATE campaigns SET allowed_channels = ? WHERE id = ?")
    .run(JSON.stringify(["linkedin-manual", "dm", "email", "phone"]), campaignId);

  const missingPhone = await call(env, "POST", "/api/drafts", {
    campaign_id: campaignId, organization_id: orgId, person_id: person.id, channel: "phone",
  });
  assert.equal(missingPhone.status, 409);
  assert.equal(missingPhone.body.error, "channel-contact-required");

  const draft = await call(env, "POST", "/api/drafts", {
    campaign_id: campaignId, organization_id: orgId, person_id: person.id, channel: "linkedin-manual",
  });
  const packet = await call(env, "GET", `/api/drafts/${draft.body.draft_id}/packet`);
  assert.equal(packet.body.packet.contact_for_channel, person.public_profile_url);
  await call(env, "POST", `/api/drafts/${draft.body.draft_id}/approve`, {
    packet_hash: packet.body.packet_hash, contacted_elsewhere: "no",
  });

  env.DB._raw.prepare("UPDATE people SET public_profile_url = ? WHERE id = ?")
    .run("https://linkedin.com/in/changed-after-approval", person.id);
  const exported = await call(env, "POST", "/api/exports", { draft_ids: [draft.body.draft_id] });
  assert.equal(exported.body.exported, 0);
  assert.equal(exported.body.blocked[0].reason, "packet-stale");
  const after = await call(env, "GET", "/api/drafts");
  assert.equal(after.body.drafts.find((item) => item.id === draft.body.draft_id).status, "draft");
});

test("export revalidates the exact approved audit and score snapshots even when dossier facts are unchanged", async () => {
  const env = makeEnv();
  const { campaignId, orgId } = await setupCampaignWithProspect(env);
  const dossier = await call(env, "GET", `/api/organizations/${orgId}/dossier`);
  const personId = dossier.body.people[0].id;
  const draft = await call(env, "POST", "/api/drafts", {
    campaign_id: campaignId, organization_id: orgId, person_id: personId, channel: "linkedin-manual",
  });
  let packet = await call(env, "GET", `/api/drafts/${draft.body.draft_id}/packet`);
  await call(env, "POST", `/api/drafts/${draft.body.draft_id}/approve`, {
    packet_hash: packet.body.packet_hash, contacted_elsewhere: "no",
  });

  await call(env, "POST", `/api/campaigns/${campaignId}/organizations/${orgId}/score`, {
    fit_inputs: { offer_match: 1, timing_signal: 1, geography: 1, economics: 1, capacity_growth: 1, reachable: 1 },
    contact_verified: true,
  });
  let exported = await call(env, "POST", "/api/exports", { draft_ids: [draft.body.draft_id] });
  assert.equal(exported.body.exported, 0);
  assert.equal(exported.body.blocked[0].reason, "packet-stale");

  packet = await call(env, "GET", `/api/drafts/${draft.body.draft_id}/packet`);
  await call(env, "POST", `/api/drafts/${draft.body.draft_id}/approve`, {
    packet_hash: packet.body.packet_hash, contacted_elsewhere: "no",
  });
  await call(env, "POST", `/api/campaigns/${campaignId}/organizations/${orgId}/audit`, {
    verdict: "accurate", notes: "Reconfirmed the unchanged dossier before export", checklist: AUDIT_CHECKLIST,
  });
  exported = await call(env, "POST", "/api/exports", { draft_ids: [draft.body.draft_id] });
  assert.equal(exported.body.exported, 0);
  assert.equal(exported.body.blocked[0].reason, "packet-stale");
});

test("verified person corrections are usable and invalidate unexported work", async () => {
  const env = makeEnv();
  const { campaignId, orgId } = await setupCampaignWithProspect(env);
  const dossier = await call(env, "GET", `/api/organizations/${orgId}/dossier`);
  const person = dossier.body.people[0];
  const draft = await call(env, "POST", "/api/drafts", {
    campaign_id: campaignId, organization_id: orgId, person_id: person.id, channel: "linkedin-manual",
  });
  assert.equal(draft.status, 201);
  const corrected = await call(env, "PATCH", `/api/people/${person.id}`, {
    full_name: person.full_name, title: "Founder and Owner",
    public_profile_url: "https://linkedin.com/in/fixture-dana-corrected",
    observed_at: "2026-07-15", confirmed: true,
  });
  assert.equal(corrected.status, 200);
  assert.equal(corrected.body.drafts_invalidated, 1);
  const after = await call(env, "GET", `/api/organizations/${orgId}/dossier`);
  assert.equal(after.body.people[0].title, "Founder and Owner");
  assert.equal(after.body.drafts.find((item) => item.id === draft.body.draft_id).status, "killed");
  const queue = await call(env, "GET", `/api/campaigns/${campaignId}/queue`);
  assert.equal(queue.body.queue.find((item) => item.organization.id === orgId).rule_ready, false);
});

test("latest dossier audit must be accurate before drafting", async () => {
  const env = makeEnv();
  const { campaignId, orgId } = await setupCampaignWithProspect(env);
  await call(env, "POST", `/api/campaigns/${campaignId}/organizations/${orgId}/audit`, {
    verdict: "partly-accurate", notes: "One material fact needs revision",
  });
  const blocked = await call(env, "POST", "/api/drafts", {
    campaign_id: campaignId, organization_id: orgId, channel: "dm",
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, "dossier-not-accurate");
  const unchecked = await call(env, "POST", `/api/campaigns/${campaignId}/organizations/${orgId}/audit`, {
    verdict: "accurate", notes: "Attempted to approve without completing the required checks",
  });
  assert.equal(unchecked.status, 422);
  assert.equal(unchecked.body.error, "audit-checklist-incomplete");
  await call(env, "POST", `/api/campaigns/${campaignId}/organizations/${orgId}/audit`, {
    verdict: "accurate", notes: "Rechecked after correction", checklist: AUDIT_CHECKLIST,
  });
  assert.equal((await call(env, "POST", "/api/drafts", {
    campaign_id: campaignId, organization_id: orgId, channel: "dm",
  })).status, 201);
});

test("any campaign evidence change invalidates the dossier audit until it is repeated", async () => {
  const env = makeEnv();
  const { campaignId, orgId } = await setupCampaignWithProspect(env);
  await call(env, "POST", `/api/organizations/${orgId}/evidence`, {
    claim: "The official site now lists emergency repair service",
    source_url: "https://fixture-harbor-roofing.example/emergency",
    observed_at: "2026-07-15", strength: "first-party", campaign_id: campaignId,
    reviewer_state: "accepted",
  });
  const stale = await call(env, "POST", "/api/drafts", {
    campaign_id: campaignId, organization_id: orgId, channel: "dm",
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "dossier-changed-since-audit");
  await call(env, "POST", `/api/campaigns/${campaignId}/organizations/${orgId}/audit`, {
    verdict: "accurate", notes: "Rechecked the expanded evidence set", checklist: AUDIT_CHECKLIST,
  });
  const staleScore = await call(env, "POST", "/api/drafts", {
    campaign_id: campaignId, organization_id: orgId, channel: "dm",
  });
  assert.equal(staleScore.body.error, "scores-stale");
  await call(env, "POST", `/api/campaigns/${campaignId}/organizations/${orgId}/score`, {
    fit_inputs: { offer_match: 1, timing_signal: 1, geography: 1, economics: 1, capacity_growth: 1, reachable: 1 },
    contact_verified: true,
  });
  assert.equal((await call(env, "POST", "/api/drafts", {
    campaign_id: campaignId, organization_id: orgId, channel: "dm",
  })).status, 201);
});

test("audit, scoring, and drafting stay inside the organization campaign boundary", async () => {
  const env = makeEnv();
  const { orgId } = await setupCampaignWithProspect(env);
  const secondCampaign = (await call(env, "POST", "/api/campaigns", {
    ...CAMPAIGN, name: "Second offer", offer: "We improve conversion copy for qualified service businesses",
  })).body.campaign.id;
  const wrongAudit = await call(env, "POST", `/api/campaigns/${secondCampaign}/organizations/${orgId}/audit`, {
    verdict: "accurate", notes: "Should not cross-link a dossier", checklist: AUDIT_CHECKLIST,
  });
  assert.equal(wrongAudit.body.error, "organization-not-in-campaign");
  assert.equal((await call(env, "POST", `/api/campaigns/${secondCampaign}/organizations/${orgId}/score`, {
    fit_inputs: {}, contact_verified: false,
  })).body.error, "organization-not-in-campaign");
  await call(env, "POST", `/api/organizations/${orgId}/evidence`, {
    claim: "Harbor Roofing publishes a quote-request page",
    source_url: "https://fixture-harbor-roofing.example/quote", observed_at: "2026-07-15",
    strength: "first-party", campaign_id: secondCampaign, reviewer_state: "accepted",
  });
  await call(env, "POST", `/api/campaigns/${secondCampaign}/organizations/${orgId}/audit`, {
    verdict: "accurate", notes: "Checked only second-campaign evidence", checklist: AUDIT_CHECKLIST,
  });
  await call(env, "POST", `/api/campaigns/${secondCampaign}/organizations/${orgId}/score`, {
    fit_inputs: { offer_match: 1, timing_signal: 1, geography: 1, economics: 1, capacity_growth: 1, reachable: 1 },
    contact_verified: true,
  });
  const draft = await call(env, "POST", "/api/drafts", {
    campaign_id: secondCampaign, organization_id: orgId, channel: "dm",
  });
  assert.equal(draft.status, 201);
  assert.match(draft.body.body, /quote-request page/);
  assert.doesNotMatch(draft.body.body, /commercial roofing as a primary service/);
});

test("one initial outreach and one seven-day follow-up are enforced server-side", async () => {
  const env = makeEnv();
  const { campaignId, orgId } = await setupCampaignWithProspect(env);
  const initial = await call(env, "POST", "/api/drafts", {
    campaign_id: campaignId, organization_id: orgId, channel: "linkedin-manual", outreach_kind: "initial",
  });
  const packet = await call(env, "GET", `/api/drafts/${initial.body.draft_id}/packet`);
  await call(env, "POST", `/api/drafts/${initial.body.draft_id}/approve`, {
    packet_hash: packet.body.packet_hash, contacted_elsewhere: "no",
  });
  await call(env, "POST", "/api/exports", { draft_ids: [initial.body.draft_id] });
  await call(env, "POST", "/api/attempts", {
    campaign_id: campaignId, organization_id: orgId, draft_id: initial.body.draft_id,
    channel: "linkedin-manual", direction: "outbound", status: "sent",
  });
  const secondInitial = await call(env, "POST", "/api/drafts", {
    campaign_id: campaignId, organization_id: orgId, channel: "dm", outreach_kind: "initial",
  });
  assert.equal(secondInitial.status, 409);
  assert.match(secondInitial.body.error, /initial/);
  const early = await call(env, "POST", "/api/drafts", {
    campaign_id: campaignId, organization_id: orgId, channel: "dm", outreach_kind: "follow-up",
  });
  assert.equal(early.body.error, "follow-up-too-early");
  env.DB._raw.prepare("UPDATE contact_attempts SET occurred_at = '2026-07-01T12:00:00.000Z' WHERE status = 'sent'").run();
  const followup = await call(env, "POST", "/api/drafts", {
    campaign_id: campaignId, organization_id: orgId, channel: "dm", outreach_kind: "follow-up",
  });
  assert.equal(followup.status, 201);
  const secondFollowup = await call(env, "POST", "/api/drafts", {
    campaign_id: campaignId, organization_id: orgId, channel: "dm", outreach_kind: "follow-up",
  });
  assert.equal(secondFollowup.body.error, "existing-follow-up");
});

test("external prior contact blocks a new initial and remains outcome-trackable", async () => {
  const env = makeEnv();
  const { campaignId, orgId } = await setupCampaignWithProspect(env);
  const draft = await call(env, "POST", "/api/drafts", {
    campaign_id: campaignId, organization_id: orgId, channel: "linkedin-manual",
  });
  assert.equal(draft.status, 201);

  const external = await call(env, "POST", "/api/attempts/external", {
    campaign_id: campaignId, organization_id: orgId, channel: "linkedin-manual",
    contacted_on: "2026-07-10", notes: "Messaged directly in LinkedIn before using Reachwright",
  });
  assert.equal(external.status, 201);
  assert.equal(external.body.source, "external");
  const drafts = await call(env, "GET", "/api/drafts");
  assert.equal(drafts.body.drafts.find((item) => item.id === draft.body.draft_id).status, "killed");

  const duplicate = await call(env, "POST", "/api/attempts/external", {
    campaign_id: campaignId, organization_id: orgId, channel: "linkedin-manual",
    contacted_on: "2026-07-10", notes: "Duplicate entry",
  });
  assert.equal(duplicate.body.error, "external-contact-already-recorded");
  assert.equal((await call(env, "POST", "/api/drafts", {
    campaign_id: campaignId, organization_id: orgId, channel: "dm", outreach_kind: "initial",
  })).body.error, "initial-already-sent");
  assert.equal((await call(env, "POST", "/api/drafts", {
    campaign_id: campaignId, organization_id: orgId, channel: "dm", outreach_kind: "follow-up",
  })).body.error, "follow-up-no-initial-send");

  const today = await call(env, "GET", "/api/today");
  assert.equal(today.body.tasks.find((task) => task.organization_id === orgId).kind, "record-outcome");
  assert.equal((await call(env, "POST", "/api/attempts", {
    campaign_id: campaignId, organization_id: orgId, channel: "linkedin-manual",
    direction: "inbound", status: "replied", notes: "Replied in LinkedIn",
  })).status, 201);
  const afterReply = await call(env, "GET", "/api/today");
  assert.equal(afterReply.body.tasks.some((task) => task.organization_id === orgId), false);
});

test("Today queue surfaces actionable dossier work and eligible follow-up", async () => {
  const env = makeEnv();
  const { campaignId, orgId } = await setupCampaignWithProspect(env);
  await call(env, "POST", `/api/organizations/${orgId}/evidence`, {
    claim: "A directory also lists the company",
    source_url: "https://directory.example/harbor", observed_at: "2026-07-15",
    strength: "secondary", campaign_id: campaignId,
  });
  const before = await call(env, "GET", "/api/today");
  assert.equal(before.status, 200);
  const beforeTasks = before.body.tasks.filter((task) => task.organization_id === orgId);
  assert.equal(beforeTasks.length, 1, "Today shows one next action per dossier");
  assert.equal(beforeTasks[0].kind, "review-evidence");
  await call(env, "PATCH", `/api/campaigns/${campaignId}`, { status: "paused" });
  assert.equal((await call(env, "GET", "/api/today")).body.tasks
    .some((task) => task.organization_id === orgId), false, "paused campaign work stays out of Today");
  await call(env, "PATCH", `/api/campaigns/${campaignId}`, { status: "researching" });

  const dossier = await call(env, "GET", `/api/organizations/${orgId}/dossier`);
  for (const item of dossier.body.evidence.filter((e) => e.reviewer_state === "unreviewed")) {
    await call(env, "PATCH", `/api/evidence/${item.id}`, { reviewer_state: "rejected" });
  }
  const changed = await call(env, "GET", "/api/today");
  assert.equal(changed.body.tasks.find((task) => task.organization_id === orgId).kind, "audit-dossier");
  await call(env, "POST", `/api/campaigns/${campaignId}/organizations/${orgId}/audit`, {
    verdict: "accurate", notes: "Reviewed all evidence states", checklist: AUDIT_CHECKLIST,
  });
  assert.equal((await call(env, "GET", "/api/today")).body.tasks
    .find((task) => task.organization_id === orgId).kind, "score-dossier");
  await call(env, "POST", `/api/campaigns/${campaignId}/organizations/${orgId}/score`, {
    fit_inputs: { offer_match: 1, timing_signal: 1, geography: 1, economics: 1, capacity_growth: 1, reachable: 1 },
    contact_verified: true,
  });
  assert.equal((await call(env, "GET", "/api/today")).body.tasks
    .find((task) => task.organization_id === orgId).kind, "draft-outreach");

  const draft = await call(env, "POST", "/api/drafts", {
    campaign_id: campaignId, organization_id: orgId, channel: "linkedin-manual",
  });
  const packet = await call(env, "GET", `/api/drafts/${draft.body.draft_id}/packet`);
  await call(env, "POST", `/api/drafts/${draft.body.draft_id}/approve`, {
    packet_hash: packet.body.packet_hash, contacted_elsewhere: "no",
  });
  await call(env, "POST", "/api/exports", { draft_ids: [draft.body.draft_id] });
  await call(env, "POST", "/api/attempts", {
    campaign_id: campaignId, organization_id: orgId, draft_id: draft.body.draft_id,
    channel: "linkedin-manual", direction: "outbound", status: "sent",
  });
  env.DB._raw.prepare("UPDATE contact_attempts SET occurred_at = '2026-07-01T12:00:00.000Z' WHERE status = 'sent'").run();
  const after = await call(env, "GET", "/api/today");
  assert.ok(after.body.tasks.some((task) => task.organization_id === orgId && task.kind === "follow-up-due"));
  assert.equal(after.body.tasks.filter((task) => task.organization_id === orgId).length, 1);
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

test("an accurate audit cannot certify an unreviewed, provider-only dossier", async () => {
  const env = makeEnv();
  const created = await call(env, "POST", "/api/campaigns", CAMPAIGN);
  const campaignId = created.body.campaign.id;
  await call(env, "PATCH", `/api/campaigns/${campaignId}`, { status: "researching" });
  const search = await call(env, "POST", `/api/campaigns/${campaignId}/search`, {});
  const orgId = search.body.organization_ids[0]; // only provider (secondary) evidence exists
  const audited = await call(env, "POST", `/api/campaigns/${campaignId}/organizations/${orgId}/audit`, {
    verdict: "accurate", notes: "Identity checked; evidence remains insufficient for a draft", checklist: AUDIT_CHECKLIST,
  });
  assert.equal(audited.status, 409);
  assert.equal(audited.body.error, "audit-incomplete");
  assert.equal(audited.body.unresolved.unreviewed, 2);
  assert.equal(audited.body.unresolved.accepted_strong, 0);
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
  const withoutSend = await call(env, "POST", "/api/attempts", {
    campaign_id: campaignId, organization_id: orgId, person_id: personId,
    channel: "dm", direction: "inbound", status: "opted-out",
  });
  assert.equal(withoutSend.body.error, "outcome-without-send");
  const draft = await call(env, "POST", "/api/drafts", {
    campaign_id: campaignId, organization_id: orgId, person_id: personId, channel: "dm",
  });
  const packet = await call(env, "GET", `/api/drafts/${draft.body.draft_id}/packet`);
  await call(env, "POST", `/api/drafts/${draft.body.draft_id}/approve`, {
    packet_hash: packet.body.packet_hash, contacted_elsewhere: "no",
  });
  await call(env, "POST", "/api/exports", { draft_ids: [draft.body.draft_id] });
  assert.equal((await call(env, "POST", "/api/attempts", {
    campaign_id: campaignId, organization_id: orgId, person_id: personId, draft_id: draft.body.draft_id,
    channel: "dm", direction: "inbound", status: "sent",
  })).body.error, "attempt-direction-mismatch");
  await call(env, "POST", "/api/attempts", {
    campaign_id: campaignId, organization_id: orgId, person_id: personId, draft_id: draft.body.draft_id,
    channel: "dm", direction: "outbound", status: "sent",
  });
  await call(env, "POST", "/api/attempts", {
    campaign_id: campaignId, organization_id: orgId, person_id: personId, draft_id: draft.body.draft_id,
    channel: "dm", direction: "inbound", status: "opted-out", notes: "Asked not to be contacted",
  });
  const after = await call(env, "GET", `/api/organizations/${orgId}/dossier`);
  assert.equal(after.body.suppression.suppressed, true);
  const blocked = await call(env, "POST", "/api/drafts", {
    campaign_id: campaignId, organization_id: orgId, channel: "linkedin-manual",
  });
  assert.equal(blocked.status, 409);
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
  assert.equal(dashboard.body.rule_ready_dossiers, 1);
  assert.equal(dashboard.body.calls_held, 0);
  const report = await call(env, "GET", `/api/reports/campaigns/${campaignId}`);
  assert.ok(report.body.provider_usage.length > 0, "provider usage is tracked");
  assert.equal(report.body.rule_ready_dossiers, 1);
  assert.equal(report.body.calls_held, 0);
  assert.equal(report.body.bookings_booked, 0);
});
