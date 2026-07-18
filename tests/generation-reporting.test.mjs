import test from "node:test";
import assert from "node:assert/strict";
import { createFakeD1 } from "./helpers/fake-d1.mjs";
import { handleRequest } from "../worker-api/src/index.js";

const TOKEN = "test-operator-token-feedback-0123456789";

function makeEnv() {
  return {
    DB: createFakeD1(), OPERATOR_TOKEN: TOKEN, APP_ORIGIN: "http://localhost:8123",
    DEV_FIXTURES: "false", HUNTER_API_KEY: "hunter-test", PROSPECT_PROVIDER: "auto",
    EMAIL_GATE_PASSED: "false", BODY_MAX_BYTES: "65536", PROVIDER_TIMEOUT_MS: "1000",
    PROVIDER_CREDIT_CEILING: "50", WEBSITE_RESEARCH_TIMEOUT_MS: "1000",
  };
}

async function call(state, method, path, body) {
  const response = await handleRequest(new Request(`https://api.test${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`,
      ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), state);
  return { status: response.status, body: await response.json() };
}

const baseCampaign = {
  name: "Feedback proof", owner: "michael",
  offer: "A focused Reemergence growth-system engagement",
  icp: "owner-led local service businesses", geography: "Illinois",
  positive_signals: ["roofing"], disqualifiers: ["franchise headquarters"],
  min_economics: "operator confirms economics", allowed_channels: ["email", "linkedin-manual"],
  max_batch_size: 25,
};

test("client offers, campaigns, and reports stay logically client-scoped", async () => {
  const state = makeEnv();
  const first = await call(state, "POST", "/api/clients", {
    name: "Client Alpha", owner: "michael", mode: "managed-client",
  });
  const second = await call(state, "POST", "/api/clients", {
    name: "Client Beta", owner: "michael", mode: "managed-client",
  });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const offer = await call(state, "POST", `/api/clients/${first.body.client.id}/offers`, {
    name: "Alpha managed service", description: "Alpha's customer-facing offer",
    ideal_customer: "Independent firms", proof_points: ["Operator-confirmed case study"],
    economics_note: "Confirm economics per campaign",
  });
  assert.equal(offer.status, 201);

  const campaign = await call(state, "POST", "/api/campaigns", {
    ...baseCampaign, client_id: first.body.client.id, client_offer_id: offer.body.offer.id,
  });
  assert.equal(campaign.status, 201);
  assert.equal(campaign.body.campaign.client_id, first.body.client.id);
  assert.equal(campaign.body.campaign.client_offer_snapshot.name, "Alpha managed service");

  const crossClient = await call(state, "POST", "/api/campaigns", {
    ...baseCampaign, name: "Invalid cross-client campaign", client_id: second.body.client.id,
    client_offer_id: offer.body.offer.id,
  });
  assert.equal(crossClient.status, 422);
  assert.equal(crossClient.body.error, "client-offer-not-found");

  const alphaReport = await call(state, "GET", `/api/reports/clients/${first.body.client.id}`);
  const betaReport = await call(state, "GET", `/api/reports/clients/${second.body.client.id}`);
  assert.equal(alphaReport.status, 200);
  assert.equal(alphaReport.body.markets.length, 1);
  assert.equal(betaReport.body.markets.length, 0);
  assert.match(alphaReport.body.isolation_note, /operator-only/);
});

