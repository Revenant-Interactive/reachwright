/**
 * Market-model configuration routes: the editable signal taxonomy and the
 * deterministic scoring model. Read/write is operator-only (bearer token,
 * like every /api route). Every change is audited; the scoring-model editor
 * validates weight sums so a broken model can never be saved.
 */

import { json, error, readBody } from "../index.js";
import { all, audit, one, run, parseJsonColumn } from "../db.js";
import { makeId, nowIso, validateBody, LIMITS } from "../lib/validate.js";
import { parseModelRow, validateModelEdit, evaluateCandidate, DIMENSION_KEYS } from "../lib/market-model.js";

const DIMENSIONS = ["icp-fit", "copy-opportunity", "buying-trigger", "evidence-quality", "reachability"];

const signalSchema = {
  dimension: { type: "string", required: true, enum: DIMENSIONS },
  signal_type: { type: "string", required: true, max: 80 },
  label: { type: "string", required: true, max: LIMITS.shortText },
  description: { type: "string", max: LIMITS.mediumText, default: "" },
  observable_asset: { type: "string", max: LIMITS.shortText, default: "" },
  detection: { type: "string", enum: ["automated", "manual", "either"], default: "manual" },
  default_confidence: { type: "number", integer: true, min: 0, max: 100, default: 70 },
  recency_window_days: { type: "number", integer: true, min: 1, max: 365, default: 60 },
  qualifying: { type: "boolean", default: false },
  guidance: { type: "string", max: LIMITS.mediumText, default: "" },
};

async function listSignals({ env, url }) {
  const dimension = url.searchParams.get("dimension");
  const rows = dimension
    ? await all(env.DB, "SELECT * FROM signal_taxonomy WHERE dimension = ? ORDER BY active DESC, label", dimension)
    : await all(env.DB, "SELECT * FROM signal_taxonomy ORDER BY dimension, active DESC, label");
  return json(env, { signals: rows, dimensions: DIMENSIONS });
}

