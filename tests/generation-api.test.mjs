import test from "node:test";
import assert from "node:assert/strict";
import { createFakeD1 } from "./helpers/fake-d1.mjs";
import { handleRequest } from "../worker-api/src/index.js";

const TOKEN = "test-operator-token-generation-0123456789";

function env() {
  return {
    DB: createFakeD1(), OPERATOR_TOKEN: TOKEN, APP_ORIGIN: "http://localhost:8123",
    DEV_FIXTURES: "false", HUNTER_API_KEY: "hunter-test", PROSPECT_PROVIDER: "auto",
    EMAIL_GATE_PASSED: "false", BODY_MAX_BYTES: "65536", PROVIDER_TIMEOUT_MS: "1000",
    PROVIDER_CREDIT_CEILING: "50", WEBSITE_RESEARCH_TIMEOUT_MS: "1000",
  };
}

async function call(state, method, path, body) {
  const response = await handleRequest(new Request(`https://api.test${path}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`,
      ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), state);
  return { status: response.status, body: await response.json() };
}

const campaign = {
  name: "Reemergence Generate 5", owner: "michael",
  offer: "Reemergence improves website conversion, messaging, lead capture, and growth systems",
  icp: "owner-led roofing and home-service businesses", geography: "Champaign, Illinois",
  positive_signals: ["roofing"], disqualifiers: ["franchise headquarters"],
  min_economics: "operator must confirm", allowed_channels: ["email", "linkedin-manual"],
  max_batch_size: 25,
};

