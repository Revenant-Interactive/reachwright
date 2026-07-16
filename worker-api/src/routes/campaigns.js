/**
 * Campaign routes — the brief is the gate: a campaign with an incomplete
 * brief stays `blocked-brief` and cannot search (playbook §Required brief).
 */

import { json, error, readBody } from "../index.js";
import { all, audit, one, run } from "../db.js";
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
};

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
  const id = makeId("c");
  const now = nowIso();
  const status = "blocked-brief"; // brief completeness is judged on read; searching re-checks
  await run(env.DB,
    `INSERT INTO campaigns (id, owner, name, offer, icp, geography, positive_signals, disqualifiers,
       min_economics, allowed_channels, max_batch_size, voice_notes, success_metric, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, value.owner, value.name, value.offer, value.icp, value.geography,
    JSON.stringify(value.positive_signals), JSON.stringify(value.disqualifiers),
    value.min_economics, JSON.stringify(value.allowed_channels), value.max_batch_size,
    value.voice_notes, value.success_metric, status, now, now);
  await audit(env.DB, { action: "campaign.create", subjectType: "campaign", subjectId: id, detail: { name: value.name } });
  const created = await one(env.DB, "SELECT * FROM campaigns WHERE id = ?", id);
  return json(env, { campaign: decorate(created) }, 201);
}

async function listCampaigns({ env }) {
  const rows = await all(env.DB, "SELECT * FROM campaigns ORDER BY created_at DESC");
  return json(env, { campaigns: rows.map(decorate) });
}

async function getCampaign({ env, params }) {
  const row = await one(env.DB, "SELECT * FROM campaigns WHERE id = ?", params.id);
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
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const value = check.value;
  if (value.status === "researching" && !briefComplete(row)) {
    return json(env, { error: "brief-incomplete", detail: "playbook items 1–5 are required before researching" }, 409);
  }
  const status = value.status ?? row.status;
  const batch = value.max_batch_size ?? row.max_batch_size;
  const voice = value.voice_notes ?? row.voice_notes;
  await run(env.DB,
    "UPDATE campaigns SET status = ?, max_batch_size = ?, voice_notes = ?, updated_at = ? WHERE id = ?",
    status, batch, voice, nowIso(), params.id);
  await audit(env.DB, { action: "campaign.update", subjectType: "campaign", subjectId: params.id, detail: value });
  const updated = await one(env.DB, "SELECT * FROM campaigns WHERE id = ?", params.id);
  return json(env, { campaign: decorate(updated) });
}

function decorate(row) {
  return { ...row, brief_complete: briefComplete(row) };
}

export const campaignRoutes = [
  ["POST", "/api/campaigns", createCampaign],
  ["GET", "/api/campaigns", listCampaigns],
  ["GET", "/api/campaigns/:id", getCampaign],
  ["PATCH", "/api/campaigns/:id", patchCampaign],
];
