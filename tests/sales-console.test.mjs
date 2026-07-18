import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createFakeD1 } from "./helpers/fake-d1.mjs";
import { handleRequest } from "../worker-api/src/index.js";
import { SALES_OFFERS } from "../worker-api/src/routes/sales.js";

const TOKEN = "test-operator-token-0123456789abcdef";

function makeEnv(overrides = {}) {
  return {
    DB: createFakeD1(),
    OPERATOR_TOKEN: TOKEN,
    APP_ORIGIN: "http://localhost:8123",
    DEV_FIXTURES: "false",
    EMAIL_GATE_PASSED: "false",
    BODY_MAX_BYTES: "65536",
    REEMERGENCE_DIAGNOSTIC_PAYMENT_LINK: "https://buy.stripe.com/test_diagnostic",
    REEMERGENCE_PROOF_SPRINT_PAYMENT_LINK: "https://buy.stripe.com/test_proof",
    REEMERGENCE_RETAINER_PAYMENT_LINK: "https://buy.stripe.com/test_retainer",
    ...overrides,
  };
}

async function call(env, method, path, body, token = TOKEN) {
  const response = await handleRequest(new Request(`https://api.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }), env);
  return { status: response.status, body: await response.json() };
}

async function createCall(env, suffix = "one") {
  return call(env, "POST", "/api/sales/calls", {
    prospect_name: `Alex ${suffix}`,
    contact_title: "Founder",
    business_name: `Acme ${suffix}`,
    company_website: `https://acme-${suffix}.example`,
    linkedin_profile_url: `https://www.linkedin.com/in/alex-${suffix}`,
    source_context: "Warm LinkedIn reply; requested an early call.",
    scheduled_for: "2026-07-16T06:30:00-05:00",
    timezone: "America/Chicago",
  });
}

async function selectOffer(env, callId, offerId) {
  return call(env, "PATCH", `/api/sales/calls/${callId}/offer`, { offer_id: offerId });
}

async function signAgreement(env, callId) {
  assert.equal((await call(env, "POST", `/api/sales/calls/${callId}/agreement`, {
    status: "sent", note: "Agreement emailed",
  })).status, 200);
  return call(env, "POST", `/api/sales/calls/${callId}/agreement`, {
    status: "signed", note: "Signed copy stored in client folder",
  });
}

test("offer catalog is immutable and never exposes a payment URL", async () => {
  assert.ok(Object.isFrozen(SALES_OFFERS));
  assert.ok(SALES_OFFERS.every((offer) => Object.isFrozen(offer) && Object.isFrozen(offer.scope)));
  assert.throws(() => SALES_OFFERS.push({}));

  const env = makeEnv();
  const result = await call(env, "GET", "/api/sales/offers");
  assert.equal(result.status, 200);
  assert.equal(result.body.offers.length, 5);
  assert.deepEqual(result.body.offers.map((offer) => offer.price_label), [
    "Free", "$500 one time", "$1,200 one time", "$1,500 per month", "Custom scope",
  ]);
  const serialized = JSON.stringify(result.body);
  assert.equal(serialized.includes("buy.stripe.com"), false);
  assert.equal(serialized.includes("test_proof"), false);
  assert.equal(result.body.offers.find((offer) => offer.id === "growth-systems-proof-sprint").visibility,
    "private-qualified-only");
});

