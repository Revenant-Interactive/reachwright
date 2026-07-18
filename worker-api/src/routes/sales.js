/**
 * Authenticated sales-call console.
 *
 * The offer catalog is immutable, server-owned commercial truth. Stripe URLs
 * live only in Worker secrets/vars and are released by a protected endpoint
 * after the agreement gate. Call, agreement, and payment state are deliberately
 * independent; "booked", "signed", and "paid" never imply one another.
 */

import { json, error, readBody } from "../index.js";
import { all, audit, one, run, parseJsonColumn } from "../db.js";
import { makeId, nowIso, validateBody, LIMITS } from "../lib/validate.js";

const freezeOffer = (offer) => Object.freeze({
  ...offer,
  scope: Object.freeze([...offer.scope]),
  boundaries: Object.freeze([...offer.boundaries]),
});

export const SALES_OFFERS = Object.freeze([
  freezeOffer({
    id: "free-fit-consultation", version: 1,
    name: "Free Growth Systems Fit Consultation",
    price_label: "Free", amount_cents: 0, cadence: "one-time",
    visibility: "shareable", payment_mode: "none", agreement_required: false,
    scope: ["30-minute fit conversation", "One agreed constraint and an honest next-step recommendation"],
    boundaries: ["No free implementation", "No guaranteed outcome"],
  }),
  freezeOffer({
    id: "growth-systems-diagnostic", version: 1,
    name: "Reemergence Growth Systems Diagnostic",
    price_label: "$500 one time", amount_cents: 50000, cadence: "one-time",
    visibility: "share-after-agreement", payment_mode: "stripe-link", agreement_required: true,
    scope: ["Business growth-system review", "Prioritized findings", "Practical next-step recommendation"],
    boundaries: ["Assessment, not implementation", "Third-party costs excluded", "No guaranteed outcome"],
  }),
  freezeOffer({
    id: "growth-systems-proof-sprint", version: 1,
    name: "Reemergence Growth Systems Proof Sprint — Private",
    price_label: "$1,200 one time", amount_cents: 120000, cadence: "one-time",
    visibility: "private-qualified-only", payment_mode: "stripe-link", agreement_required: true,
    scope: [
      "One business and one offer", "60-minute kickoff and growth-system diagnostic",
      "One selected implementation lane", "KPI baseline and 30/60/90-day action plan",
      "Handoff, two revisions, and seven days of clarification",
    ],
    boundaries: ["10 business days", "Maximum eight production hours", "No full website or custom app", "No open-ended management", "Third-party costs excluded", "No guaranteed outcome"],
  }),
  freezeOffer({
    id: "growth-systems-retainer", version: 1,
    name: "Reemergence Growth Systems Retainer",
    price_label: "$1,500 per month", amount_cents: 150000, cadence: "monthly",
    visibility: "share-after-agreement", payment_mode: "stripe-link", agreement_required: true,
    scope: ["Prioritized strategy and advisory", "One growth sprint per cycle", "Up to 12 production hours", "One KPI review"],
    boundaries: ["Prioritized capacity, not unlimited work", "Major builds separately scoped", "Third-party costs excluded", "No guaranteed outcome"],
  }),
  freezeOffer({
    id: "custom-build", version: 1,
    name: "Reemergence Custom Build",
    price_label: "Custom scope", amount_cents: null, cadence: "project",
    visibility: "qualified-only", payment_mode: "invoice", agreement_required: true,
    scope: ["Written, client-specific scope", "Milestones, acceptance terms, and price defined in the agreement"],
    boundaries: ["No work before signed agreement and cleared initial payment", "Third-party costs stated separately", "No guaranteed outcome"],
  }),
]);

const OFFER_BY_ID = new Map(SALES_OFFERS.map((offer) => [offer.id, offer]));
const PAYMENT_ENV = Object.freeze({
  "growth-systems-diagnostic": "REEMERGENCE_DIAGNOSTIC_PAYMENT_LINK",
  "growth-systems-proof-sprint": "REEMERGENCE_PROOF_SPRINT_PAYMENT_LINK",
  "growth-systems-retainer": "REEMERGENCE_RETAINER_PAYMENT_LINK",
});

