/** Client and service-catalog configuration for managed campaigns. */

import { json, error, readBody } from "../index.js";
import { all, audit, one, run, parseJsonColumn } from "../db.js";
import { makeId, nowIso, validateBody, LIMITS } from "../lib/validate.js";

const clientSchema = {
  name: { type: "string", required: true, max: LIMITS.shortText },
  owner: { type: "string", max: LIMITS.shortText, default: "michael" },
  mode: { type: "string", enum: ["internal", "managed-client"], default: "managed-client" },
};

// Copywriting-model fields (migration 0010). List fields arrive as string
// arrays and persist as JSON columns; prose fields stay editable free text.
const serviceModelFields = {
  target_business_type: { type: "string", max: LIMITS.mediumText, default: "" },
  target_buyer: { type: "string", max: LIMITS.shortText, default: "" },
  company_stage: { type: "string", max: LIMITS.shortText, default: "" },
  minimum_commercial_value: { type: "string", max: LIMITS.shortText, default: "" },
  capacity_indicators: { type: "array", maxItems: 20, items: { type: "string", max: 120 }, default: [] },
  buying_triggers: { type: "array", maxItems: 20, items: { type: "string", max: 120 }, default: [] },
  service_disqualifiers: { type: "array", maxItems: 20, items: { type: "string", max: LIMITS.shortText }, default: [] },
  required_evidence: { type: "array", maxItems: 20, items: { type: "string", max: 120 }, default: [] },
  contact_roles: { type: "array", maxItems: 20, items: { type: "string", max: 80 }, default: [] },
  permitted_claims: { type: "array", maxItems: 30, items: { type: "string", max: LIMITS.shortText }, default: [] },
  prohibited_claims: { type: "array", maxItems: 30, items: { type: "string", max: LIMITS.shortText }, default: [] },
  typical_cta: { type: "string", max: LIMITS.shortText, default: "" },
  next_step: { type: "string", max: LIMITS.shortText, default: "" },
};
const SERVICE_LIST_FIELDS = ["capacity_indicators", "buying_triggers", "service_disqualifiers",
  "required_evidence", "contact_roles", "permitted_claims", "prohibited_claims"];
const SERVICE_TEXT_FIELDS = ["target_business_type", "target_buyer", "company_stage",
  "minimum_commercial_value", "typical_cta", "next_step"];

const serviceSchema = {
  name: { type: "string", required: true, max: LIMITS.shortText },
  description: { type: "string", required: true, max: LIMITS.mediumText },
  entry_angle: { type: "string", required: true, max: LIMITS.mediumText },
  signal_types: { type: "array", required: true, minItems: 1, maxItems: 30,
    items: { type: "string", max: 80 } },
  delivery_type: { type: "string", enum: ["consultation", "diagnostic", "sprint", "retainer", "service", "custom"], default: "service" },
  public_rung: { type: "boolean", default: true },
  priority: { type: "number", integer: true, min: 0, max: 1000, default: 100 },
  ...serviceModelFields,
};

const offerSchema = {
  name: { type: "string", required: true, max: LIMITS.shortText },
  description: { type: "string", required: true, max: LIMITS.mediumText },
  ideal_customer: { type: "string", max: LIMITS.mediumText, default: "" },
  proof_points: { type: "array", maxItems: 20, items: { type: "string", max: LIMITS.mediumText }, default: [] },
  economics_note: { type: "string", max: LIMITS.mediumText, default: "" },
};

async function listClients({ env }) {
  const clients = await all(env.DB,
    `SELECT c.*, COUNT(DISTINCT ca.id) AS campaigns, COUNT(DISTINCT s.id) AS services,
            COUNT(DISTINCT co.id) AS offers
     FROM clients c LEFT JOIN campaigns ca ON ca.client_id = c.id
     LEFT JOIN client_services s ON s.client_id = c.id AND s.active = 1
     LEFT JOIN client_offers co ON co.client_id = c.id AND co.active = 1
     GROUP BY c.id ORDER BY c.created_at`);
  return json(env, { clients });
}