test("private checkout and unrelated product branding stay out of public and static assets", () => {
  const publicHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const appHtml = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
  const appJs = readFileSync(new URL("../app/app.js", import.meta.url), "utf8");
  assert.equal(publicHtml.includes("$1,200"), false, "the private Proof Sprint price is not public");
  assert.equal(publicHtml.includes("buy.stripe.com"), false, "public HTML contains no checkout capability URL");
  assert.equal(appJs.includes("buy.stripe.com"), false, "the operator bundle retrieves links from the API");
  assert.match(appHtml, /#\/sales/);
  assert.equal([publicHtml, appHtml, appJs].join("\n").toLowerCase().includes("sablescript"), false);
});

test("offer snapshots are server-derived and client prices are rejected", async () => {
  const env = makeEnv();
  const first = await createCall(env, "snapshot");
  const selected = await selectOffer(env, first.body.call.id, "growth-systems-diagnostic");
  assert.equal(selected.status, 200);
  assert.equal(selected.body.call.offer.snapshot.amount_cents, 50000);
  assert.equal(selected.body.call.offer.snapshot.name, "Reemergence Growth Systems Diagnostic");

  const second = await createCall(env, "spoof");
  const spoofed = await call(env, "PATCH", `/api/sales/calls/${second.body.call.id}/offer`, {
    offer_id: "growth-systems-diagnostic", amount_cents: 1,
  });
  assert.equal(spoofed.status, 422);
});

test("sales calls require a real booked LinkedIn profile and keep call truth independent", async () => {
  const env = makeEnv();
  const invalid = await call(env, "POST", "/api/sales/calls", {
    prospect_name: "Alex", business_name: "Acme",
    linkedin_profile_url: "https://example.com/alex",
    scheduled_for: "2026-07-16T06:30:00", timezone: "America/Chicago",
  });
  assert.equal(invalid.status, 422);

  const created = await createCall(env);
  assert.equal(created.status, 201);
  assert.equal(created.body.call.call.status, "booked");
  assert.equal(created.body.call.agreement.status, "not-required");
  assert.equal(created.body.call.payment.status, "not-required");
  assert.equal(created.body.call.prospect.source, "linkedin-manual");
  assert.equal(created.body.call.prospect.title, "Founder");
  assert.equal(created.body.call.prospect.company_website, "https://acme-one.example");
  assert.equal(created.body.call.prospect.source_context, "Warm LinkedIn reply; requested an early call.");

  const salesNavigator = await call(env, "POST", "/api/sales/calls", {
    prospect_name: "Dana Lead", contact_title: "CEO", business_name: "Navigator Co",
    linkedin_profile_url: "https://www.linkedin.com/sales/lead/ACwAAA123,NAME_SEARCH,abc1",
    scheduled_for: "2026-07-17T11:00:00-05:00", timezone: "America/Chicago",
  });
  assert.equal(salesNavigator.status, 201);

  const updated = await call(env, "PATCH", `/api/sales/calls/${created.body.call.id}`, {
    discovery: {
      primary_offer: "Commercial repair",
      primary_bottleneck: "Qualified conversations",
      constraint_reflection: "The immediate constraint is consistent follow-up.",
    },
    summary: "Qualified fit call; no commercial state inferred.",
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.call.call.discovery.primary_offer, "Commercial repair");
  assert.equal(updated.body.call.call.status, "booked");
  assert.equal(updated.body.call.agreement.status, "not-required");

  const unknownPrompt = await call(env, "PATCH", `/api/sales/calls/${created.body.call.id}`, {
    discovery: { invented_field: "no" },
  });
  assert.equal(unknownPrompt.status, 422);
});

test("Stripe link is gated by sequential agreement truth and paid needs a confirmation note", async () => {
  const env = makeEnv();
  const created = await createCall(env, "stripe");
  const id = created.body.call.id;
  const selected = await selectOffer(env, id, "growth-systems-diagnostic");
  assert.equal(selected.body.call.agreement.status, "not-sent");
  assert.equal(selected.body.call.payment.status, "not-sent");

  const tooEarly = await call(env, "GET", `/api/sales/calls/${id}/payment-link`);
  assert.equal(tooEarly.status, 409);
  assert.equal(tooEarly.body.error, "signed-agreement-required");

  const directSigned = await call(env, "POST", `/api/sales/calls/${id}/agreement`, {
    status: "signed", note: "Signed copy stored",
  });
  assert.equal(directSigned.status, 409);
  assert.equal(directSigned.body.error, "invalid-agreement-transition");

  assert.equal((await signAgreement(env, id)).status, 200);
  const changedOffer = await selectOffer(env, id, "growth-systems-retainer");
  assert.equal(changedOffer.status, 409);
  assert.equal(changedOffer.body.error, "offer-locked");

  const directPaid = await call(env, "POST", `/api/sales/calls/${id}/payment`, {
    status: "operator-confirmed-paid", note: "Seen in Stripe dashboard",
  });
  assert.equal(directPaid.status, 409);
  assert.equal(directPaid.body.error, "invalid-payment-transition");

  const released = await call(env, "GET", `/api/sales/calls/${id}/payment-link`);
  assert.equal(released.status, 200);
  assert.equal(released.body.payment_url, "https://buy.stripe.com/test_diagnostic");
  const afterRetrieve = await call(env, "GET", `/api/sales/calls/${id}`);
  assert.equal(afterRetrieve.body.call.payment.status, "not-sent", "retrieving is not sharing");
  assert.equal(afterRetrieve.body.call.call.status, "booked", "agreement/payment never imply held");

  const shared = await call(env, "POST", `/api/sales/calls/${id}/payment`, {
    status: "link-shared", note: "Shared manually in signed client's LinkedIn thread",
  });
  assert.equal(shared.status, 200);
  assert.equal(shared.body.call.payment.status, "link-shared");
  assert.equal(shared.body.call.payment.dispatch_note, "Shared manually in signed client's LinkedIn thread");

  const vague = await call(env, "POST", `/api/sales/calls/${id}/payment`, {
    status: "operator-confirmed-paid", note: "paid",
  });
  assert.equal(vague.status, 422);
  const paid = await call(env, "POST", `/api/sales/calls/${id}/payment`, {
    status: "operator-confirmed-paid", note: "Stripe dashboard payment pi_test confirmed",
  });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.call.payment.status, "operator-confirmed-paid");
  assert.equal(paid.body.call.call.status, "booked");

  const held = await call(env, "PATCH", `/api/sales/calls/${id}`, { status: "held" });
  assert.equal(held.status, 200);
  assert.equal(held.body.call.call.status, "held");
  assert.equal(held.body.call.payment.status, "operator-confirmed-paid");

  const auditDetails = env.DB._raw.prepare(
    "SELECT detail FROM audit_events WHERE subject_id = ? ORDER BY created_at",
  ).all(id).map((event) => event.detail).join("\n");
  assert.equal(auditDetails.includes("buy.stripe.com"), false);
  assert.equal(auditDetails.includes("pi_test"), false);
  assert.equal(auditDetails.includes("Shared manually in signed client's LinkedIn thread"), false);
});

test("missing payment-link configuration fails closed without advancing payment", async () => {
  const env = makeEnv({ REEMERGENCE_PROOF_SPRINT_PAYMENT_LINK: "" });
  const id = (await createCall(env, "missing-link")).body.call.id;
  await selectOffer(env, id, "growth-systems-proof-sprint");
  await signAgreement(env, id);
  const released = await call(env, "GET", `/api/sales/calls/${id}/payment-link`);
  assert.equal(released.status, 503);
  assert.equal(released.body.error, "payment-link-not-configured");
  const row = await call(env, "GET", `/api/sales/calls/${id}`);
  assert.equal(row.body.call.payment.status, "not-sent");
});

test("custom work requires an invoice before operator-confirmed payment", async () => {
  const env = makeEnv();
  const id = (await createCall(env, "custom")).body.call.id;
  await selectOffer(env, id, "custom-build");
  await signAgreement(env, id);

  const link = await call(env, "GET", `/api/sales/calls/${id}/payment-link`);
  assert.equal(link.status, 409);
  assert.equal(link.body.error, "invoice-required");
  const directPaid = await call(env, "POST", `/api/sales/calls/${id}/payment`, {
    status: "operator-confirmed-paid", note: "Bank transfer was confirmed",
  });
  assert.equal(directPaid.status, 409);

  const invoiced = await call(env, "POST", `/api/sales/calls/${id}/payment`, {
    status: "invoice-sent", note: "Invoice RH-2026-001 sent",
  });
  assert.equal(invoiced.status, 200);
  const paid = await call(env, "POST", `/api/sales/calls/${id}/payment`, {
    status: "operator-confirmed-paid", note: "Invoice RH-2026-001 cleared",
  });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.call.payment.status, "operator-confirmed-paid");
});

