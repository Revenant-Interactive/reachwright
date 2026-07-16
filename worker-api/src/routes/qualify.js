/**
 * Qualify routes — operator-side flow builder, preview, sessions, bookings.
 *
 * The PUBLIC conversation endpoints live in the separate `worker/` Qualify
 * worker (Turnstile session + deterministic decisions). These routes are the
 * operator's: author flows with version history, validate, activate, preview
 * verdicts, and record session outcomes + bookings. The verdict logic is the
 * shared deterministic evaluator — no model ever chooses a verdict.
 */

import { json, error, readBody } from "../index.js";
import { all, audit, one, run, parseJsonColumn } from "../db.js";
import { makeId, nowIso, validateBody, LIMITS } from "../lib/validate.js";
import {
  BUILTIN_FLOW, evaluateFlow, normalizeFlowAnswers, validateFlowDefinition,
} from "../lib/qualify.js";

async function createFlow({ request, env }) {
  const body = await readBody(request, env);
  const check = validateBody(body, {
    name: { type: "string", required: true, max: LIMITS.shortText },
    definition: { type: "object", required: true },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const defCheck = validateFlowDefinition(check.value.definition);
  if (!defCheck.ok) return json(env, { error: "flow-invalid", details: defCheck.errors }, 422);

  const latest = await one(env.DB,
    "SELECT MAX(version) AS v FROM qualification_flows WHERE name = ?", check.value.name);
  const version = (latest?.v ?? 0) + 1;
  const id = makeId("q");
  await run(env.DB,
    `INSERT INTO qualification_flows (id, name, version, definition, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', ?, ?)`,
    id, check.value.name, version, JSON.stringify(check.value.definition), nowIso(), nowIso());
  await audit(env.DB, { action: "flow.create", subjectType: "flow", subjectId: id, detail: { name: check.value.name, version } });
  return json(env, { flow_id: id, name: check.value.name, version }, 201);
}

async function listFlows({ env }) {
  const rows = await all(env.DB,
    "SELECT id, name, version, status, created_at, updated_at FROM qualification_flows ORDER BY name, version DESC");
  return json(env, { flows: rows, builtin_available: true });
}

async function getFlow({ env, params }) {
  const row = await one(env.DB, "SELECT * FROM qualification_flows WHERE id = ?", params.id);
  if (!row) return error(env, 404, "not-found");
  return json(env, { flow: { ...row, definition: parseJsonColumn(row.definition, null) } });
}

/** Activation deactivates every other version/flow — exactly one active flow. */
async function activateFlow({ env, params }) {
  const row = await one(env.DB, "SELECT * FROM qualification_flows WHERE id = ?", params.id);
  if (!row) return error(env, 404, "not-found");
  const defCheck = validateFlowDefinition(parseJsonColumn(row.definition, null));
  if (!defCheck.ok) return json(env, { error: "flow-invalid", details: defCheck.errors }, 422);
  await run(env.DB, "UPDATE qualification_flows SET status = 'inactive', updated_at = ? WHERE status = 'active'", nowIso());
  await run(env.DB, "UPDATE qualification_flows SET status = 'active', updated_at = ? WHERE id = ?", nowIso(), params.id);
  await audit(env.DB, { action: "flow.activate", subjectType: "flow", subjectId: params.id, detail: { name: row.name, version: row.version } });
  return json(env, { ok: true, active: { id: row.id, name: row.name, version: row.version } });
}

async function deactivateFlow({ env, params }) {
  const row = await one(env.DB, "SELECT * FROM qualification_flows WHERE id = ?", params.id);
  if (!row) return error(env, 404, "not-found");
  await run(env.DB, "UPDATE qualification_flows SET status = 'inactive', updated_at = ? WHERE id = ?", nowIso(), params.id);
  await audit(env.DB, { action: "flow.deactivate", subjectType: "flow", subjectId: params.id, detail: {} });
  return json(env, { ok: true });
}

async function activeFlow({ env }) {
  const row = await one(env.DB, "SELECT * FROM qualification_flows WHERE status = 'active' ORDER BY updated_at DESC");
  if (!row) return json(env, { flow: null, fallback: "builtin", definition: BUILTIN_FLOW });
  return json(env, { flow: { id: row.id, name: row.name, version: row.version }, definition: parseJsonColumn(row.definition, null) });
}

/** Operator preview: run answers through a flow deterministically. */
async function previewVerdict({ request, env }) {
  const body = await readBody(request, env);
  const check = validateBody(body, {
    flow_id: { type: "string", max: 60 },
    answers: { type: "object", required: true },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);

  let definition = BUILTIN_FLOW;
  if (check.value.flow_id) {
    const row = await one(env.DB, "SELECT definition FROM qualification_flows WHERE id = ?", check.value.flow_id);
    if (!row) return error(env, 404, "not-found");
    definition = parseJsonColumn(row.definition, null);
  }
  const answers = normalizeFlowAnswers(definition, check.value.answers);
  if (!answers) return json(env, { error: "answer-schema" }, 422);
  const decision = evaluateFlow(definition, answers);
  return json(env, { decision, deterministic: true });
}

/** Record a completed qualification session + outcome (from the public worker or manual entry). */
async function recordSession({ request, env }) {
  const body = await readBody(request, env);
  const check = validateBody(body, {
    session_id: { type: "string", required: true, max: 80 },
    flow_id: { type: "string", max: 60 },
    flow_version: { type: "number", integer: true, min: 1 },
    source: { type: "string", max: LIMITS.shortText, default: "" },
    answers: { type: "object", required: true },
    turns: { type: "number", integer: true, min: 0, max: 50, default: 0 },
    verdict: { type: "string", required: true, enum: ["strong", "maybe", "no", "human-review"] },
    factors: { type: "array", default: [], items: { type: "object" } },
    routed_to: { type: "string", max: 40, default: "" },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const value = check.value;
  const now = nowIso();
  await run(env.DB,
    `INSERT OR REPLACE INTO qualification_sessions (id, flow_id, flow_version, source, started_at, last_turn_at, turns, answers, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'verdict')`,
    value.session_id, value.flow_id || null, value.flow_version || null, value.source,
    now, now, value.turns, JSON.stringify(value.answers));
  const outcomeId = makeId("v");
  await run(env.DB,
    `INSERT INTO qualification_outcomes (id, session_id, verdict, factors, routed_to, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    outcomeId, value.session_id, value.verdict, JSON.stringify(value.factors), value.routed_to, now);
  await audit(env.DB, { action: "qualify.outcome", subjectType: "session", subjectId: value.session_id, detail: { verdict: value.verdict } });
  return json(env, { outcome_id: outcomeId }, 201);
}

/**
 * Bookings. The booking-adapter interface is real; no live integration is
 * faked: provider stays "not-configured" until Calendly credentials exist,
 * and the operator records events manually from provider notifications.
 */
async function createBooking({ request, env }) {
  const body = await readBody(request, env);
  const check = validateBody(body, {
    campaign_id: { type: "string", max: 60 },
    session_id: { type: "string", max: 80 },
    organization_id: { type: "string", max: 60 },
    status: { type: "string", required: true, enum: ["booked", "canceled", "rescheduled", "held", "no-show"] },
    scheduled_for: { type: "string", max: 40 },
    timezone: { type: "string", max: 64, default: "" },
    attribution: { type: "object", default: {} },
    provider_event_id: { type: "string", max: 120, default: "" },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const value = check.value;
  // Booked ≠ held. A booking may only be created as held if it was booked first — manual entries included.
  if (value.status === "held") {
    return json(env, { error: "held-requires-transition", detail: "create as booked, then PATCH to held after the call happens" }, 422);
  }
  const id = makeId("b");
  await run(env.DB,
    `INSERT INTO bookings (id, campaign_id, session_id, organization_id, provider, provider_event_id, status,
       scheduled_for, timezone, attribution, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'not-configured', ?, ?, ?, ?, ?, ?, ?)`,
    id, value.campaign_id || null, value.session_id || null, value.organization_id || null,
    value.provider_event_id, value.status, value.scheduled_for || null, value.timezone,
    JSON.stringify(value.attribution), nowIso(), nowIso());
  await audit(env.DB, { action: "booking.create", subjectType: "booking", subjectId: id, detail: { status: value.status } });
  return json(env, { booking_id: id }, 201);
}

async function patchBooking({ request, env, params }) {
  const row = await one(env.DB, "SELECT * FROM bookings WHERE id = ?", params.id);
  if (!row) return error(env, 404, "not-found");
  const body = await readBody(request, env);
  const check = validateBody(body, {
    status: { type: "string", required: true, enum: ["booked", "canceled", "rescheduled", "held", "no-show"] },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const allowed = {
    booked: ["canceled", "rescheduled", "held", "no-show"],
    rescheduled: ["canceled", "held", "no-show", "booked"],
    canceled: [], held: [], "no-show": ["booked"],
  };
  if (!allowed[row.status]?.includes(check.value.status)) {
    return json(env, { error: "invalid-transition", from: row.status, to: check.value.status }, 409);
  }
  await run(env.DB, "UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?", check.value.status, nowIso(), params.id);
  await audit(env.DB, { action: "booking.transition", subjectType: "booking", subjectId: params.id, detail: { from: row.status, to: check.value.status } });
  return json(env, { booking_id: params.id, status: check.value.status });
}

export const qualifyRoutes = [
  ["POST", "/api/qualify/flows", createFlow],
  ["GET", "/api/qualify/flows", listFlows],
  ["GET", "/api/qualify/flows/active", activeFlow],
  ["GET", "/api/qualify/flows/:id", getFlow],
  ["POST", "/api/qualify/flows/:id/activate", activateFlow],
  ["POST", "/api/qualify/flows/:id/deactivate", deactivateFlow],
  ["POST", "/api/qualify/preview", previewVerdict],
  ["POST", "/api/qualify/sessions", recordSession],
  ["POST", "/api/bookings", createBooking],
  ["PATCH", "/api/bookings/:id", patchBooking],
];