async function createClient({ request, env }) {
  const check = validateBody(await readBody(request, env), clientSchema);
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const id = makeId("client");
  const now = nowIso();
  await run(env.DB,
    `INSERT INTO clients (id, name, owner, mode, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    id, check.value.name, check.value.owner, check.value.mode, now, now);
  await audit(env.DB, { action: "client.create", subjectType: "client", subjectId: id,
    detail: { name: check.value.name, mode: check.value.mode } });
  return json(env, { client: await one(env.DB, "SELECT * FROM clients WHERE id = ?", id) }, 201);
}

async function listServices({ env, params }) {
  const client = await one(env.DB, "SELECT * FROM clients WHERE id = ?", params.id);
  if (!client) return error(env, 404, "not-found");
  const services = await all(env.DB,
    "SELECT * FROM client_services WHERE client_id = ? ORDER BY active DESC, priority, name", client.id);
  return json(env, { client, services: services.map(decorateService) });
}

async function createService({ request, env, params }) {
  const client = await one(env.DB, "SELECT * FROM clients WHERE id = ? AND status != 'archived'", params.id);
  if (!client) return error(env, 404, "not-found");
  const check = validateBody(await readBody(request, env), serviceSchema);
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const value = check.value;
  const id = makeId("service");
  const now = nowIso();
  await run(env.DB,
    `INSERT INTO client_services (id, client_id, name, description, entry_angle, signal_types,
       delivery_type, public_rung, priority, active,
       target_business_type, target_buyer, company_stage, minimum_commercial_value,
       capacity_indicators, buying_triggers, service_disqualifiers, required_evidence, contact_roles,
       permitted_claims, prohibited_claims, typical_cta, next_step, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, client.id, value.name, value.description, value.entry_angle, JSON.stringify(value.signal_types),
    value.delivery_type, value.public_rung ? 1 : 0, value.priority,
    value.target_business_type, value.target_buyer, value.company_stage, value.minimum_commercial_value,
    JSON.stringify(value.capacity_indicators), JSON.stringify(value.buying_triggers),
    JSON.stringify(value.service_disqualifiers), JSON.stringify(value.required_evidence),
    JSON.stringify(value.contact_roles), JSON.stringify(value.permitted_claims),
    JSON.stringify(value.prohibited_claims), value.typical_cta, value.next_step, now, now);
  await audit(env.DB, { action: "service.create", subjectType: "service", subjectId: id,
    detail: { client_id: client.id, name: value.name } });
  return json(env, { service: decorateService(await one(env.DB, "SELECT * FROM client_services WHERE id = ?", id)) }, 201);
}

async function patchService({ request, env, params }) {
  const service = await one(env.DB, "SELECT * FROM client_services WHERE id = ?", params.id);
  if (!service) return error(env, 404, "not-found");
  const patchModelFields = Object.fromEntries(Object.entries(serviceModelFields)
    .map(([key, rule]) => [key, { ...rule, default: undefined }]));
  const check = validateBody(await readBody(request, env), {
    name: { type: "string", max: LIMITS.shortText },
    description: { type: "string", max: LIMITS.mediumText },
    entry_angle: { type: "string", max: LIMITS.mediumText },
    signal_types: { type: "array", minItems: 1, maxItems: 30, items: { type: "string", max: 80 } },
    active: { type: "boolean" },
    priority: { type: "number", integer: true, min: 0, max: 1000 },
    ...patchModelFields,
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const value = check.value;
  const textField = (key) => value[key] ?? service[key];
  const listField = (key) => value[key] !== undefined ? JSON.stringify(value[key]) : service[key];
  await run(env.DB,
    `UPDATE client_services SET name = ?, description = ?, entry_angle = ?, signal_types = ?,
       active = ?, priority = ?,
       target_business_type = ?, target_buyer = ?, company_stage = ?, minimum_commercial_value = ?,
       capacity_indicators = ?, buying_triggers = ?, service_disqualifiers = ?, required_evidence = ?,
       contact_roles = ?, permitted_claims = ?, prohibited_claims = ?, typical_cta = ?, next_step = ?,
       updated_at = ? WHERE id = ?`,
    value.name ?? service.name, value.description ?? service.description,
    value.entry_angle ?? service.entry_angle,
    value.signal_types ? JSON.stringify(value.signal_types) : service.signal_types,
    value.active === undefined ? service.active : value.active ? 1 : 0,
    value.priority ?? service.priority,
    ...SERVICE_TEXT_FIELDS.slice(0, 4).map(textField),
    ...SERVICE_LIST_FIELDS.map(listField),
    ...SERVICE_TEXT_FIELDS.slice(4).map(textField),
    nowIso(), service.id);
  await audit(env.DB, { action: "service.update", subjectType: "service", subjectId: service.id,
    detail: { changed: Object.keys(value) } });
  return json(env, { service: decorateService(await one(env.DB, "SELECT * FROM client_services WHERE id = ?", service.id)) });
}

function decorateService(row) {
  if (!row) return null;
  const decorated = { ...row, signal_types: parseJsonColumn(row.signal_types, []) };
  for (const key of SERVICE_LIST_FIELDS) decorated[key] = parseJsonColumn(row[key], []);
  return decorated;
}

function decorateOffer(row) {
  return row ? { ...row, proof_points: parseJsonColumn(row.proof_points, []) } : null;
}

async function listOffers({ env, params }) {
  const client = await one(env.DB, "SELECT * FROM clients WHERE id = ?", params.id);
  if (!client) return error(env, 404, "not-found");
  const offers = await all(env.DB,
    "SELECT * FROM client_offers WHERE client_id = ? ORDER BY active DESC, name", client.id);
  return json(env, { client, offers: offers.map(decorateOffer) });
}

async function createOffer({ request, env, params }) {
  const client = await one(env.DB, "SELECT * FROM clients WHERE id = ? AND status != 'archived'", params.id);
  if (!client) return error(env, 404, "not-found");
  const check = validateBody(await readBody(request, env), offerSchema);
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const value = check.value;
  const id = makeId("client-offer");
  const now = nowIso();
  await run(env.DB,
    `INSERT INTO client_offers (id, client_id, name, description, ideal_customer,
       proof_points, economics_note, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    id, client.id, value.name, value.description, value.ideal_customer,
    JSON.stringify(value.proof_points), value.economics_note, now, now);
  await audit(env.DB, { action: "client-offer.create", subjectType: "client-offer", subjectId: id,
    detail: { client_id: client.id, name: value.name } });
  return json(env, { offer: decorateOffer(await one(env.DB, "SELECT * FROM client_offers WHERE id = ?", id)) }, 201);
}

async function patchOffer({ request, env, params }) {
  const offer = await one(env.DB, "SELECT * FROM client_offers WHERE id = ?", params.id);
  if (!offer) return error(env, 404, "not-found");
  const check = validateBody(await readBody(request, env), {
    name: { type: "string", max: LIMITS.shortText },
    description: { type: "string", max: LIMITS.mediumText },
    ideal_customer: { type: "string", max: LIMITS.mediumText },
    proof_points: { type: "array", maxItems: 20, items: { type: "string", max: LIMITS.mediumText } },
    economics_note: { type: "string", max: LIMITS.mediumText },
    active: { type: "boolean" },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const value = check.value;
  await run(env.DB,
    `UPDATE client_offers SET name = ?, description = ?, ideal_customer = ?, proof_points = ?,
       economics_note = ?, active = ?, updated_at = ? WHERE id = ?`,
    value.name ?? offer.name, value.description ?? offer.description,
    value.ideal_customer ?? offer.ideal_customer,
    value.proof_points ? JSON.stringify(value.proof_points) : offer.proof_points,
    value.economics_note ?? offer.economics_note,
    value.active === undefined ? offer.active : value.active ? 1 : 0,
    nowIso(), offer.id);
  await audit(env.DB, { action: "client-offer.update", subjectType: "client-offer", subjectId: offer.id,
    detail: { changed: Object.keys(value) } });
  return json(env, { offer: decorateOffer(await one(env.DB, "SELECT * FROM client_offers WHERE id = ?", offer.id)) });
}

export const clientRoutes = [
  ["GET", "/api/clients", listClients],
  ["POST", "/api/clients", createClient],
  ["GET", "/api/clients/:id/services", listServices],
  ["POST", "/api/clients/:id/services", createService],
  ["PATCH", "/api/services/:id", patchService],
  ["GET", "/api/clients/:id/offers", listOffers],
  ["POST", "/api/clients/:id/offers", createOffer],
  ["PATCH", "/api/client-offers/:id", patchOffer],
];