const DISCOVERY_FIELDS = Object.freeze([
  "primary_offer", "ideal_customer", "customer_value", "current_acquisition",
  "ninety_day_goal", "primary_bottleneck", "business_consequence", "what_tried",
  "ten_lead_breakpoint", "constraint_reflection", "recommended_next_step",
]);

function publicOffer(offer, env) {
  const envName = PAYMENT_ENV[offer.id];
  return {
    id: offer.id, version: offer.version, name: offer.name, price_label: offer.price_label,
    amount_cents: offer.amount_cents, cadence: offer.cadence, visibility: offer.visibility,
    payment_mode: offer.payment_mode, agreement_required: offer.agreement_required,
    scope: [...offer.scope], boundaries: [...offer.boundaries],
    payment_link_configured: envName ? validStripeUrl(env[envName]) : offer.payment_mode !== "stripe-link",
  };
}

function snapshotOffer(offer) {
  const { payment_link_configured: _ignored, ...snapshot } = publicOffer(offer, {});
  return snapshot;
}

function validStripeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["buy.stripe.com", "checkout.stripe.com"].includes(url.hostname);
  } catch {
    return false;
  }
}

function validLinkedInProfile(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && (url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com"))
      && (/^\/in\/[A-Za-z0-9_%.-]+\/?/.test(url.pathname)
        || /^\/sales\/lead\/[A-Za-z0-9_,%-]+\/?/.test(url.pathname));
  } catch {
    return false;
  }
}

function validHttpsUrl(value) {
  if (!value) return true;
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

function validScheduledFor(value) {
  return typeof value === "string" && value.length <= 40
    && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}

function validateDiscovery(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["discovery must be an object"];
  const allowed = new Set(DISCOVERY_FIELDS);
  const errors = [];
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.has(key)) errors.push(`unknown discovery field: ${key}`);
    else if (typeof item !== "string") errors.push(`${key} must be a string`);
    else if (item.length > LIMITS.mediumText) errors.push(`${key} exceeds ${LIMITS.mediumText} characters`);
  }
  return errors;
}