test("generation reporting attributes yield, message strategy, held calls, and paid sales without fan-out", async () => {
  const originalFetch = globalThis.fetch;
  const domain = "feedback-qualified.example.test";
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "api.hunter.io" && url.pathname.endsWith("/discover")) {
      return new Response(JSON.stringify({ data: [{ domain, organization: "Feedback Qualified" }] }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.hostname === "api.hunter.io" && url.pathname.endsWith("/domain-search")) {
      return new Response(JSON.stringify({ data: { domain, organization: "Feedback Qualified", emails: [{
        value: `owner@${domain}`, first_name: "Jamie", last_name: "Owner", position: "Owner",
        seniority: "executive", verification: { status: "valid", date: "2026-07-16" },
      }] } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.hostname === domain) {
      return new Response(`<!doctype html><html><head><title>Feedback Qualified</title>
        <meta name="viewport" content="width=device-width"><meta name="description" content="Roofing in Illinois"></head>
        <body><h1>Feedback Qualified roofing</h1><form><input name="email" type="email"></form><a href="mailto:owner@${domain}">Email</a>
        <footer>Copyright 2020</footer></body></html>`,
      { status: 200, headers: { "content-type": "text/html" } });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const state = makeEnv();
    const createdCampaign = await call(state, "POST", "/api/campaigns", baseCampaign);
    const campaignId = createdCampaign.body.campaign.id;
    const generated = await call(state, "POST", "/api/generation-runs", {
      campaign_id: campaignId, target_ready: 1, candidate_cap: 5, credit_budget: 5,
      keywords: ["roofing"], locations: ["Illinois"], start_immediately: true, initial_batch: 1,
    });
    assert.equal(generated.status, 201);
    const candidate = generated.body.candidates.find((row) => row.stage === "message-ready");
    assert.ok(candidate);
    const packetResult = await call(state, "GET",
      `/api/generation-runs/${generated.body.run.id}/candidates/${candidate.id}/packet`);
    const packet = packetResult.body.packet;
    const approved = await call(state, "POST",
      `/api/generation-runs/${generated.body.run.id}/candidates/${candidate.id}/decision`, {
        action: "approve", packet_hash: packetResult.body.packet_hash,
        evidence_decisions: Object.fromEntries(packet.review_items.map((item) => [
          item.id, item.source_url.startsWith("https://") ? "accepted" : "rejected",
        ])),
        checklist: { identity_verified: true, offer_signal_verified: true, geography_verified: true,
          decision_maker_verified: true, contact_path_verified: true, contradictions_checked: true },
        use_recommended_scores: true, selected_message_option_id: packet.message_options[0].id,
        reason: "All accepted facts and the current decision-maker were manually checked",
      });
    assert.equal(approved.status, 201);

    const raw = state.DB._raw;
    const now = "2026-07-16T12:00:00.000Z";
    const insertAttempt = raw.prepare(`INSERT INTO contact_attempts
      (id, campaign_id, organization_id, person_id, draft_id, channel, direction, status, content_hash, notes, occurred_at)
      VALUES (?, ?, ?, ?, ?, 'email', 'outbound', ?, '', '', ?)`);
    insertAttempt.run("rw-t-feedback-sent", campaignId, candidate.organization_id,
      candidate.primary_person_id, approved.body.draft_id, "sent", now);
    insertAttempt.run("rw-t-feedback-reply", campaignId, candidate.organization_id,
      candidate.primary_person_id, approved.body.draft_id, "replied", now);
    insertAttempt.run("rw-t-feedback-positive", campaignId, candidate.organization_id,
      candidate.primary_person_id, approved.body.draft_id, "positive-reply", now);

    const salesCall = await call(state, "POST", "/api/sales/calls", {
      prospect_name: "Spoofed name", contact_title: "Unknown", business_name: "Spoofed business",
      company_website: "https://spoofed.example", linkedin_profile_url: "https://www.linkedin.com/in/jamie-owner",
      source_context: "Generated outreach reply", scheduled_for: "2026-07-17T09:00:00-05:00",
      timezone: "America/Chicago", generation_candidate_id: candidate.id,
    });
    assert.equal(salesCall.status, 201);
    assert.equal(salesCall.body.call.attribution.campaign_id, campaignId);
    assert.equal(salesCall.body.call.attribution.generation_candidate_id, candidate.id);
    assert.equal(salesCall.body.call.prospect.business_name, "Feedback Qualified");
    raw.prepare(`UPDATE bookings SET status = 'held', payment_status = 'operator-confirmed-paid',
      payment_confirmed_at = ? WHERE id = ?`).run(now, salesCall.body.call.id);

    const report = await call(state, "GET", `/api/reports/campaigns/${campaignId}`);
    assert.equal(report.status, 200);
    const performance = report.body.generation_performance;
    assert.equal(performance.candidates_discovered, 1);
    assert.equal(performance.message_ready_prospects, 1);
    assert.equal(performance.message_options_prepared, 3);
    assert.equal(performance.messages_selected, 1);
    assert.equal(performance.messages_sent, 1);
    assert.equal(performance.replies, 1, "multiple reply-state rows do not fan out one candidate");
    assert.equal(performance.calls_held, 1);
    assert.equal(performance.operator_confirmed_sales, 1);
    assert.equal(performance.provider_credits_estimated, 1);
    assert.equal(report.body.feedback.by_strategy.length, 1);
    assert.equal(report.body.feedback.by_strategy[0].sent, 1);
    assert.equal(report.body.feedback.by_strategy[0].replies, 1);
    assert.equal(report.body.feedback.by_strategy[0].low_sample, true);

    const clientReport = await call(state, "GET", "/api/reports/clients/rw-client-reemergence");
    assert.equal(clientReport.body.generation_performance.operator_confirmed_sales, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
