/**
 * Campaign routes — the brief is the gate: a campaign with an incomplete
 * brief stays `blocked-brief` and cannot search (playbook §Required brief).
 */

import { json, error, readBody } from "../index.js";
import { all, audit, one, run, parseJsonColumn } from "../db.js";
import { makeId, nowIso, validateBody, LIMITS } from "../lib/validate.js";

const CHANNELS = ["linkedin-manual", "email", "dm", "phone"];

const campaignSchema = {
  name: { type: "string", required: true, max: LIMITS.shortText },
  owner: { type: "string", required: true, max: LIMITS.shortText },
  offer: { type: "string", required: true, max: LIMITS.mediumText },
  icp: { type: "string", required: true, max: LIMITS.mediumText },
  geography: { type: "string", required: true, max: LIMITS.shortText },
  positive_signals: { type: "array", items: { type: "string", max: LIMITS.shortText }, default: [] },
  disqualifiers: { type: "array", items: { type: "string", max: LIMITS.shortText }, default: [] },
  min_economics: { type: "string", required: true, max: LIMITS.shortText },
  allowed_channels: { type: "array", required: true, minItems: 1, items: { type: "string", enum: CHANNELS } },
  max_batch_size: { type: "number", integer: true, min: 1, max: 100, default: 25 },
  voice_notes: { type: "string", max: LIMITS.mediumText, default: "" },
  success_metric: { type: "string", max: LIMITS.shortText, default: "" },
  client_id: { type: "string", max: 80, default: "rw-client-reemergence" },
  client_offer_id: { type: "string", max: 100, default: "" },
  buying_triggers: { type: "array", items: { type: "string", max: LIMITS.shortText }, default: [] },
  score_thresholds: { type: "object", default: {} },
};

const THRESHOLD_KEYS = ["icp_fit", "copy_opportunity", "buying_capacity",
  "evidence_quality", "evidence_recency", "reachability", "overall_priority"];

function checkThresholds(thresholds) {
  const errors = [];
  for (const [key, value] of Object.entries(thresholds || {})) {
    if (!THRESHOLD_KEYS.includes(key)) errors.push(`score_thresholds.${key}: unknown dimension`);
    else if (!Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > 100) {
      errors.push(`score_thresholds.${key}: must be an integer 0–100`);
    }
  }
  return errors;
}

function snapshotClientOffer(offer) {
  return offer ? {
    id: offer.id, name: offer.name, description: offer.description,
    ideal_customer: offer.ideal_customer,
    proof_points: parseJsonColumn(offer.proof_points, []),
    economics_note: offer.economics_note,
  } : {};
}

const campaignSelect = `SELECT ca.*, cl.name AS client_name, co.name AS client_offer_name
  FROM campaigns ca JOIN clients cl ON cl.id = ca.client_id
  LEFT JOIN client_offers co ON co.id = ca.client_offer_id`;

export function briefComplete(campaign) {
  // Playbook items 1–5 are mandatory before researching.
  return Boolean(campaign.offer && campaign.icp && campaign.geography
    && campaign.min_economics && campaign.allowed_channels
    && JSON.parse(campaign.allowed_channels || "[]").length > 0);
}