function serializeCall(row) {
  return {
    id: row.id,
    prospect: {
      name: row.prospect_name, title: row.prospect_title, business_name: row.business_name,
      company_website: row.company_website, linkedin_profile_url: row.linkedin_profile_url,
      source: row.sales_source, source_context: row.source_context,
    },
    call: {
      status: row.status, scheduled_for: row.scheduled_for, timezone: row.timezone,
      discovery: parseJsonColumn(row.discovery_notes, {}), summary: row.call_summary,
    },
    offer: {
      id: row.offer_id, snapshot: parseJsonColumn(row.offer_snapshot, {}),
      locked_at: row.offer_locked_at,
    },
    agreement: {
      status: row.agreement_status, sent_at: row.agreement_sent_at,
      signed_at: row.agreement_signed_at, note: row.agreement_note,
    },
    payment: {
      status: row.payment_status, link_shared_at: row.payment_link_shared_at,
      dispatch_note: row.payment_dispatch_note, confirmed_at: row.payment_confirmed_at,
      confirmation_note: row.payment_confirmation_note,
    },
    attribution: {
      client_id: row.client_id, campaign_id: row.campaign_id,
      organization_id: row.organization_id,
      generation_candidate_id: row.generation_candidate_id,
    },
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

async function loadSalesCall(db, id) {
  return one(db, "SELECT * FROM bookings WHERE id = ? AND sales_source = 'linkedin-manual' AND archived_at IS NULL", id);
}

async function listOffers({ env }) {
  return json(env, {
    catalog_version: 1,
    offers: SALES_OFFERS.map((offer) => publicOffer(offer, env)),
    commercial_truth: "Call, agreement, and payment states are independent.",
  });
}

async function listSalesCalls({ env }) {
  const rows = await all(env.DB,
    `SELECT * FROM bookings
     WHERE sales_source = 'linkedin-manual' AND archived_at IS NULL
     ORDER BY CASE status WHEN 'booked' THEN 0 WHEN 'rescheduled' THEN 1 ELSE 2 END,
       scheduled_for ASC, created_at DESC`);
  return json(env, { calls: rows.map(serializeCall) });
}

async function getSalesCall({ env, params }) {
  const row = await loadSalesCall(env.DB, params.id);
  if (!row) return error(env, 404, "not-found");
  return json(env, { call: serializeCall(row) });
}

async function createSalesCall({ request, env }) {
  const body = await readBody(request, env);
  const check = validateBody(body, {
    prospect_name: { type: "string", required: true, max: LIMITS.shortText },
    contact_title: { type: "string", max: LIMITS.shortText, default: "" },
    business_name: { type: "string", required: true, max: LIMITS.shortText },
    company_website: { type: "string", max: LIMITS.url, default: "" },
    linkedin_profile_url: { type: "string", required: true, max: LIMITS.url },
    source_context: { type: "string", max: 500, default: "" },
    scheduled_for: { type: "string", required: true, max: 40 },
    timezone: { type: "string", required: true, max: 64 },
    generation_candidate_id: { type: "string", max: 100, default: "" },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const value = check.value;
  if (!value.prospect_name.trim() || !value.business_name.trim()) {
    return json(env, { error: "validation", details: ["prospect and business names cannot be blank"] }, 422);
  }
  if (!validLinkedInProfile(value.linkedin_profile_url)) {
    return json(env, { error: "validation", details: ["linkedin_profile_url must be an https LinkedIn member or Sales Navigator lead profile"] }, 422);
  }
  if (!validHttpsUrl(value.company_website)) {
    return json(env, { error: "validation", details: ["company_website must use https"] }, 422);
  }
  if (!validScheduledFor(value.scheduled_for)) {
    return json(env, { error: "validation", details: ["scheduled_for must be ISO 8601 with a timezone offset"] }, 422);
  }
  const candidate = value.generation_candidate_id
    ? await one(env.DB,
      `SELECT gc.id, gc.campaign_id, gc.organization_id, gc.primary_person_id,
              gr.client_id, o.display_name AS business_name, o.normalized_domain,
              p.full_name AS prospect_name, p.title AS prospect_title, p.public_profile_url AS profile_url
       FROM generation_candidates gc
       JOIN generation_runs gr ON gr.id = gc.run_id
       JOIN organizations o ON o.id = gc.organization_id
       LEFT JOIN people p ON p.id = gc.primary_person_id
       WHERE gc.id = ? AND gc.stage = 'message-ready'`, value.generation_candidate_id)
    : null;
  if (value.generation_candidate_id && !candidate) {
    return json(env, { error: "generation-candidate-not-found" }, 422);
  }
  const prospectName = candidate?.prospect_name || value.prospect_name.trim();
  const prospectTitle = candidate?.prospect_title || value.contact_title.trim();
  const businessName = candidate?.business_name || value.business_name.trim();
  const companyWebsite = candidate?.normalized_domain
    ? `https://${candidate.normalized_domain}` : value.company_website;
  const linkedinProfile = validLinkedInProfile(candidate?.profile_url)
    ? candidate.profile_url : value.linkedin_profile_url;
  const id = makeId("b");
  const now = nowIso();
  await run(env.DB,
    `INSERT INTO bookings (
       id, provider, status, scheduled_for, timezone, attribution, created_at, updated_at,
       prospect_name, prospect_title, business_name, company_website, linkedin_profile_url,
       sales_source, source_context, discovery_notes,
       agreement_status, payment_status, client_id, campaign_id, organization_id,
       generation_candidate_id)
     VALUES (?, 'manual-linkedin', 'booked', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'linkedin-manual', ?, '{}',
       'not-required', 'not-required', ?, ?, ?, ?)`,
    id, value.scheduled_for, value.timezone,
    JSON.stringify({ source: "linkedin-manual", channel: "linkedin",
      generation_candidate_id: candidate?.id ?? null }), now, now,
    prospectName, prospectTitle, businessName,
    companyWebsite, linkedinProfile, value.source_context.trim(),
    candidate?.client_id ?? "rw-client-reemergence", candidate?.campaign_id ?? null,
    candidate?.organization_id ?? null, candidate?.id ?? null);
  await audit(env.DB, {
    action: "sales-call.create", subjectType: "booking", subjectId: id,
    detail: { source: "linkedin-manual", status: "booked",
      generation_candidate_id: candidate?.id ?? null },
  });
  const row = await loadSalesCall(env.DB, id);
  return json(env, { call: serializeCall(row) }, 201);
}

async function patchSalesCall({ request, env, params }) {
  const row = await loadSalesCall(env.DB, params.id);
  if (!row) return error(env, 404, "not-found");
  const body = await readBody(request, env);
  const check = validateBody(body, {
    status: { type: "string", enum: ["booked", "canceled", "rescheduled", "held", "no-show"] },
    scheduled_for: { type: "string", max: 40 },
    timezone: { type: "string", max: 64 },
    discovery: { type: "object" },
    summary: { type: "string", max: LIMITS.longText },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  if (Object.keys(check.value).length === 0) {
    return json(env, { error: "validation", details: ["at least one field is required"] }, 422);
  }
  if (check.value.discovery) {
    const errors = validateDiscovery(check.value.discovery);
    if (errors.length) return json(env, { error: "validation", details: errors }, 422);
  }
  const nextScheduled = check.value.scheduled_for ?? row.scheduled_for;
  if (!validScheduledFor(nextScheduled)) {
    return json(env, { error: "validation", details: ["scheduled_for must be ISO 8601 with a timezone offset"] }, 422);
  }
  const nextStatus = check.value.status ?? row.status;
  if (check.value.status && check.value.status !== row.status) {
    const allowed = {
      booked: ["canceled", "rescheduled", "held", "no-show"],
      rescheduled: ["canceled", "booked", "held", "no-show"],
      canceled: [], held: [], "no-show": ["booked"],
    };
    if (!allowed[row.status]?.includes(nextStatus)) {
      return json(env, { error: "invalid-transition", from: row.status, to: nextStatus }, 409);
    }
  }
  const now = nowIso();
  await run(env.DB,
    `UPDATE bookings SET status = ?, scheduled_for = ?, timezone = ?, discovery_notes = ?,
       call_summary = ?, updated_at = ? WHERE id = ?`,
    nextStatus, nextScheduled, check.value.timezone ?? row.timezone,
    check.value.discovery ? JSON.stringify(check.value.discovery) : row.discovery_notes,
    check.value.summary ?? row.call_summary, now, params.id);
  await audit(env.DB, {
    action: "sales-call.update", subjectType: "booking", subjectId: params.id,
    detail: { call_status_from: row.status, call_status_to: nextStatus, discovery_updated: Boolean(check.value.discovery) },
  });
  return getSalesCall({ env, params });
}

async function setOffer({ request, env, params }) {
  const row = await loadSalesCall(env.DB, params.id);
  if (!row) return error(env, 404, "not-found");
  const body = await readBody(request, env);
  const check = validateBody(body, { offer_id: { type: "string", required: true, max: 80 } });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const offer = OFFER_BY_ID.get(check.value.offer_id);
  if (!offer) return json(env, { error: "offer-not-found" }, 422);
  if (row.offer_id === offer.id) return json(env, { call: serializeCall(row), unchanged: true });
  const commercialAdvanced = row.offer_locked_at || !["not-required", "not-sent"].includes(row.agreement_status)
    || !["not-required", "not-sent"].includes(row.payment_status);
  if (row.offer_id && commercialAdvanced) {
    return json(env, { error: "offer-locked", detail: "Create a new agreement/payment record for a changed offer." }, 409);
  }
  const agreementStatus = offer.agreement_required ? "not-sent" : "not-required";
  const paymentStatus = offer.payment_mode === "none" ? "not-required" : "not-sent";
  await run(env.DB,
    `UPDATE bookings SET offer_id = ?, offer_snapshot = ?, offer_locked_at = NULL,
       agreement_status = ?, agreement_sent_at = NULL, agreement_signed_at = NULL, agreement_note = '',
       payment_status = ?, payment_link_shared_at = NULL, payment_dispatch_note = '',
       payment_confirmed_at = NULL, payment_confirmation_note = '', updated_at = ? WHERE id = ?`,
    offer.id, JSON.stringify(snapshotOffer(offer)), agreementStatus, paymentStatus, nowIso(), params.id);
  await audit(env.DB, {
    action: "sales-call.offer-selected", subjectType: "booking", subjectId: params.id,
    detail: { offer_id: offer.id, offer_version: offer.version },
  });
  return getSalesCall({ env, params });
}

async function transitionAgreement({ request, env, params }) {
  const row = await loadSalesCall(env.DB, params.id);
  if (!row) return error(env, 404, "not-found");
  const offer = OFFER_BY_ID.get(row.offer_id);
  if (!offer) return json(env, { error: "offer-required" }, 409);
  if (!offer.agreement_required) return json(env, { error: "agreement-not-required" }, 409);
  const body = await readBody(request, env);
  const check = validateBody(body, {
    status: { type: "string", required: true, enum: ["sent", "signed"] },
    note: { type: "string", max: LIMITS.mediumText, default: "" },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  if (row.agreement_status === check.value.status) return json(env, { call: serializeCall(row), unchanged: true });
  const allowed = { "not-sent": "sent", sent: "signed" };
  if (allowed[row.agreement_status] !== check.value.status) {
    return json(env, { error: "invalid-agreement-transition", from: row.agreement_status, to: check.value.status }, 409);
  }
  const note = check.value.note.trim();
  if (check.value.status === "signed" && note.length < 4) {
    return json(env, { error: "confirmation-note-required", detail: "Record where the signed agreement is held." }, 422);
  }
  const now = nowIso();
  await run(env.DB,
    `UPDATE bookings SET agreement_status = ?, agreement_sent_at = ?, agreement_signed_at = ?,
       agreement_note = ?, offer_locked_at = COALESCE(offer_locked_at, ?), updated_at = ? WHERE id = ?`,
    check.value.status,
    check.value.status === "sent" ? now : row.agreement_sent_at,
    check.value.status === "signed" ? now : row.agreement_signed_at,
    note || row.agreement_note, now, now, params.id);
  await audit(env.DB, {
    action: "sales-call.agreement-transition", subjectType: "booking", subjectId: params.id,
    detail: { from: row.agreement_status, to: check.value.status, note_recorded: Boolean(note) },
  });
  return getSalesCall({ env, params });
}

async function getPaymentLink({ env, params }) {
  const row = await loadSalesCall(env.DB, params.id);
  if (!row) return error(env, 404, "not-found");
  const offer = OFFER_BY_ID.get(row.offer_id);
  if (!offer) return json(env, { error: "offer-required" }, 409);
  if (offer.payment_mode !== "stripe-link") {
    return json(env, { error: offer.payment_mode === "invoice" ? "invoice-required" : "payment-not-required" }, 409);
  }
  if (row.agreement_status !== "signed") {
    return json(env, { error: "signed-agreement-required" }, 409);
  }
  if (!new Set(["not-sent", "link-shared", "operator-confirmed-paid"]).has(row.payment_status)) {
    return json(env, { error: "invalid-payment-state", status: row.payment_status }, 409);
  }
  const envName = PAYMENT_ENV[offer.id];
  const paymentUrl = env[envName];
  if (!validStripeUrl(paymentUrl)) return json(env, { error: "payment-link-not-configured" }, 503);
  return json(env, {
    payment_url: paymentUrl,
    warning: "Retrieval does not mark this link shared. Share only with this signed client, then record link-shared explicitly.",
  });
}

async function transitionPayment({ request, env, params }) {
  const row = await loadSalesCall(env.DB, params.id);
  if (!row) return error(env, 404, "not-found");
  const offer = OFFER_BY_ID.get(row.offer_id);
  if (!offer) return json(env, { error: "offer-required" }, 409);
  if (offer.payment_mode === "none") return json(env, { error: "payment-not-required" }, 409);
  if (row.agreement_status !== "signed") return json(env, { error: "signed-agreement-required" }, 409);
  const body = await readBody(request, env);
  const check = validateBody(body, {
    status: { type: "string", required: true, enum: ["link-shared", "invoice-sent", "operator-confirmed-paid"] },
    note: { type: "string", required: true, max: LIMITS.mediumText },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const note = check.value.note.trim();
  if (note.length < 8) {
    return json(env, { error: "confirmation-note-required", detail: "Record a useful invoice or payment confirmation reference." }, 422);
  }
  if (check.value.status === "link-shared") {
    if (offer.payment_mode !== "stripe-link") return json(env, { error: "invoice-required" }, 409);
    if (row.payment_status !== "not-sent") {
      return json(env, { error: "invalid-payment-transition", from: row.payment_status, to: "link-shared" }, 409);
    }
  } else if (check.value.status === "invoice-sent") {
    if (offer.payment_mode !== "invoice") return json(env, { error: "stripe-link-required" }, 409);
    if (row.payment_status !== "not-sent") {
      return json(env, { error: "invalid-payment-transition", from: row.payment_status, to: "invoice-sent" }, 409);
    }
  } else {
    const prerequisite = offer.payment_mode === "invoice" ? "invoice-sent" : "link-shared";
    if (row.payment_status !== prerequisite) {
      return json(env, { error: "invalid-payment-transition", from: row.payment_status, to: "operator-confirmed-paid" }, 409);
    }
  }
  const now = nowIso();
  const isPaid = check.value.status === "operator-confirmed-paid";
  await run(env.DB,
    `UPDATE bookings SET payment_status = ?, payment_link_shared_at = ?, payment_dispatch_note = ?,
       payment_confirmed_at = ?, payment_confirmation_note = ?,
       offer_locked_at = COALESCE(offer_locked_at, ?), updated_at = ? WHERE id = ?`,
    check.value.status,
    check.value.status === "link-shared" ? now : row.payment_link_shared_at,
    isPaid ? row.payment_dispatch_note : note,
    isPaid ? now : row.payment_confirmed_at,
    isPaid ? note : row.payment_confirmation_note,
    now, now, params.id);
  await audit(env.DB, {
    action: "sales-call.payment-transition", subjectType: "booking", subjectId: params.id,
    detail: { from: row.payment_status, to: check.value.status, note_recorded: true },
  });
  return getSalesCall({ env, params });
}

async function archiveSalesCall({ env, params }) {
  const row = await loadSalesCall(env.DB, params.id);
  if (!row) return error(env, 404, "not-found");
  const now = nowIso();
  await run(env.DB, "UPDATE bookings SET archived_at = ?, updated_at = ? WHERE id = ?", now, now, params.id);
  await audit(env.DB, {
    action: "sales-call.archive", subjectType: "booking", subjectId: params.id,
    detail: { call_status: row.status, agreement_status: row.agreement_status, payment_status: row.payment_status },
  });
  return json(env, { call_id: params.id, archived: true });
}

export const salesRoutes = [
  ["GET", "/api/sales/offers", listOffers],
  ["GET", "/api/sales/calls", listSalesCalls],
  ["POST", "/api/sales/calls", createSalesCall],
  ["GET", "/api/sales/calls/:id", getSalesCall],
  ["PATCH", "/api/sales/calls/:id", patchSalesCall],
  ["DELETE", "/api/sales/calls/:id", archiveSalesCall],
  ["PATCH", "/api/sales/calls/:id/offer", setOffer],
  ["POST", "/api/sales/calls/:id/agreement", transitionAgreement],
  ["GET", "/api/sales/calls/:id/payment-link", getPaymentLink],
  ["POST", "/api/sales/calls/:id/payment", transitionPayment],
];
