import test from "node:test";
import assert from "node:assert/strict";
import { createFakeD1 } from "./helpers/fake-d1.mjs";
import { handleRequest } from "../worker-api/src/index.js";
import { evaluateCandidate, scoreDimension, parseModelRow, validateModelEdit, DIMENSION_KEYS }
  from "../worker-api/src/lib/market-model.js";

const TOKEN = "test-operator-token-market-0123456789abc";

function env() {
  return {
    DB: createFakeD1(), OPERATOR_TOKEN: TOKEN, APP_ORIGIN: "http://localhost:8123",
    DEV_FIXTURES: "false", EMAIL_GATE_PASSED: "false", BODY_MAX_BYTES: "65536",
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

// ------------------------------------------------------------ signal taxonomy

test("signal taxonomy seeds all five dimensions and stays editable", async () => {
  const state = env();
  const listed = await call(state, "GET", "/api/signals");
  assert.equal(listed.status, 200);
  const byDimension = new Map();
  for (const signal of listed.body.signals) {
    byDimension.set(signal.dimension, (byDimension.get(signal.dimension) || 0) + 1);
  }
  for (const dimension of ["icp-fit", "copy-opportunity", "buying-trigger", "evidence-quality", "reachability"]) {
    assert.ok((byDimension.get(dimension) || 0) >= 5, `${dimension} needs seeded signals`);
  }
  const messageMatch = listed.body.signals.find((signal) => signal.signal_type === "ad-to-page-mismatch");
  assert.equal(messageMatch.label, "Message-match opportunity", "labels stay respectful");
  assert.equal(messageMatch.dimension, "copy-opportunity");
  assert.equal(Number(messageMatch.qualifying), 1);

  const created = await call(state, "POST", "/api/signals", {
    dimension: "copy-opportunity", signal_type: "Menu PDF Only!", label: "Menu published as PDF only",
    description: "The only menu found is a PDF, with no HTML equivalent on the reviewed site.",
    detection: "manual", default_confidence: 65, recency_window_days: 90, qualifying: true,
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.signal.signal_type, "menu-pdf-only", "slugs normalize");

  const duplicate = await call(state, "POST", "/api/signals", {
    dimension: "copy-opportunity", signal_type: "menu-pdf-only", label: "Duplicate",
  });
  assert.equal(duplicate.status, 409);

  const badDimension = await call(state, "POST", "/api/signals", {
    dimension: "vibes", signal_type: "gut-feeling", label: "Gut feeling",
  });
  assert.equal(badDimension.status, 422);

  const patched = await call(state, "PATCH", `/api/signals/${created.body.signal.id}`, {
    default_confidence: 72, active: false, guidance: "Cite the PDF URL and the absent HTML page.",
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.signal.default_confidence, 72);
  assert.equal(Number(patched.body.signal.active), 0);

  const relisted = await call(state, "GET", "/api/signals?dimension=copy-opportunity");
  const persisted = relisted.body.signals.find((signal) => signal.id === created.body.signal.id);
  assert.equal(persisted.default_confidence, 72, "edits persist");
  assert.equal(persisted.guidance, "Cite the PDF URL and the absent HTML page.");
});

// ------------------------------------------------------------- scoring model

test("scoring model is editable with validated weights and persists", async () => {
  const state = env();
  const model = await call(state, "GET", "/api/scoring-model");
  assert.equal(model.status, 200);
  assert.equal(model.body.model.version, "copywriting-1.0");
  for (const key of DIMENSION_KEYS) {
    assert.ok(model.body.model.dimensions[key], `${key} dimension exists`);
    const sum = model.body.model.dimensions[key].factors.reduce((total, f) => total + f.weight, 0);
    assert.equal(sum, 100, `${key} weights sum to 100`);
  }
  assert.equal(model.body.model.hard_gates.length, 6);

  const brokenWeights = structuredClone(model.body.model.dimensions);
  brokenWeights.icp_fit.factors[0].weight = 99;
  const rejected = await call(state, "PATCH", "/api/scoring-model", { dimensions: brokenWeights });
  assert.equal(rejected.status, 422);
  assert.ok(rejected.body.details.some((detail) => detail.includes("sum to 100")));

  const renamedFactor = structuredClone(model.body.model.dimensions);
  renamedFactor.reachability.factors[0].factor = "vibes_alignment";
  const rejectedRename = await call(state, "PATCH", "/api/scoring-model", { dimensions: renamedFactor });
  assert.equal(rejectedRename.status, 422);

  const update = await call(state, "PATCH", "/api/scoring-model", {
    thresholds: { ...model.body.model.thresholds, copy_opportunity: 70 },
    notes: "Raised the opportunity bar after reviewing weak angles.",
  });
  assert.equal(update.status, 200);
  assert.equal(update.body.model.thresholds.copy_opportunity, 70);

  const reread = await call(state, "GET", "/api/scoring-model");
  assert.equal(reread.body.model.thresholds.copy_opportunity, 70, "threshold edit persists");
  assert.equal(reread.body.model.notes, "Raised the opportunity bar after reviewing weak angles.");

  const badPriority = await call(state, "PATCH", "/api/scoring-model", {
    priority_weights: { icp_fit: 90, copy_opportunity: 30, buying_capacity: 20,
      evidence_quality: 15, evidence_recency: 10, reachability: 10 },
  });
  assert.equal(badPriority.status, 422);
});

// --------------------------------------------------- deterministic evaluation

function fullInputs() {
  return {
    icp_fit: { industry_match: 1, geography_match: 1, business_model_match: 1,
      company_size_match: 1, service_value_match: 1, operating_capacity: 1 },
    copy_opportunity: { observable_signal: 1, asset_specific: 1, service_mapped: 1, signal_strength: 1 },
    buying_capacity: { trigger_present: 1, capacity_indicator: 1, trigger_recent: 1 },
    evidence_quality: { first_party: 1, source_cited: 1, corroborated: 1, contradictions_handled: 1 },
    evidence_recency: { opportunity_fresh: 1, trigger_fresh: 1, verified_recently: 1 },
    reachability: { role_appropriate: 1, route_verified: 1, channel_permitted: 1 },
  };
}

async function activeModel(state) {
  const model = await call(state, "GET", "/api/scoring-model");
  return parseModelRow({
    ...model.body.model,
    dimensions: JSON.stringify(model.body.model.dimensions),
    thresholds: JSON.stringify(model.body.model.thresholds),
    priority_weights: JSON.stringify(model.body.model.priority_weights),
    hard_gates: JSON.stringify(model.body.model.hard_gates),
    active: 1,
  });
}

test("hard gates: no dimension can compensate for another", async () => {
  const state = env();
  const model = await activeModel(state);

  const perfect = evaluateCandidate({ model, inputs: fullInputs() });
  assert.equal(perfect.qualified, true);
  assert.equal(perfect.overall_priority, 100);
  assert.ok(perfect.gates.every((gate) => gate.passed));

  // High ICP fit cannot compensate for no copy-opportunity evidence.
  const noOpportunity = fullInputs();
  noOpportunity.copy_opportunity = { observable_signal: 0, asset_specific: 0, service_mapped: 0, signal_strength: 0 };
  const failedOpportunity = evaluateCandidate({ model, inputs: noOpportunity });
  assert.equal(failedOpportunity.qualified, false);
  assert.equal(failedOpportunity.gates.find((gate) => gate.gate === "copy-opportunity-required").passed, false);
  assert.equal(failedOpportunity.dimensions.icp_fit.total, 100, "ICP score itself stays honest");

  // Strong opportunity cannot compensate for no buying capacity.
  const noCapacity = fullInputs();
  noCapacity.buying_capacity = { trigger_present: 0, capacity_indicator: 0, trigger_recent: 0 };
  const failedCapacity = evaluateCandidate({ model, inputs: noCapacity });
  assert.equal(failedCapacity.qualified, false);
  assert.equal(failedCapacity.gates.find((gate) => gate.gate === "buying-capacity-required").passed, false);

  // Stale evidence fails the evidence gate.
  const staleEvidence = fullInputs();
  staleEvidence.evidence_recency = { opportunity_fresh: 0, trigger_fresh: 0, verified_recently: 0 };
  const failedRecency = evaluateCandidate({ model, inputs: staleEvidence });
  assert.equal(failedRecency.qualified, false);
  assert.equal(failedRecency.gates.find((gate) => gate.gate === "evidence-required").passed, false);

  // No contact route fails reachability.
  const noRoute = fullInputs();
  noRoute.reachability = { role_appropriate: 0, route_verified: 0, channel_permitted: 0 };
  const failedRoute = evaluateCandidate({ model, inputs: noRoute });
  assert.equal(failedRoute.qualified, false);
  assert.equal(failedRoute.gates.find((gate) => gate.gate === "reachability-required").passed, false);

  // A recorded disqualifier fails the candidate outright.
  const disqualified = evaluateCandidate({ model, inputs: fullInputs(),
    disqualifiers: [{ rule: "franchise-headquarters", reason: "Campaign excludes franchise HQ operations." }] });
  assert.equal(disqualified.qualified, false);
  assert.equal(disqualified.gates.find((gate) => gate.gate === "no-disqualifiers").passed, false);
});

test("missing inputs score zero and surface as unknown — never guessed", async () => {
  const state = env();
  const model = await activeModel(state);
  const partial = fullInputs();
  delete partial.buying_capacity.capacity_indicator;
  partial.evidence_quality.corroborated = null;
  const result = evaluateCandidate({ model, inputs: partial });
  assert.ok(result.missing.includes("buying_capacity.capacity_indicator"));
  assert.ok(result.missing.includes("evidence_quality.corroborated"));
  const capacityFactor = result.dimensions.buying_capacity.factors
    .find((factor) => factor.factor === "capacity_indicator");
  assert.equal(capacityFactor.known, false);
  assert.equal(capacityFactor.points, 0);

  const scored = scoreDimension({ factors: [{ factor: "a", weight: 100, label: "a" }] }, {});
  assert.equal(scored.total, 0);
  assert.deepEqual(scored.missing, ["a"]);
});

test("preview endpoint evaluates deterministically over the stored model", async () => {
  const state = env();
  const preview = await call(state, "POST", "/api/scoring-model/preview", {
    inputs: fullInputs(),
    disqualifiers: [],
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.evaluation.qualified, true);
  const previewDq = await call(state, "POST", "/api/scoring-model/preview", {
    inputs: fullInputs(),
    disqualifiers: [{ rule: "icp-exclusion", reason: "Mature in-house copy team." }],
  });
  assert.equal(previewDq.body.evaluation.qualified, false);
});

test("validateModelEdit rejects structural drift", () => {
  const existing = {
    dimensions: { icp_fit: { factors: [{ factor: "industry_match", weight: 100, label: "industry" }] } },
  };
  assert.equal(validateModelEdit({}, existing).ok, true);
  const drifted = validateModelEdit({
    dimensions: { icp_fit: { factors: [{ factor: "other_factor", weight: 100, label: "x" }] } },
  }, existing);
  assert.equal(drifted.ok, false);
});

// ------------------------------------------------- copywriting service catalog

test("copywriting services are seeded with full model fields and stay editable", async () => {
  const state = env();
  const listed = await call(state, "GET", "/api/clients/rw-client-reemergence/services");
  assert.equal(listed.status, 200);
  const copywriting = listed.body.services.filter((service) => service.id.startsWith("rw-svc-"));
  assert.equal(copywriting.length, 14, "all fourteen copywriting services seeded");

  const messageMatch = listed.body.services.find((service) => service.id === "rw-svc-message-match");
  assert.equal(messageMatch.target_buyer, "Owner, marketing leader, or growth lead");
  assert.ok(messageMatch.prohibited_claims.includes("your funnel is leaking"));
  assert.ok(messageMatch.contact_roles.includes("marketing-director"));
  assert.ok(messageMatch.signal_types.includes("ad-to-page-mismatch"));

  const patched = await call(state, "PATCH", `/api/services/${messageMatch.id}`, {
    minimum_commercial_value: "Supports a $1,500+ project",
    buying_triggers: ["active-paid-advertising", "product-launch"],
    prohibited_claims: [...messageMatch.prohibited_claims, "you are wasting money"],
    active: false,
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.service.minimum_commercial_value, "Supports a $1,500+ project");
  assert.equal(Number(patched.body.service.active), 0, "services can be disabled");

  const reread = await call(state, "GET", "/api/clients/rw-client-reemergence/services");
  const persisted = reread.body.services.find((service) => service.id === messageMatch.id);
  assert.deepEqual(persisted.buying_triggers, ["active-paid-advertising", "product-launch"]);
  assert.ok(persisted.prohibited_claims.includes("you are wasting money"));

  const created = await call(state, "POST", "/api/clients/rw-client-reemergence/services", {
    name: "Website copy audit", description: "A written audit of one site's messaging.",
    entry_angle: "Lead with one cited observation.", signal_types: ["unclear-offer-rubric"],
    target_buyer: "Owner", contact_roles: ["owner", "founder"],
    permitted_claims: ["I reviewed your site on <date>"],
    prohibited_claims: ["your copy is bad"],
    typical_cta: "Offer the audit", next_step: "A short call",
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.service.contact_roles, ["owner", "founder"]);
});

// --------------------------------------------------------- campaign extensions

test("campaigns carry editable buying triggers and score thresholds", async () => {
  const state = env();
  const created = await call(state, "POST", "/api/campaigns", {
    name: "Copywriting — Champaign services", owner: "michael",
    offer: "Copywriting that connects real observations to one clear next step",
    icp: "Owner-led service businesses actively advertising",
    geography: "Champaign, Illinois",
    positive_signals: ["ad-to-page-mismatch", "proof-not-visible"],
    buying_triggers: ["active-paid-advertising", "hiring-current"],
    disqualifiers: ["franchise headquarters"],
    min_economics: "Supports a four-figure project",
    allowed_channels: ["email", "linkedin-manual"],
    score_thresholds: { copy_opportunity: 65, reachability: 70 },
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.campaign.buying_triggers, ["active-paid-advertising", "hiring-current"]);
  assert.equal(created.body.campaign.score_thresholds.copy_opportunity, 65);

  const badThreshold = await call(state, "POST", "/api/campaigns", {
    name: "Bad", owner: "michael", offer: "x", icp: "x", geography: "x",
    min_economics: "x", allowed_channels: ["email"],
    score_thresholds: { vibes: 200 },
  });
  assert.equal(badThreshold.status, 422);

  const patched = await call(state, "PATCH", `/api/campaigns/${created.body.campaign.id}`, {
    icp: "Owner-led service businesses and agencies actively advertising",
    buying_triggers: ["active-paid-advertising"],
    score_thresholds: { copy_opportunity: 70 },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.campaign.icp, "Owner-led service businesses and agencies actively advertising");
  assert.deepEqual(patched.body.campaign.buying_triggers, ["active-paid-advertising"]);

  const reread = await call(state, "GET", `/api/campaigns/${created.body.campaign.id}`);
  assert.equal(reread.body.campaign.score_thresholds.copy_opportunity, 70, "campaign edits persist");
});