async function createCampaign({ request, env }) {
  const body = await readBody(request, env);
  const check = validateBody(body, campaignSchema);
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const value = check.value;
  const thresholdErrors = checkThresholds(value.score_thresholds);
  if (thresholdErrors.length) return json(env, { error: "validation", details: thresholdErrors }, 422);
  const client = await one(env.DB, "SELECT id FROM clients WHERE id = ? AND status = 'active'", value.client_id);
  if (!client) return json(env, { error: "client-not-found" }, 422);
  const clientOffer = value.client_offer_id
    ? await one(env.DB, "SELECT * FROM client_offers WHERE id = ? AND client_id = ? AND active = 1",
      value.client_offer_id, value.client_id)
    : null;
  if (value.client_offer_id && !clientOffer) return json(env, { error: "client-offer-not-found" }, 422);
  const id = makeId("c");
  const now = nowIso();
  const status = "blocked-brief"; // brief completeness is judged on read; searching re-checks
  await run(env.DB,
    `INSERT INTO campaigns (id, owner, name, offer, icp, geography, positive_signals, disqualifiers,
       min_economics, allowed_channels, max_batch_size, voice_notes, success_metric, status, created_at, updated_at,
       client_id, client_offer_id, client_offer_snapshot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, value.owner, value.name, value.offer, value.icp, value.geography,
    JSON.stringify(value.positive_signals), JSON.stringify(value.disqualifiers),
    value.min_economics, JSON.stringify(value.allowed_channels), value.max_batch_size,
    value.voice_notes, value.success_metric, status, now, now, value.client_id,
    clientOffer?.id ?? null, JSON.stringify(snapshotClientOffer(clientOffer)));
  if (value.buying_triggers.length || Object.keys(value.score_thresholds).length) {
    await run(env.DB, "UPDATE campaigns SET buying_triggers = ?, score_thresholds = ? WHERE id = ?",
      JSON.stringify(value.buying_triggers), JSON.stringify(value.score_thresholds), id);
  }
  await audit(env.DB, { action: "campaign.create", subjectType: "campaign", subjectId: id, detail: { name: value.name } });
  const created = await one(env.DB, `${campaignSelect} WHERE ca.id = ?`, id);
  return json(env, { campaign: decorate(created) }, 201);
}

async function listCampaigns({ env, url }) {
  const clientId = url.searchParams.get("client_id");
  const rows = clientId
    ? await all(env.DB, `${campaignSelect} WHERE ca.client_id = ? ORDER BY ca.created_at DESC`, clientId)
    : await all(env.DB, `${campaignSelect} ORDER BY ca.created_at DESC`);
  return json(env, { campaigns: rows.map(decorate) });
}

async function getCampaign({ env, params }) {
  const row = await one(env.DB, `${campaignSelect} WHERE ca.id = ?`, params.id);
  if (!row) return error(env, 404, "not-found");
  return json(env, { campaign: decorate(row) });
}

async function patchCampaign({ request, env, params }) {
  const row = await one(env.DB, "SELECT * FROM campaigns WHERE id = ?", params.id);
  if (!row) return error(env, 404, "not-found");
  const body = await readBody(request, env);
  const check = validateBody(body, {
    status: { type: "string", enum: ["blocked-brief", "researching", "paused", "closed"] },
    max_batch_size: { type: "number", integer: true, min: 1, max: 100 },
    voice_notes: { type: "string", max: LIMITS.mediumText },
    icp: { type: "string", max: LIMITS.mediumText },
    geography: { type: "string", max: LIMITS.shortText },
    positive_signals: { type: "array", items: { type: "string", max: LIMITS.shortText } },
    disqualifiers: { type: "array", items: { type: "string", max: LIMITS.shortText } },
    buying_triggers: { type: "array", items: { type: "string", max: LIMITS.shortText } },
    score_thresholds: { type: "object" },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const value = check.value;
  if (value.score_thresholds) {
    const thresholdErrors = checkThresholds(value.score_thresholds);
    if (thresholdErrors.length) return json(env, { error: "validation", details: thresholdErrors }, 422);
  }
  if (value.status === "researching" && !briefComplete(row)) {
    return json(env, { error: "brief-incomplete", detail: "playbook items 1–5 are required before researching" }, 409);
  }
  const status = value.status ?? row.status;
  const batch = value.max_batch_size ?? row.max_batch_size;
  const voice = value.voice_notes ?? row.voice_notes;
  await run(env.DB,
    `UPDATE campaigns SET status = ?, max_batch_size = ?, voice_notes = ?,
       icp = ?, geography = ?, positive_signals = ?, disqualifiers = ?,
       buying_triggers = ?, score_thresholds = ?, updated_at = ? WHERE id = ?`,
    status, batch, voice,
    value.icp ?? row.icp, value.geography ?? row.geography,
    value.positive_signals ? JSON.stringify(value.positive_signals) : row.positive_signals,
    value.disqualifiers ? JSON.stringify(value.disqualifiers) : row.disqualifiers,
    value.buying_triggers ? JSON.stringify(value.buying_triggers) : row.buying_triggers,
    value.score_thresholds ? JSON.stringify(value.score_thresholds) : row.score_thresholds,
    nowIso(), params.id);
  await audit(env.DB, { action: "campaign.update", subjectType: "campaign", subjectId: params.id, detail: value });
  const updated = await one(env.DB, "SELECT * FROM campaigns WHERE id = ?", params.id);
  return json(env, { campaign: decorate(updated) });
}

function decorate(row) {
  return { ...row, client_offer_snapshot: parseJsonColumn(row.client_offer_snapshot, {}),
    buying_triggers: parseJsonColumn(row.buying_triggers, []),
    score_thresholds: parseJsonColumn(row.score_thresholds, {}),
    brief_complete: briefComplete(row) };
}

export const campaignRoutes = [
  ["POST", "/api/campaigns", createCampaign],
  ["GET", "/api/campaigns", listCampaigns],
  ["GET", "/api/campaigns/:id", getCampaign],
  ["PATCH", "/api/campaigns/:id", patchCampaign],
];