test("one generation command overfetches and produces five review-ready, evidence-only packets", async () => {
  const originalFetch = globalThis.fetch;
  const domains = Array.from({ length: 8 }, (_, index) => `qualified-${index + 1}.example.test`);
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === "api.hunter.io" && url.pathname.endsWith("/discover")) {
      return new Response(JSON.stringify({ data: domains.map((domain, index) => ({
        domain, organization: `Qualified Business ${index + 1}`,
      })), meta: { results: domains.length, limit: 100, offset: 0 } }),
      { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.hostname === "api.hunter.io" && url.pathname.endsWith("/domain-search")) {
      const domain = url.searchParams.get("domain");
      const index = domains.indexOf(domain) + 1;
      return new Response(JSON.stringify({ data: { domain, organization: `Qualified Business ${index}`,
        emails: [{ value: `owner${index}@${domain}`, first_name: `Avery${index}`, last_name: "Owner",
          position: "Owner", seniority: "executive", verification: { status: "valid", date: "2026-07-16" } }] } }),
      { status: 200, headers: { "content-type": "application/json" } });
    }
    if (domains.includes(url.hostname)) {
      const index = domains.indexOf(url.hostname) + 1;
      const html = `<!doctype html><html><head><title>Qualified Business ${index}</title>
        <meta name="viewport" content="width=device-width"><meta name="description" content="Roofing services in Champaign"></head>
        <body><h1>Qualified Business ${index} roofing services</h1><form><input name="email" type="email"></form>
        <a href="mailto:owner${index}@${url.hostname}">Email the owner</a><footer>Copyright 2021</footer></body></html>`;
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    }
    return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  };

  try {
    const state = env();
    const createdCampaign = await call(state, "POST", "/api/campaigns", campaign);
    assert.equal(createdCampaign.status, 201);
    const generation = await call(state, "POST", "/api/generation-runs", {
      campaign_id: createdCampaign.body.campaign.id, target_ready: 5, candidate_cap: 8,
      credit_budget: 8, keywords: ["roofing"], locations: ["Champaign, Illinois"],
      start_immediately: true, initial_batch: 5,
    });
    assert.equal(generation.status, 201);
    assert.equal(generation.body.run.status, "completed");
    assert.equal(generation.body.run.counts.message_ready, 5);
    assert.equal(generation.body.candidates.filter((item) => item.stage === "message-ready").length, 5);
    assert.ok(generation.body.run.counts.candidate_to_ready_yield > 0);
    assert.equal(generation.body.run.counts.provider_credits_estimated, 5);

    const candidate = generation.body.candidates.find((item) => item.stage === "message-ready");
    const packetResult = await call(state, "GET",
      `/api/generation-runs/${generation.body.run.id}/candidates/${candidate.id}/packet`);
    assert.equal(packetResult.status, 200);
    const packet = packetResult.body.packet;
    assert.equal(packet.message_options.length, 3);
    assert.ok(packet.cited_facts.every((fact) => fact.source_url.startsWith("https://")));
    assert.equal(packet.contact_route.verification_state, "first-party",
      "the owner email published on the official site outranks the provider assertion");
    assert.ok(packet.recommended_service.name);

    const evidenceDecisions = Object.fromEntries(packet.review_items.map((item) => [
      item.id, item.source_url.startsWith("https://") ? "accepted" : "rejected",
    ]));
    const approved = await call(state, "POST",
      `/api/generation-runs/${generation.body.run.id}/candidates/${candidate.id}/decision`, {
        action: "approve", packet_hash: packetResult.body.packet_hash,
        evidence_decisions: evidenceDecisions,
        checklist: { identity_verified: true, offer_signal_verified: true, geography_verified: true,
          decision_maker_verified: true, contact_path_verified: true, contradictions_checked: true },
        use_recommended_scores: true,
        selected_message_option_id: packet.message_options[0].id,
        reason: "Opened the official site and confirmed identity, contact, and every accepted claim",
      });
    assert.equal(approved.status, 201);
    assert.equal(approved.body.draft_status, "draft");
    const packetAfter = await call(state, "GET",
      `/api/generation-runs/${generation.body.run.id}/candidates/${candidate.id}/packet`);
    assert.equal(packetAfter.body.status, "approved");

    const freshRun = await call(state, "POST", "/api/generation-runs", {
      campaign_id: createdCampaign.body.campaign.id, target_ready: 1, candidate_cap: 5,
      credit_budget: 2, keywords: ["roofing"], locations: ["Champaign, Illinois"],
      start_immediately: false,
    });
    assert.equal(freshRun.status, 201);
    assert.equal(freshRun.body.run.status, "failed");
    assert.equal(freshRun.body.candidates.length, 0,
      "fresh runs skip companies already processed in the same campaign instead of recycling the queue");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("generation honestly exhausts a candidate pool and never upgrades unverified contacts", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "api.hunter.io" && url.pathname.endsWith("/discover")) {
      return new Response(JSON.stringify({ data: [
        { domain: "no-owner.example.test", organization: "No Owner Business" },
        { domain: "second-no-owner.example.test", organization: "Second No Owner" },
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.hostname === "api.hunter.io" && url.pathname.endsWith("/domain-search")) {
      return new Response(JSON.stringify({ data: { emails: [] } }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.hostname.endsWith("example.test")) {
      return new Response("<html><head><title>Business</title></head><body><h1>Services</h1></body></html>",
        { status: 200, headers: { "content-type": "text/html" } });
    }
    return new Response("not found", { status: 404 });
  };
  try {
    const state = env();
    const created = await call(state, "POST", "/api/campaigns", campaign);
    const result = await call(state, "POST", "/api/generation-runs", {
      campaign_id: created.body.campaign.id, target_ready: 5, candidate_cap: 5,
      credit_budget: 5, start_immediately: true, initial_batch: 2,
    });
    assert.equal(result.status, 201);
    assert.equal(result.body.run.status, "partial");
    assert.equal(result.body.run.counts.message_ready, 0);
    assert.ok(result.body.candidates.every((item) => item.stage === "rejected"));
    assert.ok(result.body.candidates.every((item) => item.rejection_reason === "no-observable-buying-capacity"));
  } finally { globalThis.fetch = originalFetch; }
});

test("the default prospect feed is broad, live-source-only, and ready to replenish", async () => {
  const state = env();
  const result = await call(state, "GET", "/api/prospect-feed");
  assert.equal(result.status, 200);
  assert.equal(result.body.campaign.id, "rw-c-copywriting-feed");
  assert.equal(result.body.campaign.positive_signals.length, 12);
  assert.ok(result.body.campaign.positive_signals.includes("marketing agency"));
  assert.ok(result.body.campaign.positive_signals.includes("SaaS"));
  assert.equal(result.body.prospects.length, 0);
  assert.equal(result.body.needs_refill, true);
  assert.equal(result.body.refill.candidate_cap, 40);
});