test("free consultation needs neither agreement nor payment; archive preserves audit truth", async () => {
  const env = makeEnv();
  const id = (await createCall(env, "free")).body.call.id;
  const selected = await selectOffer(env, id, "free-fit-consultation");
  assert.equal(selected.body.call.agreement.status, "not-required");
  assert.equal(selected.body.call.payment.status, "not-required");
  assert.equal((await call(env, "POST", `/api/sales/calls/${id}/agreement`, {
    status: "sent", note: "none",
  })).body.error, "agreement-not-required");
  assert.equal((await call(env, "GET", `/api/sales/calls/${id}/payment-link`)).body.error,
    "payment-not-required");

  const archived = await call(env, "DELETE", `/api/sales/calls/${id}`);
  assert.equal(archived.status, 200);
  assert.equal((await call(env, "GET", `/api/sales/calls/${id}`)).status, 404);
  const list = await call(env, "GET", "/api/sales/calls");
  assert.equal(list.body.calls.length, 0);
  const audit = env.DB._raw.prepare("SELECT action, detail FROM audit_events WHERE subject_id = ? ORDER BY created_at").all(id);
  assert.ok(audit.some((event) => event.action === "sales-call.archive"));
});

test("revenue command center derives the $10k gap from recorded sales and keeps planning assumptions editable", async () => {
  const env = makeEnv();
  const initial = await call(env, "GET", "/api/revenue-plan");
  assert.equal(initial.status, 200);
  assert.equal(initial.body.plan.target_mrr_cents, 1_000_000);
  assert.equal(initial.body.required.additional_recurring_clients, 7);
  assert.equal(initial.body.actual.recorded_mrr_cents, 0);
  assert.equal(initial.body.truth.assumptions_are_targets_not_benchmarks, true);

  const invalid = await call(env, "PATCH", "/api/revenue-plan", { target_mrr_cents: 1 });
  assert.equal(invalid.status, 422);
  const patched = await call(env, "PATCH", "/api/revenue-plan", {
    assumed_held_call_close_rate: 0.5,
    assumed_outreach_to_positive_reply_rate: 0.2,
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.plan.assumed_held_call_close_rate, 0.5);

  const id = (await createCall(env, "mrr")).body.call.id;
  await selectOffer(env, id, "growth-systems-retainer");
  await signAgreement(env, id);
  await call(env, "POST", `/api/sales/calls/${id}/payment`, {
    status: "link-shared", note: "Shared manually after the signed agreement",
  });
  await call(env, "POST", `/api/sales/calls/${id}/payment`, {
    status: "operator-confirmed-paid", note: "Stripe dashboard payment pi_mrr confirmed",
  });
  const afterSale = await call(env, "GET", "/api/revenue-plan");
  assert.equal(afterSale.body.actual.recorded_mrr_cents, 150_000);
  assert.equal(afterSale.body.actual.recurring_clients_recorded, 1);
  assert.equal(afterSale.body.actual.mrr_gap_cents, 850_000);
  assert.equal(afterSale.body.required.additional_recurring_clients, 6);
  assert.equal(afterSale.body.funnel.operator_confirmed_sales, 1);
});