async function createSignal({ request, env }) {
  const check = validateBody(await readBody(request, env), signalSchema);
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const value = check.value;
  const slug = value.signal_type.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) return json(env, { error: "validation", details: ["signal_type must contain letters or digits"] }, 422);
  const existing = await one(env.DB, "SELECT id FROM signal_taxonomy WHERE signal_type = ?", slug);
  if (existing) return json(env, { error: "signal-type-exists", signal_type: slug }, 409);
  const id = makeId("signal");
  const now = nowIso();
  await run(env.DB,
    `INSERT INTO signal_taxonomy (id, dimension, signal_type, label, description, observable_asset,
       detection, default_confidence, recency_window_days, qualifying, guidance, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    id, value.dimension, slug, value.label, value.description, value.observable_asset,
    value.detection, value.default_confidence, value.recency_window_days,
    value.qualifying ? 1 : 0, value.guidance, now, now);
  await audit(env.DB, { action: "signal.create", subjectType: "signal", subjectId: id,
    detail: { dimension: value.dimension, signal_type: slug } });
  return json(env, { signal: await one(env.DB, "SELECT * FROM signal_taxonomy WHERE id = ?", id) }, 201);
}

async function patchSignal({ request, env, params }) {
  const signal = await one(env.DB, "SELECT * FROM signal_taxonomy WHERE id = ?", params.id);
  if (!signal) return error(env, 404, "not-found");
  const check = validateBody(await readBody(request, env), {
    label: { type: "string", max: LIMITS.shortText },
    description: { type: "string", max: LIMITS.mediumText },
    observable_asset: { type: "string", max: LIMITS.shortText },
    detection: { type: "string", enum: ["automated", "manual", "either"] },
    default_confidence: { type: "number", integer: true, min: 0, max: 100 },
    recency_window_days: { type: "number", integer: true, min: 1, max: 365 },
    qualifying: { type: "boolean" },
    guidance: { type: "string", max: LIMITS.mediumText },
    active: { type: "boolean" },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const value = check.value;
  await run(env.DB,
    `UPDATE signal_taxonomy SET label = ?, description = ?, observable_asset = ?, detection = ?,
       default_confidence = ?, recency_window_days = ?, qualifying = ?, guidance = ?, active = ?,
       updated_at = ? WHERE id = ?`,
    value.label ?? signal.label, value.description ?? signal.description,
    value.observable_asset ?? signal.observable_asset, value.detection ?? signal.detection,
    value.default_confidence ?? signal.default_confidence,
    value.recency_window_days ?? signal.recency_window_days,
    value.qualifying === undefined ? signal.qualifying : value.qualifying ? 1 : 0,
    value.guidance ?? signal.guidance,
    value.active === undefined ? signal.active : value.active ? 1 : 0,
    nowIso(), signal.id);
  await audit(env.DB, { action: "signal.update", subjectType: "signal", subjectId: signal.id,
    detail: { changed: Object.keys(value) } });
  return json(env, { signal: await one(env.DB, "SELECT * FROM signal_taxonomy WHERE id = ?", signal.id) });
}

async function getScoringModel({ env }) {
  const row = await one(env.DB, "SELECT * FROM scoring_models WHERE active = 1 ORDER BY updated_at DESC LIMIT 1");
  if (!row) return error(env, 404, "scoring-model-missing");
  return json(env, { model: parseModelRow(row) });
}

async function patchScoringModel({ request, env }) {
  const row = await one(env.DB, "SELECT * FROM scoring_models WHERE active = 1 ORDER BY updated_at DESC LIMIT 1");
  if (!row) return error(env, 404, "scoring-model-missing");
  const existing = parseModelRow(row);
  const body = await readBody(request, env);
  if (!body) return json(env, { error: "validation", details: ["JSON body required"] }, 422);
  const { dimensions, thresholds, priority_weights, notes } = body;
  const check = validateModelEdit({ dimensions, thresholds, priority_weights }, existing);
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  await run(env.DB,
    `UPDATE scoring_models SET dimensions = ?, thresholds = ?, priority_weights = ?, notes = ?, updated_at = ?
     WHERE id = ?`,
    JSON.stringify(dimensions ?? existing.dimensions),
    JSON.stringify(thresholds ?? existing.thresholds),
    JSON.stringify(priority_weights ?? existing.priority_weights),
    typeof notes === "string" ? notes.slice(0, LIMITS.mediumText) : existing.notes,
    nowIso(), row.id);
  await audit(env.DB, { action: "scoring-model.update", subjectType: "scoring-model", subjectId: row.id,
    detail: { changed: ["dimensions", "thresholds", "priority_weights", "notes"].filter((key) => body[key] !== undefined) } });
  const updated = await one(env.DB, "SELECT * FROM scoring_models WHERE id = ?", row.id);
  return json(env, { model: parseModelRow(updated) });
}

/**
 * Deterministic dry-run: evaluate sample inputs against the active model so
 * the operator can see exactly how scores, gates, and priority respond.
 * Reads nothing but the model; writes nothing.
 */
async function previewScoringModel({ request, env }) {
  const row = await one(env.DB, "SELECT * FROM scoring_models WHERE active = 1 ORDER BY updated_at DESC LIMIT 1");
  if (!row) return error(env, 404, "scoring-model-missing");
  const body = await readBody(request, env);
  if (!body || typeof body !== "object") return json(env, { error: "validation", details: ["JSON body required"] }, 422);
  const inputs = body.inputs && typeof body.inputs === "object" ? body.inputs : {};
  const disqualifiers = Array.isArray(body.disqualifiers) ? body.disqualifiers.slice(0, 20) : [];
  const thresholdOverrides = body.threshold_overrides && typeof body.threshold_overrides === "object"
    ? body.threshold_overrides : {};
  const result = evaluateCandidate({ model: parseModelRow(row), inputs, disqualifiers, thresholdOverrides });
  return json(env, { evaluation: result, dimension_keys: DIMENSION_KEYS });
}

export const marketRoutes = [
  ["GET", "/api/signals", listSignals],
  ["POST", "/api/signals", createSignal],
  ["PATCH", "/api/signals/:id", patchSignal],
  ["GET", "/api/scoring-model", getScoringModel],
  ["PATCH", "/api/scoring-model", patchScoringModel],
  ["POST", "/api/scoring-model/preview", previewScoringModel],
];
