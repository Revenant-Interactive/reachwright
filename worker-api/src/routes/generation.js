/**
 * Resumable Generate-5 pipeline.
 *
 * A run persists after every bounded step. The console can initiate and keep
 * advancing it from one operator action without holding a single fragile
 * request open across 25–50 candidates. Nothing in this route sends outreach.
 */

import { json, error, readBody } from "../index.js";
import { all, audit, one, run, parseJsonColumn } from "../db.js";
import { makeId, nowIso, today, validateBody, LIMITS } from "../lib/validate.js";
import { getProviders, generationSourcesStatus } from "../providers/registry.js";
import { identityKeys, normalizeDomain, normalizeName } from "../lib/normalize.js";
import { findDuplicate, mergedIdentityKeys } from "../lib/dedupe.js";
import { suppressionKeysFor, checkSuppression } from "../lib/suppression.js";
import { dossierFingerprint } from "../lib/dossier.js";
import { contentHash } from "../lib/drafts.js";
import { contactForChannel } from "../lib/contact.js";
import { scoreFit, scoreEvidence, deriveEvidenceInputs, passesQueueThreshold, RULE_VERSION } from "../lib/scoring.js";
import { researchOfficialWebsite } from "../lib/website-research.js";
import { evaluateCandidate, parseModelRow } from "../lib/market-model.js";
import {
  GENERATION_VERSION, MESSAGE_OPTION_VERSION, buildMessageOptions, candidateConfidence,
  assessMarketFit, contactRoutesForPerson, decisionMakerRank, isDecisionMaker, prepareAuditRecommendation,
  recommendScores, recommendService, routeChannel, selectContactRoute,
} from "../lib/generation.js";

const createSchema = {
  campaign_id: { type: "string", required: true, max: 80 },
  target_ready: { type: "number", integer: true, min: 1, max: 10, default: 5 },
  candidate_cap: { type: "number", integer: true, min: 5, max: 50, default: 25 },
  credit_budget: { type: "number", min: 0, max: 1000, default: 10 },
  sources: { type: "array", maxItems: 6, items: { type: "string", max: 40 }, default: [] },
  keywords: { type: "array", maxItems: 12, items: { type: "string", max: 80 }, default: [] },
  locations: { type: "array", maxItems: 8, items: { type: "string", max: 120 }, default: [] },
  employee_ranges: { type: "array", maxItems: 8, items: { type: "string", max: 30 }, default: [] },
  start_immediately: { type: "boolean", default: true },
  initial_batch: { type: "number", integer: true, min: 1, max: 5, default: 2 },
};

async function createGenerationRun({ request, env }) {
  const check = validateBody(await readBody(request, env), createSchema);
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const value = check.value;
  if (value.candidate_cap < value.target_ready) {
    return json(env, { error: "candidate-cap-below-target" }, 422);
  }
  const campaign = await one(env.DB, "SELECT * FROM campaigns WHERE id = ?", value.campaign_id);
  if (!campaign) return error(env, 404, "campaign-not-found");
  if (!campaignBriefComplete(campaign)) return json(env, { error: "brief-incomplete" }, 409);
  const client = await one(env.DB, "SELECT * FROM clients WHERE id = ? AND status = 'active'", campaign.client_id);
  if (!client) return json(env, { error: "client-not-active" }, 409);

  const available = getProviders(env);
  const selected = selectProviders(available, value.sources);
  if (!selected.length) {
    return json(env, { error: "provider-not-configured", sources: generationSourcesStatus(env) }, 503);
  }
  const id = makeId("g");
  const now = nowIso();
  const query = {
    keywords: value.keywords.length ? value.keywords : deriveKeywords(campaign),
    locations: value.locations.length ? value.locations : [campaign.geography],
    employeeRanges: value.employee_ranges,
  };
  await run(env.DB,
    `INSERT INTO generation_runs (id, client_id, campaign_id, target_ready, candidate_cap, credit_budget,
       status, source_plan, query_snapshot, counts, started_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'discovering', ?, ?, '{}', ?, ?)`,
    id, campaign.client_id, campaign.id, value.target_ready, value.candidate_cap, value.credit_budget,
    JSON.stringify(selected.map((provider) => provider.name)), JSON.stringify(query), now, now);
  if (campaign.status !== "researching") {
    await run(env.DB, "UPDATE campaigns SET status = 'researching', updated_at = ? WHERE id = ?", now, campaign.id);
  }
  await generationEvent(env, { runId: id, stage: "discovery", eventType: "run-created", status: "started",
    detail: { target_ready: value.target_ready, candidate_cap: value.candidate_cap,
      sources: selected.map((provider) => provider.name), version: GENERATION_VERSION } });

  await discoverCandidates(env, await loadRun(env, id), campaign, selected);
  if (value.start_immediately) await advanceRun(env, id, value.initial_batch);
  await audit(env.DB, { action: "generation.run-create", subjectType: "generation-run", subjectId: id,
    detail: { campaign_id: campaign.id, target_ready: value.target_ready, candidate_cap: value.candidate_cap } });
  return json(env, await generationRunPayload(env, id), 201);
}

async function listGenerationRuns({ env, url }) {
  const campaignId = url.searchParams.get("campaign_id");
  const clientId = url.searchParams.get("client_id");
  let rows;
  if (campaignId) rows = await all(env.DB,
    `SELECT gr.*, ca.name AS campaign_name, cl.name AS client_name
     FROM generation_runs gr JOIN campaigns ca ON ca.id = gr.campaign_id JOIN clients cl ON cl.id = gr.client_id
     WHERE gr.campaign_id = ? ORDER BY gr.started_at DESC LIMIT 100`, campaignId);
  else if (clientId) rows = await all(env.DB,
    `SELECT gr.*, ca.name AS campaign_name, cl.name AS client_name
     FROM generation_runs gr JOIN campaigns ca ON ca.id = gr.campaign_id JOIN clients cl ON cl.id = gr.client_id
     WHERE gr.client_id = ? ORDER BY gr.started_at DESC LIMIT 100`, clientId);
  else rows = await all(env.DB,
    `SELECT gr.*, ca.name AS campaign_name, cl.name AS client_name
     FROM generation_runs gr JOIN campaigns ca ON ca.id = gr.campaign_id JOIN clients cl ON cl.id = gr.client_id
     ORDER BY gr.started_at DESC LIMIT 100`);
  return json(env, { runs: rows.map(decorateRun) });
}

async function getGenerationRun({ env, params }) {
  const payload = await generationRunPayload(env, params.id);
  return payload ? json(env, payload) : error(env, 404, "not-found");
}

async function advanceGenerationRun({ request, env, params }) {
  const body = await readBody(request, env);
  const check = validateBody(body ?? {}, {
    batch: { type: "number", integer: true, min: 1, max: 10, default: 3 },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const existing = await loadRun(env, params.id);
  if (!existing) return error(env, 404, "not-found");
  if (["paused", "canceled", "failed"].includes(existing.status)) {
    return json(env, { error: `run-${existing.status}` }, 409);
  }
  await advanceRun(env, existing.id, check.value.batch);
  return json(env, await generationRunPayload(env, existing.id));
}

async function retryGenerationRun({ request, env, params }) {
  const existing = await loadRun(env, params.id);
  if (!existing) return error(env, 404, "not-found");
  const check = validateBody((await readBody(request, env)) ?? {}, {
    batch: { type: "number", integer: true, min: 1, max: 10, default: 3 },
    include_rejected: { type: "boolean", default: true },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const recoverableRejections = ["website-missing", "website-too-large", "no-observable-opportunity", "no-observable-buying-capacity",
    "decision-maker-not-found", "verified-contact-not-found", "service-match-not-found",
    "below-proposed-threshold", "copywriting-market-gate-failed"];
  const rejectedPlaceholders = recoverableRejections.map(() => "?").join(",");
  const retryable = check.value.include_rejected
    ? await all(env.DB,
      `SELECT id, stage, rejection_reason, last_error FROM generation_candidates
       WHERE run_id = ? AND attempt_count < 3
         AND (stage = 'failed' OR (stage = 'rejected' AND rejection_reason IN (${rejectedPlaceholders})))`,
      existing.id, ...recoverableRejections)
    : await all(env.DB,
      `SELECT id, stage, rejection_reason, last_error FROM generation_candidates
       WHERE run_id = ? AND stage = 'failed' AND attempt_count < 3`, existing.id);
  if (!retryable.length) return json(env, { error: "no-retryable-candidates",
    detail: "No transient failures or safely recoverable rejected candidates remain." }, 409);
  for (const row of retryable) {
    await run(env.DB,
      "UPDATE generation_candidates SET stage = 'discovered', rejection_reason = '', last_error = '', updated_at = ? WHERE id = ?",
      nowIso(), row.id);
    await generationEvent(env, { runId: existing.id, candidateId: row.id, stage: "researching",
      eventType: "candidate-retry", status: "retrying",
      detail: { previous_stage: row.stage, previous_reason: row.last_error || row.rejection_reason } });
  }
  await run(env.DB,
    "UPDATE generation_runs SET status = 'researching', failure_code = '', last_error = '', completed_at = NULL, updated_at = ? WHERE id = ?",
    nowIso(), existing.id);
  await advanceRun(env, existing.id, check.value.batch);
  return json(env, { ...(await generationRunPayload(env, existing.id)),
    retry_summary: { requeued: retryable.length, processed_batch: check.value.batch } });
}

async function patchGenerationRun({ request, env, params }) {
  const existing = await loadRun(env, params.id);
  if (!existing) return error(env, 404, "not-found");
  const check = validateBody(await readBody(request, env), {
    action: { type: "string", required: true, enum: ["pause", "resume", "cancel"] },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  const next = check.value.action === "pause" ? "paused"
    : check.value.action === "cancel" ? "canceled" : "researching";
  if (["completed", "canceled"].includes(existing.status) && check.value.action !== "cancel") {
    return json(env, { error: "run-terminal" }, 409);
  }
  await run(env.DB, "UPDATE generation_runs SET status = ?, updated_at = ? WHERE id = ?", next, nowIso(), existing.id);
  await generationEvent(env, { runId: existing.id, stage: "run", eventType: `run-${check.value.action}`,
    status: check.value.action === "resume" ? "retrying" : "succeeded", detail: {} });
  return json(env, await generationRunPayload(env, existing.id));
}

async function getProspectPacket({ env, params }) {
  const packet = await one(env.DB,
    `SELECT pp.* FROM prospect_packets pp JOIN generation_candidates gc ON gc.id = pp.candidate_id
     WHERE pp.run_id = ? AND pp.candidate_id = ?`, params.rid, params.cid);
  if (!packet) return error(env, 404, "not-found");
  const current = await currentSourceFingerprint(env, packet.campaign_id, packet.organization_id);
  if (current !== packet.source_fingerprint && packet.status !== "stale") {
    await run(env.DB, "UPDATE prospect_packets SET status = 'stale', updated_at = ? WHERE id = ?", nowIso(), packet.id);
    packet.status = "stale";
  }
  const payload = parseJsonColumn(packet.payload, {});
  return json(env, { packet: payload, packet_hash: packet.packet_hash, status: packet.status,
    stale: current !== packet.source_fingerprint });
}

async function prospectFeed({ env }) {
  const campaignId = String(env.AUTO_DISCOVERY_CAMPAIGN_ID || "rw-c-copywriting-feed");
  const campaign = await one(env.DB, "SELECT * FROM campaigns WHERE id = ?", campaignId);
  if (!campaign) return json(env, { error: "prospect-feed-campaign-missing" }, 503);
  const sourceStatus = generationSourcesStatus(env);
  const target = Math.max(1, Math.min(10, Number.parseInt(env.AUTO_DISCOVERY_TARGET || "5", 10)));
  const candidateCap = Math.max(5, Math.min(50,
    Number.parseInt(env.AUTO_DISCOVERY_CANDIDATE_CAP || "40", 10)));
  const creditBudget = Math.max(0, Number.parseFloat(env.AUTO_DISCOVERY_CREDIT_BUDGET || "10"));
  const latestRun = await one(env.DB,
    "SELECT * FROM generation_runs WHERE campaign_id = ? ORDER BY started_at DESC LIMIT 1", campaign.id);
  const activeRun = await one(env.DB,
    `SELECT id, status FROM generation_runs WHERE campaign_id = ?
     AND status IN ('queued','discovering','researching') ORDER BY started_at DESC LIMIT 1`, campaign.id);
  const rows = await all(env.DB,
    `SELECT gc.*, gr.started_at AS run_started_at, o.display_name AS organization_name,
       o.normalized_domain, o.location, o.provider, p.full_name AS person_name, p.title AS person_title,
       cr.route_type, cr.route_value, cr.source_url AS contact_source_url,
       cr.verification_state AS contact_verification_state, cs.name AS service_name,
       os.signal_type, os.claim AS opportunity_claim, os.source_url AS opportunity_source_url,
       os.detected_at AS opportunity_detected_at, pp.status AS packet_status
     FROM generation_candidates gc
     JOIN generation_runs gr ON gr.id = gc.run_id
     JOIN organizations o ON o.id = gc.organization_id
     LEFT JOIN people p ON p.id = gc.primary_person_id
     LEFT JOIN contact_routes cr ON cr.id = gc.contact_route_id
     LEFT JOIN client_services cs ON cs.id = gc.recommended_service_id
     LEFT JOIN opportunity_signals os ON os.id = gc.primary_signal_id
     LEFT JOIN prospect_packets pp ON pp.candidate_id = gc.id
     WHERE gc.campaign_id = ? AND gc.stage = 'message-ready'
       AND o.provider != 'local-fixtures' AND o.display_name NOT LIKE '[FIXTURE]%'
       AND (pp.status IS NULL OR pp.status NOT IN ('rejected','stale'))
       AND gc.rowid = (SELECT MAX(gc2.rowid) FROM generation_candidates gc2
         WHERE gc2.campaign_id = gc.campaign_id AND gc2.organization_id = gc.organization_id
           AND gc2.stage = 'message-ready')
     ORDER BY gc.confidence DESC, gc.updated_at DESC LIMIT 30`, campaign.id);
  const cooldownHours = Math.max(1, Number.parseInt(env.AUTO_DISCOVERY_COOLDOWN_HOURS || "24", 10));
  const lastStarted = latestRun?.started_at ? new Date(latestRun.started_at).getTime() : 0;
  const cooldownElapsed = !lastStarted || Date.now() - lastStarted >= cooldownHours * 3_600_000;
  const realSources = sourceStatus.configured && sourceStatus.mode !== "test-fixtures-only";
  const autoEnabled = env.AUTO_DISCOVERY_ENABLED === "true" && realSources;
  return json(env, {
    campaign: decorateFeedCampaign(campaign),
    prospects: rows.map((row) => ({ ...decorateCandidate(row),
      next_action: row.packet_status === "approved" ? "Open the approved draft"
        : "Review the cited evidence and choose one message",
    })),
    source_status: sourceStatus,
    active_run: activeRun,
    latest_run: latestRun ? decorateRun(latestRun) : null,
    auto_enabled: autoEnabled,
    needs_refill: rows.length < target && !activeRun && cooldownElapsed && realSources,
    refill: {
      campaign_id: campaign.id, target_ready: target, candidate_cap: candidateCap,
      credit_budget: creditBudget, keywords: parseJsonColumn(campaign.positive_signals, []),
      locations: [campaign.geography], start_immediately: true, initial_batch: 2,
    },
    cooldown_hours: cooldownHours,
  });
}

async function decideProspectPacket({ request, env, params }) {
  const candidate = await one(env.DB,
    `SELECT gc.*, gr.client_id, gr.status AS run_status FROM generation_candidates gc
     JOIN generation_runs gr ON gr.id = gc.run_id WHERE gc.run_id = ? AND gc.id = ?`, params.rid, params.cid);
  if (!candidate) return error(env, 404, "not-found");
  const packet = await one(env.DB, "SELECT * FROM prospect_packets WHERE candidate_id = ?", candidate.id);
  if (!packet) return error(env, 404, "packet-not-found");
  const body = await readBody(request, env);
  const check = validateBody(body, {
    action: { type: "string", required: true, enum: ["approve", "reject", "refresh"] },
    packet_hash: { type: "string", required: true, max: 128 },
    reason: { type: "string", max: LIMITS.mediumText, default: "" },
    evidence_decisions: { type: "object", default: {} },
    checklist: { type: "object", default: {} },
    use_recommended_scores: { type: "boolean", default: false },
    fit_inputs: { type: "object", default: {} },
    disqualifiers: { type: "array", maxItems: 20, items: { type: "object" }, default: [] },
    selected_message_option_id: { type: "string", max: 80, default: "" },
  });
  if (!check.ok) return json(env, { error: "validation", details: check.errors }, 422);
  if (check.value.packet_hash !== packet.packet_hash) return json(env, { error: "packet-stale" }, 409);
  const current = await currentSourceFingerprint(env, candidate.campaign_id, candidate.organization_id);
  if (current !== packet.source_fingerprint) {
    await run(env.DB, "UPDATE prospect_packets SET status = 'stale', updated_at = ? WHERE id = ?", nowIso(), packet.id);
    return json(env, { error: "packet-stale", detail: "evidence or contact data changed; refresh the candidate" }, 409);
  }
  if (check.value.action === "reject") {
    if (!check.value.reason.trim()) return json(env, { error: "rejection-reason-required" }, 422);
    await run(env.DB, "UPDATE prospect_packets SET status = 'rejected', updated_at = ? WHERE id = ?", nowIso(), packet.id);
    await setCandidateStage(env, candidate, "rejected", { rejectionReason: check.value.reason });
    await audit(env.DB, { action: "generation.packet-reject", subjectType: "generation-candidate", subjectId: candidate.id,
      detail: { reason: check.value.reason } });
    return json(env, { candidate_id: candidate.id, status: "rejected" });
  }
  if (check.value.action === "refresh") {
    await run(env.DB, "UPDATE prospect_packets SET status = 'stale', updated_at = ? WHERE id = ?", nowIso(), packet.id);
    await run(env.DB,
      "UPDATE generation_candidates SET stage = 'discovered', last_error = '', updated_at = ? WHERE id = ?",
      nowIso(), candidate.id);
    return json(env, { candidate_id: candidate.id, status: "queued-for-refresh" });
  }
  return approveProspectPacket(env, candidate, packet, check.value);
}

async function discoverCandidates(env, generationRun, campaign, providers) {
  const existingLinks = await all(env.DB,
    `SELECT DISTINCT o.id FROM organizations o JOIN evidence_items e ON e.organization_id = o.id
     WHERE e.campaign_id = ? AND o.merge_state != 'merged'
       AND NOT EXISTS (SELECT 1 FROM generation_candidates prior
         WHERE prior.campaign_id = ? AND prior.organization_id = o.id)`,
    campaign.id, campaign.id);
  for (const row of existingLinks.slice(0, generationRun.candidate_cap)) {
    await attachGenerationCandidate(env, generationRun, row.id, "manual-or-existing");
  }
  const query = parseJsonColumn(generationRun.query_snapshot, {});
  const providerCount = Math.max(1, providers.length);
  for (const provider of providers) {
    if (provider.capabilities?.organization_search === false) continue;
    const keywords = query.keywords || [];
    // Search distinct market lanes before a combined fallback query. A single
    // broad provider call otherwise fills the cap from one industry and makes
    // a twelve-market campaign look like a roofing-only list.
    const desiredCalls = Math.min(6, Math.max(1, keywords.length || 1));
    const perCall = Math.max(5, Math.ceil(generationRun.candidate_cap / providerCount / desiredCalls) + 2);
    const maxBatch = Math.min(perCall, Number(provider.maxSearchBatch) || 25);
    const keywordSets = [...keywords.map((keyword) => [keyword]), keywords]
      .filter((set, index, sets) => set.length === 0 || sets.findIndex((other) => JSON.stringify(other) === JSON.stringify(set)) === index);
    for (const searchKeywords of keywordSets.slice(0, desiredCalls)) {
      const stored = Number((await one(env.DB,
        "SELECT COUNT(*) AS n FROM generation_candidates WHERE run_id = ?", generationRun.id))?.n || 0);
      if (stored >= generationRun.candidate_cap) break;
      const estimate = provider.estimateCredits({ operation: "searchOrganizations", pages: 1, perPage: maxBatch });
      if (!(await providerBudgetAllows(env, generationRun, estimate.estimated))) {
        await generationEvent(env, { runId: generationRun.id, provider: provider.name, stage: "discovery",
          eventType: "provider-call", status: "skipped", errorCode: "run-credit-budget",
          detail: { operation: "searchOrganizations" }, credits: 0 });
        break;
      }
      const started = Date.now();
      const result = await provider.searchOrganizations({
        locations: query.locations || [campaign.geography], keywords: searchKeywords,
        employeeRanges: query.employeeRanges || [], page: 1, perPage: maxBatch,
      });
      await recordProviderCall(env, generationRun, null, provider, "discovery", "searchOrganizations",
        estimate, result, Date.now() - started);
      if (result.error) continue;
      for (const record of result.records || []) {
        await storeDiscoveredRecord(env, generationRun, campaign, provider, record);
      }
    }
  }
  const count = await one(env.DB, "SELECT COUNT(*) AS n FROM generation_candidates WHERE run_id = ?", generationRun.id);
  const nextStatus = Number(count?.n || 0) ? "researching" : "failed";
  await run(env.DB,
    "UPDATE generation_runs SET status = ?, failure_code = ?, last_error = ?, updated_at = ? WHERE id = ?",
    nextStatus, nextStatus === "failed" ? "no-candidates" : "",
    nextStatus === "failed" ? "No unique unsuppressed candidates were discovered." : "", nowIso(), generationRun.id);
  await refreshRunCounts(env, generationRun.id);
  await generationEvent(env, { runId: generationRun.id, stage: "discovery", eventType: "discovery-complete",
    status: nextStatus === "failed" ? "failed" : "succeeded", errorCode: nextStatus === "failed" ? "no-candidates" : "",
    detail: { candidates: Number(count?.n || 0) } });
}

async function advanceRun(env, runId, batch) {
  let generationRun = await loadRun(env, runId);
  if (!generationRun || ["paused", "canceled", "failed"].includes(generationRun.status)) return;
  const readyBefore = await readyCount(env, runId);
  if (readyBefore >= generationRun.target_ready) return completeRun(env, generationRun, "target-reached");
  await run(env.DB, "UPDATE generation_runs SET status = 'researching', updated_at = ? WHERE id = ?", nowIso(), runId);
  const pending = await all(env.DB,
    `SELECT * FROM generation_candidates WHERE run_id = ? AND stage = 'discovered'
     ORDER BY created_at, id LIMIT ?`, runId, batch);
  for (const candidate of pending) {
    generationRun = await loadRun(env, runId);
    if (await readyCount(env, runId) >= generationRun.target_ready) break;
    await processCandidate(env, generationRun, candidate);
  }
  const ready = await readyCount(env, runId);
  const remaining = await one(env.DB,
    "SELECT COUNT(*) AS n FROM generation_candidates WHERE run_id = ? AND stage = 'discovered'", runId);
  if (ready >= generationRun.target_ready) await completeRun(env, generationRun, "target-reached");
  else if (!Number(remaining?.n || 0)) await completeRun(env, generationRun, "candidate-pool-exhausted", true);
  else await refreshRunCounts(env, runId);
}

async function processCandidate(env, generationRun, candidate) {
  const campaign = await one(env.DB, "SELECT * FROM campaigns WHERE id = ?", candidate.campaign_id);
  const organization = await one(env.DB, "SELECT * FROM organizations WHERE id = ?", candidate.organization_id);
  if (!campaign || !organization) return failCandidate(env, candidate, "candidate-parent-missing", false);
  await run(env.DB,
    "UPDATE generation_candidates SET stage = 'researching', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?",
    nowIso(), candidate.id);
  candidate.stage = "researching";
  candidate.attempt_count = Number(candidate.attempt_count || 0) + 1;
  await generationEvent(env, { runId: generationRun.id, candidateId: candidate.id, stage: "researching",
    eventType: "candidate-stage", status: "started", detail: { organization_id: organization.id } });

  const suppressed = checkSuppression(
    suppressionKeysFor({ organization }),
    await all(env.DB, "SELECT key_type, key_value, reason, expires_at FROM suppression_entries"),
  );
  if (suppressed.suppressed) return rejectCandidate(env, candidate, "suppressed");
  if (!organization.normalized_domain) return rejectCandidate(env, candidate, "website-missing");

  const fixtureDocuments = env.DEV_FIXTURES === "true" && organization.provider === "local-fixtures"
    ? fixtureWebsiteDocuments(organization) : null;
  const website = await researchOfficialWebsite({
    domain: organization.normalized_domain,
    timeoutMs: Number.parseInt(env.WEBSITE_RESEARCH_TIMEOUT_MS || env.PROVIDER_TIMEOUT_MS || "12000", 10),
    maxBytes: Number.parseInt(env.WEBSITE_RESEARCH_MAX_BYTES || "1000000", 10),
    maxPages: Number.parseInt(env.WEBSITE_RESEARCH_MAX_PAGES || "4", 10),
    fixtureDocuments,
  });
  await persistWebsiteResearch(env, generationRun, organization, website);
  if (website.status !== "fetched") {
    return failCandidate(env, candidate, website.error || "website-research-failed", website.retryable);
  }
  const evidence = [];
  for (const fact of website.facts) evidence.push(await ensureEvidence(env, campaign, organization, fact));
  const signals = [];
  for (const proposal of website.signals) {
    const evidenceItem = await ensureEvidence(env, campaign, organization, proposal);
    evidence.push(evidenceItem);
    signals.push({ ...proposal, evidence_id: evidenceItem.id });
  }
  if (!signals.length) return rejectCandidate(env, candidate, "no-observable-opportunity");

  const capacitySignals = [];
  for (const proposal of website.capacity_signals || []) {
    const evidenceItem = await ensureEvidence(env, campaign, organization, proposal);
    evidence.push(evidenceItem);
    capacitySignals.push({ ...proposal, evidence_id: evidenceItem.id });
  }
  if (!capacitySignals.length) return rejectCandidate(env, candidate, "no-observable-buying-capacity");

  const runQuery = parseJsonColumn(generationRun.query_snapshot, {});
  const marketFit = assessMarketFit({ campaign, organization, website,
    queryKeywords: runQuery.keywords || [], employeeRanges: runQuery.employeeRanges || [] });
  await run(env.DB, "UPDATE generation_candidates SET market_fit_recommendation = ?, updated_at = ? WHERE id = ?",
    JSON.stringify(marketFit), nowIso(), candidate.id);

  await persistOfficialDecisionMakers(env, organization, website.decision_makers);
  const providers = selectProviders(getProviders(env), parseJsonColumn(generationRun.source_plan, []));
  await resolvePeopleAcrossProviders(env, generationRun, candidate, organization, providers);
  let people = (await all(env.DB, "SELECT * FROM people WHERE organization_id = ?", organization.id))
    .filter(isDecisionMaker).sort((a, b) => decisionMakerRank(a) - decisionMakerRank(b));
  if (!people.length) return rejectCandidate(env, candidate, "decision-maker-not-found");

  const routePairs = [];
  for (const person of people) {
    const proposed = contactRoutesForPerson(person, website.contact_paths);
    for (const route of proposed) {
      const stored = await ensureContactRoute(env, organization, person, route);
      routePairs.push({ person, route: stored });
    }
  }
  let selectedPair = routePairs.filter((pair) => selectContactRoute([pair.route], campaign.allowed_channels))
    .sort((a, b) => decisionMakerRank(a.person) - decisionMakerRank(b.person)
      || Number(b.route.confidence) - Number(a.route.confidence))[0] || null;
  if (!selectedPair) {
    await enrichPeopleForContact(env, generationRun, candidate, organization, people, providers);
    people = (await all(env.DB, "SELECT * FROM people WHERE organization_id = ?", organization.id))
      .filter(isDecisionMaker).sort((a, b) => decisionMakerRank(a) - decisionMakerRank(b));
    for (const person of people) {
      for (const route of contactRoutesForPerson(person, website.contact_paths)) {
        const stored = await ensureContactRoute(env, organization, person, route);
        if (!selectedPair && selectContactRoute([stored], campaign.allowed_channels)) selectedPair = { person, route: stored };
      }
    }
  }
  if (!selectedPair) return rejectCandidate(env, candidate, "verified-contact-not-found");
  await setCandidateStage(env, candidate, "contact-found", {
    primaryPersonId: selectedPair.person.id, contactRouteId: selectedPair.route.id,
  });

  for (const signal of [...signals, ...capacitySignals]) {
    await ensureOpportunitySignal(env, generationRun, candidate, signal);
  }
  const storedSignals = await all(env.DB,
    "SELECT * FROM opportunity_signals WHERE run_id = ? AND organization_id = ? ORDER BY confidence DESC, detected_at",
    generationRun.id, organization.id);
  const services = await all(env.DB,
    "SELECT * FROM client_services WHERE client_id = ? AND active = 1 ORDER BY priority, name", generationRun.client_id);
  const copySignals = storedSignals.filter((signal) => signal.dimension === "copy-opportunity");
  const match = recommendService(copySignals.map((signal) => ({ ...signal, type: signal.signal_type })), services,
    { organization, website });
  if (!match) return rejectCandidate(env, candidate, "service-match-not-found");
  const primarySignal = match.signal;
  await run(env.DB, "UPDATE opportunity_signals SET service_id = ? WHERE id = ?", match.service.id, primarySignal.id);
  const campaignEvidence = await all(env.DB,
    "SELECT * FROM evidence_items WHERE organization_id = ? AND campaign_id = ?", organization.id, campaign.id);
  const scoreRecommendation = recommendScores({ campaign, organization, evidence: campaignEvidence,
    signals: storedSignals, contactRoute: selectedPair.route, marketFit });
  if (!scoreRecommendation.proposed_pass) return rejectCandidate(env, candidate, "below-proposed-threshold");
  const marketEvaluation = await buildMarketEvaluation(env, {
    campaign, organization, generationRun, marketFit, primarySignal,
    capacitySignals: storedSignals.filter((signal) => signal.dimension === "buying-trigger"),
    service: match.service, person: selectedPair.person, contactRoute: selectedPair.route,
    evidence: campaignEvidence,
  });
  await run(env.DB,
    "UPDATE generation_candidates SET market_evaluation = ?, updated_at = ? WHERE id = ?",
    JSON.stringify(marketEvaluation), nowIso(), candidate.id);
  if (!marketEvaluation.qualified) return rejectCandidate(env, candidate, "copywriting-market-gate-failed");
  const auditRecommendation = prepareAuditRecommendation({ organization, evidence: campaignEvidence,
    person: selectedPair.person, contactRoute: selectedPair.route, primarySignal, marketFit });
  const confidence = candidateConfidence({ serviceMatch: match, contactRoute: selectedPair.route,
    scoreRecommendation, auditRecommendation });
  const rationale = `${organization.display_name} has a cited ${primarySignal.signal_type} observation, observable lead-generation capacity, a ${selectedPair.route.verification_state} ${selectedPair.route.route_type} route to ${selectedPair.person.full_name}, and a copywriting-market priority of ${marketEvaluation.overall_priority}.`;
  await run(env.DB,
    `UPDATE generation_candidates SET stage = 'qualified', primary_person_id = ?, contact_route_id = ?,
       primary_signal_id = ?, recommended_service_id = ?, fit_recommendation = ?, evidence_recommendation = ?,
       audit_recommendation = ?, market_evaluation = ?, qualification_rationale = ?, confidence = ?, updated_at = ? WHERE id = ?`,
    selectedPair.person.id, selectedPair.route.id, primarySignal.id, match.service.id,
    JSON.stringify(scoreRecommendation.fit), JSON.stringify(scoreRecommendation.evidence),
    JSON.stringify(auditRecommendation), JSON.stringify(marketEvaluation), rationale, confidence, nowIso(), candidate.id);
  await generationEvent(env, { runId: generationRun.id, candidateId: candidate.id, stage: "qualified",
    eventType: "candidate-stage", status: "succeeded", detail: { fit: scoreRecommendation.fit.total,
      evidence: scoreRecommendation.evidence.total, market_priority: marketEvaluation.overall_priority,
      service_id: match.service.id } });

  const channel = routeChannel(selectedPair.route.route_type);
  const options = await buildMessageOptions({ campaign, organization, person: selectedPair.person,
    signal: { ...primarySignal, evidence_id: primarySignal.evidence_id }, service: match.service, channel });
  if (!options.length) return failCandidate(env, candidate, "message-options-failed", false);
  await run(env.DB,
    "UPDATE strategic_message_options SET status = 'rejected' WHERE candidate_id = ? AND status = 'proposed'",
    candidate.id);
  const storedOptions = [];
  for (const option of options) {
    const id = makeId("message");
    await run(env.DB,
      `INSERT INTO strategic_message_options (id, run_id, candidate_id, campaign_id, organization_id,
         person_id, channel, strategy, service_id, opportunity_signal_id, evidence_ids, body,
         content_hash, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`,
      id, generationRun.id, candidate.id, campaign.id, organization.id, selectedPair.person.id,
      channel, option.strategy, match.service.id, primarySignal.id, JSON.stringify(option.evidence_ids),
      option.body, option.content_hash, nowIso());
    storedOptions.push({ id, channel, strategy: option.strategy, body: option.body,
      content_hash: option.content_hash, evidence_ids: option.evidence_ids, version: MESSAGE_OPTION_VERSION });
  }
  const peopleCurrent = await all(env.DB, "SELECT * FROM people WHERE organization_id = ?", organization.id);
  const sourceFingerprint = await dossierFingerprint(campaignEvidence, peopleCurrent);
  const packetPayload = {
    run: { id: generationRun.id, campaign_id: campaign.id, client_id: generationRun.client_id },
    company: { id: organization.id, name: organization.display_name, domain: organization.normalized_domain,
      location: organization.location, official_website: website.final_url },
    decision_maker: { id: selectedPair.person.id, name: selectedPair.person.full_name,
      title: selectedPair.person.title, source_provider: selectedPair.person.source_provider },
    contact_route: { id: selectedPair.route.id, type: selectedPair.route.route_type,
      value: selectedPair.route.route_value, verification_state: selectedPair.route.verification_state,
      confidence: selectedPair.route.confidence, source_url: selectedPair.route.source_url },
    cited_facts: campaignEvidence.filter((item) => item.source_url.startsWith("http"))
      .map((item) => ({ id: item.id, claim: item.claim, source_url: item.source_url,
        observed_at: item.observed_at, strength: item.strength, reviewer_state: item.reviewer_state })),
    review_items: campaignEvidence.map((item) => ({ id: item.id, claim: item.claim,
      source_url: item.source_url, observed_at: item.observed_at, strength: item.strength,
      reviewer_state: item.reviewer_state, contradiction_state: item.contradiction_state })),
    opportunity: { id: primarySignal.id, type: primarySignal.signal_type, claim: primarySignal.claim,
      source_url: primarySignal.source_url, evidence_id: primarySignal.evidence_id,
      confidence: primarySignal.confidence, status: "proposed" },
    recommended_service: { id: match.service.id, name: match.service.name,
      description: match.service.description, entry_angle: match.service.entry_angle,
      rationale: match.rationale, confidence: match.confidence },
    qualification: { rationale, confidence, proposed_scores: scoreRecommendation,
      market_evaluation: marketEvaluation,
      audit_recommendation: auditRecommendation },
    message_options: storedOptions,
    exceptions: scoreRecommendation.assumptions,
    review_rule: "Every cited fact, six-check audit item, score input, contact route, and selected message requires operator confirmation before a draft is created.",
    generation_version: GENERATION_VERSION,
  };
  const packetHash = await contentHash(JSON.stringify(packetPayload));
  const priorPacket = await one(env.DB, "SELECT id FROM prospect_packets WHERE candidate_id = ?", candidate.id);
  if (priorPacket) {
    await run(env.DB,
      `UPDATE prospect_packets SET person_id = ?, payload = ?, packet_hash = ?, source_fingerprint = ?,
         status = 'operator-review', updated_at = ? WHERE id = ?`,
      selectedPair.person.id, JSON.stringify(packetPayload), packetHash, sourceFingerprint, nowIso(), priorPacket.id);
  } else {
    await run(env.DB,
      `INSERT INTO prospect_packets (id, run_id, candidate_id, campaign_id, organization_id, person_id,
         payload, packet_hash, source_fingerprint, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'operator-review', ?, ?)`,
      makeId("packet"), generationRun.id, candidate.id, campaign.id, organization.id, selectedPair.person.id,
      JSON.stringify(packetPayload), packetHash, sourceFingerprint, nowIso(), nowIso());
  }
  await run(env.DB, "UPDATE generation_candidates SET stage = 'message-ready', updated_at = ? WHERE id = ?",
    nowIso(), candidate.id);
  await generationEvent(env, { runId: generationRun.id, candidateId: candidate.id, stage: "message-ready",
    eventType: "candidate-stage", status: "succeeded", detail: { message_options: storedOptions.length,
      packet_hash: packetHash } });
}

async function approveProspectPacket(env, candidate, packet, value) {
  if (!value.selected_message_option_id) return json(env, { error: "message-option-required" }, 422);
  const option = await one(env.DB,
    `SELECT * FROM strategic_message_options WHERE id = ? AND candidate_id = ? AND status = 'proposed'`,
    value.selected_message_option_id, candidate.id);
  if (!option) return json(env, { error: "message-option-not-found" }, 422);
  const evidence = await all(env.DB,
    "SELECT * FROM evidence_items WHERE organization_id = ? AND campaign_id = ?",
    candidate.organization_id, candidate.campaign_id);
  const decisionKeys = new Set(Object.keys(value.evidence_decisions || {}));
  const packetPayloadForReview = parseJsonColumn(packet.payload, {});
  const packetEvidenceIds = (packetPayloadForReview.review_items || packetPayloadForReview.cited_facts || [])
    .map((item) => item.id);
  const missing = packetEvidenceIds.filter((id) => !decisionKeys.has(id));
  if (missing.length) return json(env, { error: "evidence-decisions-incomplete", missing }, 422);
  for (const [id, decision] of Object.entries(value.evidence_decisions || {})) {
    if (!packetEvidenceIds.includes(id) || !["accepted", "rejected"].includes(decision)) {
      return json(env, { error: "invalid-evidence-decision", evidence_id: id }, 422);
    }
  }
  const checks = ["identity_verified", "offer_signal_verified", "geography_verified",
    "decision_maker_verified", "contact_path_verified", "contradictions_checked"];
  if (!checks.every((name) => value.checklist?.[name] === true)) {
    return json(env, { error: "dossier-audit-checklist-required", required: checks }, 422);
  }
  const packetPayload = parseJsonColumn(packet.payload, {});
  const recommendedInputs = packetPayload.qualification?.proposed_scores?.fit?.proposed_inputs || {};
  const fitInputs = value.use_recommended_scores ? recommendedInputs : value.fit_inputs;
  const scoreError = validateFitInputs(fitInputs);
  if (scoreError) return json(env, { error: "invalid-fit-inputs", detail: scoreError }, 422);
  const org = await one(env.DB, "SELECT * FROM organizations WHERE id = ?", candidate.organization_id);
  const person = await one(env.DB, "SELECT * FROM people WHERE id = ?", candidate.primary_person_id);
  const campaign = await one(env.DB, "SELECT * FROM campaigns WHERE id = ?", candidate.campaign_id);
  const route = await one(env.DB, "SELECT * FROM contact_routes WHERE id = ?", candidate.contact_route_id);
  if (!org || !person || !campaign || !route) return error(env, 404, "candidate-data-missing");
  const channel = routeChannel(route.route_type);
  if (!parseJsonColumn(campaign.allowed_channels, []).includes(channel)
    || contactForChannel(person, channel) !== route.route_value) {
    return json(env, { error: "exact-contact-route-changed" }, 409);
  }
  const suppression = checkSuppression(suppressionKeysFor({ organization: org, person }),
    await all(env.DB, "SELECT key_type, key_value, reason, expires_at FROM suppression_entries"));
  if (suppression.suppressed) return json(env, { error: "suppressed", matches: suppression.matches }, 409);
  const projectedEvidence = evidence.map((item) => ({
    ...item,
    reviewer_state: value.evidence_decisions[item.id] || item.reviewer_state,
  }));
  const fit = scoreFit(fitInputs, normalizeDisqualifiers(value.disqualifiers));
  const evidenceScore = scoreEvidence(deriveEvidenceInputs(projectedEvidence, {
    contactVerified: ["provider-verified", "first-party", "operator-verified"].includes(route.verification_state),
    today: today(),
  }));
  if (!passesQueueThreshold(fit, evidenceScore)) {
    return json(env, { error: "confirmed-scores-below-threshold", fit: fit.total, evidence: evidenceScore.total }, 409);
  }
  const optionEvidence = parseJsonColumn(option.evidence_ids, []);
  if (optionEvidence.some((id) => !projectedEvidence.some((item) => item.id === id && item.reviewer_state === "accepted"))) {
    return json(env, { error: "selected-message-evidence-not-accepted" }, 409);
  }
  const priorDraft = await one(env.DB,
    `SELECT id FROM outreach_drafts WHERE organization_id = ? AND outreach_kind = 'initial' AND status != 'killed' LIMIT 1`,
    org.id);
  const priorSent = await one(env.DB,
    `SELECT id FROM contact_attempts WHERE organization_id = ? AND direction = 'outbound' AND status = 'sent' LIMIT 1`, org.id);
  if (priorDraft || priorSent) return json(env, { error: "initial-outreach-already-exists",
    draft_id: priorDraft?.id || null, attempt_id: priorSent?.id || null }, 409);

  for (const [id, decision] of Object.entries(value.evidence_decisions)) {
    await run(env.DB,
      "UPDATE evidence_items SET reviewer_state = ? WHERE id = ? AND organization_id = ? AND campaign_id = ?",
      decision, id, org.id, campaign.id);
  }
  const reviewedEvidence = await all(env.DB,
    "SELECT * FROM evidence_items WHERE organization_id = ? AND campaign_id = ?", org.id, campaign.id);
  const people = await all(env.DB, "SELECT * FROM people WHERE organization_id = ?", org.id);
  const fingerprint = await dossierFingerprint(reviewedEvidence, people);
  const now = nowIso();
  await run(env.DB,
    `INSERT INTO dossier_audits (id, campaign_id, organization_id, verdict, notes, auditor, audited_at,
       evidence_hash, checklist) VALUES (?, ?, ?, 'accurate', ?, 'operator', ?, ?, ?)`,
    makeId("audit"), campaign.id, org.id, value.reason || "Generation packet reviewed and confirmed",
    now, fingerprint, JSON.stringify(value.checklist));
  for (const [kind, score] of [["fit", fit], ["evidence", evidenceScore]]) {
    await run(env.DB,
      `INSERT INTO fit_scores (id, campaign_id, organization_id, kind, total, rule_version, factors,
         disqualifiers, scored_at, evidence_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      makeId("s"), campaign.id, org.id, kind, score.total, RULE_VERSION,
      JSON.stringify(score.factors), JSON.stringify(score.disqualifiers), now, fingerprint);
  }
  const draftId = makeId("d");
  await run(env.DB,
    `INSERT INTO outreach_drafts (id, campaign_id, organization_id, person_id, channel, outreach_kind,
       evidence_ids, model_provider, model_version, prompt_version, body, content_hash, status,
       editor_history, created_at, updated_at, generation_candidate_id, message_option_id, service_id, strategy)
     VALUES (?, ?, ?, ?, ?, 'initial', ?, 'deterministic-generation', 'n/a', ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
    draftId, campaign.id, org.id, person.id, channel, option.evidence_ids, MESSAGE_OPTION_VERSION,
    option.body, option.content_hash,
    JSON.stringify([{ at: now, actor: "operator", content_hash: option.content_hash,
      note: "created from confirmed generation packet" }]), now, now, candidate.id, option.id,
    candidate.recommended_service_id, option.strategy);
  await run(env.DB,
    "UPDATE strategic_message_options SET status = CASE WHEN id = ? THEN 'converted' ELSE 'rejected' END, converted_draft_id = CASE WHEN id = ? THEN ? ELSE converted_draft_id END WHERE candidate_id = ?",
    option.id, option.id, draftId, candidate.id);
  await run(env.DB, "UPDATE prospect_packets SET status = 'approved', source_fingerprint = ?, updated_at = ? WHERE id = ?",
    fingerprint, now, packet.id);
  await audit(env.DB, { action: "generation.packet-approve", subjectType: "generation-candidate", subjectId: candidate.id,
    detail: { draft_id: draftId, option_id: option.id, fit: fit.total, evidence: evidenceScore.total } });
  return json(env, { candidate_id: candidate.id, packet_status: "approved", draft_id: draftId,
    draft_status: "draft", fit, evidence: evidenceScore }, 201);
}

async function storeDiscoveredRecord(env, generationRun, campaign, provider, record) {
  const domain = normalizeDomain(record.domain);
  const normalizedName = normalizeName(record.name);
  if (!domain && !normalizedName) return;
  const suppression = checkSuppression(
    suppressionKeysFor({ organization: { domain, name: record.name }, person: {} }),
    await all(env.DB, "SELECT key_type, key_value, reason, expires_at FROM suppression_entries"),
  );
  if (suppression.suppressed) {
    await generationEvent(env, { runId: generationRun.id, provider: provider.name, stage: "discovery",
      eventType: "candidate-suppressed", status: "skipped", errorCode: "suppressed",
      detail: { domain } });
    return;
  }
  const existing = await all(env.DB,
    "SELECT id, identity_keys, merge_state, normalized_domain, normalized_name FROM organizations");
  const duplicate = findDuplicate({ domain: record.domain, name: record.name,
    location: record.location, phone: record.phone }, existing);
  let organizationId;
  if (duplicate.match) {
    organizationId = duplicate.match.id;
    const keys = mergedIdentityKeys(duplicate.match.identity_keys, identityKeys({
      domain: record.domain, name: record.name, location: record.location, phone: record.phone,
    }));
    await run(env.DB,
      `UPDATE organizations SET identity_keys = ?, location = CASE WHEN location = '' THEN ? ELSE location END,
       country = CASE WHEN country = '' THEN ? ELSE country END, updated_at = ? WHERE id = ?`,
      JSON.stringify(keys), record.location || "", record.country || "", nowIso(), organizationId);
  } else {
    const count = await one(env.DB, "SELECT COUNT(*) AS n FROM generation_candidates WHERE run_id = ?", generationRun.id);
    if (Number(count?.n || 0) >= generationRun.candidate_cap) return;
    organizationId = makeId("o");
    const keys = identityKeys({ domain: record.domain, name: record.name, location: record.location, phone: record.phone });
    await run(env.DB,
      `INSERT INTO organizations (id, normalized_domain, normalized_name, display_name, location, country,
         provider, provider_id, identity_keys, merge_state, first_seen, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      organizationId, domain || null, normalizedName, record.name || domain, record.location || "",
      record.country || "", record.provider || provider.name, record.provider_id || "",
      JSON.stringify(keys), today(), nowIso(), nowIso());
  }
  const priorCandidate = await one(env.DB,
    `SELECT id FROM generation_candidates WHERE campaign_id = ? AND organization_id = ? LIMIT 1`,
    campaign.id, organizationId);
  if (priorCandidate) {
    await generationEvent(env, { runId: generationRun.id, provider: provider.name, stage: "discovery",
      eventType: "candidate-previously-processed", status: "skipped", detail: { organization_id: organizationId } });
    return;
  }
  const claim = record.evidence_claim
    || `${provider.name} returned ${record.name || domain} as a discovery candidate. Identity and fit still require first-party confirmation.`;
  const sourceUrl = record.source_url || `provider:${provider.name}`;
  const duplicateEvidence = await one(env.DB,
    `SELECT id FROM evidence_items WHERE organization_id = ? AND campaign_id = ? AND claim = ? AND source_url = ?`,
    organizationId, campaign.id, claim, sourceUrl);
  if (!duplicateEvidence) {
    await run(env.DB,
      `INSERT INTO evidence_items (id, organization_id, campaign_id, claim, source_url, observed_at,
         source_type, strength, reviewer_state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'provider', 'secondary', 'unreviewed', ?)`,
      makeId("e"), organizationId, campaign.id, claim, sourceUrl, record.observed_at || today(), nowIso());
  }
  await attachGenerationCandidate(env, generationRun, organizationId, provider.name);
}

async function attachGenerationCandidate(env, generationRun, organizationId, source) {
  const existing = await one(env.DB,
    "SELECT * FROM generation_candidates WHERE run_id = ? AND organization_id = ?", generationRun.id, organizationId);
  if (existing) {
    const sources = [...new Set([...parseJsonColumn(existing.discovery_sources, []), source])];
    await run(env.DB, "UPDATE generation_candidates SET discovery_sources = ?, updated_at = ? WHERE id = ?",
      JSON.stringify(sources), nowIso(), existing.id);
    return existing.id;
  }
  const id = makeId("gc");
  await run(env.DB,
    `INSERT INTO generation_candidates (id, run_id, campaign_id, organization_id, stage,
       discovery_sources, created_at, updated_at) VALUES (?, ?, ?, ?, 'discovered', ?, ?, ?)`,
    id, generationRun.id, generationRun.campaign_id, organizationId, JSON.stringify([source]), nowIso(), nowIso());
  await generationEvent(env, { runId: generationRun.id, candidateId: id, provider: source,
    stage: "discovered", eventType: "candidate-stage", status: "succeeded", detail: { organization_id: organizationId } });
  return id;
}

async function resolvePeopleAcrossProviders(env, generationRun, candidate, organization, providers) {
  for (const provider of providers) {
    if (provider.capabilities?.people_search !== true) continue;
    const estimate = provider.estimateCredits({ operation: "searchPeople" });
    if (!(await providerBudgetAllows(env, generationRun, estimate.estimated))) {
      await generationEvent(env, { runId: generationRun.id, candidateId: candidate.id, provider: provider.name,
        stage: "contact", eventType: "provider-call", status: "skipped", errorCode: "run-credit-budget",
        detail: { operation: "searchPeople" } });
      continue;
    }
    const started = Date.now();
    const result = await provider.searchPeople({ provider_id: organization.provider_id,
      domain: organization.normalized_domain }, {
      titles: ["Owner", "Founder", "CEO", "President", "Principal", "Managing Partner"],
      seniorities: ["owner", "founder", "c_suite", "partner"], perPage: 10,
    });
    await recordProviderCall(env, generationRun, candidate, provider, "contact", "searchPeople",
      estimate, result, Date.now() - started);
    if (result.error) continue;
    for (const person of result.records || []) await upsertPerson(env, organization, person);
  }
}

async function enrichPeopleForContact(env, generationRun, candidate, organization, people, providers) {
  for (const person of people.slice(0, 3)) {
    for (const provider of providers) {
      if (provider.capabilities?.person_enrichment !== true) continue;
      const estimate = provider.estimateCredits({ operation: "enrichPerson" });
      if (!(await providerBudgetAllows(env, generationRun, estimate.estimated))) continue;
      const started = Date.now();
      const result = await provider.enrichPerson({ provider_id: person.provider_id,
        full_name: person.full_name, title: person.title, domain: organization.normalized_domain,
        organization_name: organization.display_name });
      await recordProviderCall(env, generationRun, candidate, provider, "contact", "enrichPerson",
        estimate, result, Date.now() - started);
      if (!result.error && result.record) await upsertPerson(env, organization, result.record);
      if (!result.error) break;
    }
  }
}

async function upsertPerson(env, organization, person) {
  if (!isDecisionMaker(person)) return null;
  const duplicate = await one(env.DB,
    `SELECT * FROM people WHERE organization_id = ? AND (
       (? != '' AND lower(business_email) = lower(?)) OR
       (? != '' AND lower(public_profile_url) = lower(?)) OR
       (lower(full_name) = lower(?) AND lower(title) = lower(?))) LIMIT 1`,
    organization.id, person.business_email || "", person.business_email || "",
    person.public_profile_url || "", person.public_profile_url || "", person.full_name, person.title);
  if (duplicate) {
    await run(env.DB,
      `UPDATE people SET full_name = ?, title = ?, seniority = CASE WHEN ? != '' THEN ? ELSE seniority END,
       business_email = CASE WHEN ? != '' THEN ? ELSE business_email END,
       email_status = CASE WHEN ? != '' THEN ? ELSE email_status END,
       business_phone = CASE WHEN ? != '' THEN ? ELSE business_phone END,
       public_profile_url = CASE WHEN ? != '' THEN ? ELSE public_profile_url END,
       source_provider = CASE WHEN ? != '' THEN ? ELSE source_provider END,
       provider_id = CASE WHEN ? != '' THEN ? ELSE provider_id END, observed_at = ?, updated_at = ? WHERE id = ?`,
      person.full_name, person.title, person.seniority || "", person.seniority || "",
      person.business_email || "", person.business_email || "", person.email_status || "", person.email_status || "",
      person.business_phone || "", person.business_phone || "", person.public_profile_url || "", person.public_profile_url || "",
      person.provider || "", person.provider || "", person.provider_id || "", person.provider_id || "",
      person.observed_at || today(), nowIso(), duplicate.id);
    return duplicate.id;
  }
  const id = makeId("p");
  await run(env.DB,
    `INSERT INTO people (id, organization_id, full_name, title, seniority, business_email, email_status,
       business_phone, public_profile_url, source_provider, provider_id, observed_at, verification_state,
       created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unverified', ?, ?)`,
    id, organization.id, person.full_name, person.title, person.seniority || "",
    person.business_email || "", person.email_status || "unknown", person.business_phone || "",
    person.public_profile_url || "", person.provider || "", person.provider_id || "",
    person.observed_at || today(), nowIso(), nowIso());
  return id;
}

async function persistOfficialDecisionMakers(env, organization, people) {
  for (const person of people || []) {
    await upsertPerson(env, organization, { full_name: person.name, title: person.title,
      seniority: "executive", business_email: "", email_status: "unknown", business_phone: "",
      public_profile_url: person.public_profile_url || "", provider: "official-website",
      provider_id: `${person.source_url}#${person.name}`, observed_at: today() });
  }
}

async function ensureContactRoute(env, organization, person, route) {
  const existing = await one(env.DB,
    "SELECT * FROM contact_routes WHERE person_id = ? AND route_type = ? AND route_value = ?",
    person.id, route.route_type, route.route_value);
  if (existing) {
    if (Number(route.confidence) > Number(existing.confidence)) {
      await run(env.DB,
        `UPDATE contact_routes SET source_url = ?, verification_state = ?, confidence = ?, observed_at = ?, updated_at = ? WHERE id = ?`,
        route.source_url || existing.source_url, route.verification_state, route.confidence,
        route.observed_at || today(), nowIso(), existing.id);
      return one(env.DB, "SELECT * FROM contact_routes WHERE id = ?", existing.id);
    }
    return existing;
  }
  const id = makeId("route");
  await run(env.DB,
    `INSERT INTO contact_routes (id, organization_id, person_id, route_type, route_value, source_url,
       verification_state, confidence, observed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, organization.id, person.id, route.route_type, route.route_value, route.source_url || "",
    route.verification_state, route.confidence, route.observed_at || today(), nowIso(), nowIso());
  return one(env.DB, "SELECT * FROM contact_routes WHERE id = ?", id);
}

async function ensureEvidence(env, campaign, organization, proposal) {
  const existing = await one(env.DB,
    `SELECT * FROM evidence_items WHERE organization_id = ? AND campaign_id = ? AND claim = ? AND source_url = ? LIMIT 1`,
    organization.id, campaign.id, proposal.claim, proposal.source_url);
  if (existing) return existing;
  const id = makeId("e");
  const sourceType = ["first-party", "authoritative-directory", "secondary", "weak", "provider"]
    .includes(proposal.source_type) ? proposal.source_type : "first-party";
  const strength = ["first-party", "authoritative-directory", "secondary", "weak"]
    .includes(proposal.strength) ? proposal.strength : "first-party";
  await run(env.DB,
    `INSERT INTO evidence_items (id, organization_id, campaign_id, claim, source_url, observed_at,
       source_type, strength, contradiction_state, reviewer_state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'none', 'unreviewed', ?)`,
    id, organization.id, campaign.id, proposal.claim, proposal.source_url, today(),
    sourceType, strength, nowIso());
  return one(env.DB, "SELECT * FROM evidence_items WHERE id = ?", id);
}

async function ensureOpportunitySignal(env, generationRun, candidate, signal) {
  const existing = await one(env.DB,
    `SELECT * FROM opportunity_signals WHERE run_id = ? AND organization_id = ? AND signal_type = ? AND evidence_id = ?`,
    generationRun.id, candidate.organization_id, signal.type, signal.evidence_id);
  if (existing) return existing;
  const id = makeId("signal");
  await run(env.DB,
    `INSERT INTO opportunity_signals (id, run_id, campaign_id, organization_id, signal_type, claim,
       source_url, evidence_id, confidence, review_state, detected_at, dimension)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`,
    id, generationRun.id, candidate.campaign_id, candidate.organization_id, signal.type, signal.claim,
    signal.source_url, signal.evidence_id, Math.round(signal.confidence), nowIso(),
    signal.dimension || "copy-opportunity");
  return one(env.DB, "SELECT * FROM opportunity_signals WHERE id = ?", id);
}

async function buildMarketEvaluation(env, { campaign, organization, generationRun, marketFit,
  primarySignal, capacitySignals, service, person, contactRoute, evidence }) {
  const model = parseModelRow(await one(env.DB,
    "SELECT * FROM scoring_models WHERE active = 1 ORDER BY updated_at DESC LIMIT 1"));
  const query = parseJsonColumn(generationRun.query_snapshot, {});
  const allowed = parseJsonColumn(campaign.allowed_channels, []);
  const verifiedRoute = ["provider-verified", "first-party", "operator-verified"]
    .includes(contactRoute?.verification_state);
  const reviewableLinkedIn = contactRoute?.route_type === "linkedin"
    && contactRoute?.verification_state === "provider-reported"
    && Number(contactRoute?.confidence || 0) >= 65;
  const evidenceRows = evidence || [];
  const materialEvidence = evidenceRows.filter((item) =>
    ["first-party", "authoritative-directory"].includes(item.strength));
  const sourceHosts = new Set(materialEvidence.map((item) => {
    try { return new URL(item.source_url).hostname.replace(/^www\./, ""); } catch { return ""; }
  }).filter(Boolean));
  const opportunityFresh = evidenceIsRecent(primarySignal?.detected_at || today(), 60);
  const capacityFresh = (capacitySignals || []).some((signal) => evidenceIsRecent(signal.detected_at, 60));
  const thresholds = parseJsonColumn(campaign.score_thresholds, {});
  const marketDisqualifiers = (marketFit?.disqualifier_hits || []).map((rule) => ({
    rule, reason: "A cited company-profile indicator matches a campaign disqualifier.",
  }));
  return evaluateCandidate({
    model,
    thresholdOverrides: thresholds,
    disqualifiers: marketDisqualifiers,
    inputs: {
      icp_fit: {
        industry_match: marketFit?.supported ? 1 : 0,
        geography_match: String(organization.location || "").trim() ? 1 : undefined,
        business_model_match: marketFit?.supported ? 1 : 0,
        company_size_match: (query.employeeRanges || []).length
          ? (marketFit?.employee_range_supported ? 1 : 0) : 1,
        service_value_match: undefined,
        operating_capacity: capacitySignals?.length ? 1 : undefined,
      },
      copy_opportunity: {
        observable_signal: primarySignal ? 1 : 0,
        asset_specific: /^https?:\/\//i.test(primarySignal?.source_url || "") ? 1 : 0,
        service_mapped: service ? 1 : 0,
        signal_strength: Number(primarySignal?.confidence || 0) >= 75 ? 1 : 0,
      },
      buying_capacity: {
        trigger_present: capacitySignals?.length ? 1 : 0,
        capacity_indicator: capacitySignals?.length ? 1 : 0,
        trigger_recent: capacityFresh ? 1 : 0,
      },
      evidence_quality: {
        first_party: evidenceRows.some((item) => item.strength === "first-party") ? 1 : 0,
        source_cited: materialEvidence.length
          && materialEvidence.every((item) => /^https?:\/\//i.test(item.source_url) && item.observed_at) ? 1 : 0,
        corroborated: sourceHosts.size >= 2 ? 1 : 0,
        contradictions_handled: evidenceRows.some((item) => item.contradiction_state === "contradicted") ? 0 : 1,
      },
      evidence_recency: {
        opportunity_fresh: opportunityFresh ? 1 : 0,
        trigger_fresh: capacityFresh ? 1 : 0,
        verified_recently: evidenceRows.some((item) => evidenceIsRecent(item.observed_at, 60)) ? 1 : 0,
      },
      reachability: {
        role_appropriate: person && isDecisionMaker(person) ? 1 : 0,
        route_verified: verifiedRoute ? 1 : reviewableLinkedIn ? 0.5 : 0,
        channel_permitted: allowed.includes(routeChannel(contactRoute?.route_type)) ? 1 : 0,
      },
    },
  });
}

function evidenceIsRecent(value, days) {
  if (!value) return false;
  const time = new Date(String(value).length === 10 ? `${value}T00:00:00Z` : value).getTime();
  return Number.isFinite(time) && Date.now() - time <= days * 86_400_000;
}

async function persistWebsiteResearch(env, generationRun, organization, result) {
  if (result.status === "fetched") {
    for (const page of result.pages) {
      const a = page.analysis;
      await run(env.DB,
        `INSERT INTO website_research (id, run_id, organization_id, source_url, final_url, http_status,
           content_hash, page_title, meta_description, primary_heading, has_viewport, has_form,
           has_primary_cta, has_booking_path, has_phone_path, has_email_path, has_chat_path,
           copyright_year, status, error_code, inspected_at, has_contact_page)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fetched', '', ?, ?)`,
        makeId("web"), generationRun.id, organization.id, page.source_url, page.final_url,
        page.http_status, page.content_hash, a.title, a.meta_description, a.primary_heading,
        boolInt(a.has_viewport), boolInt(a.has_form), boolInt(a.has_primary_cta), boolInt(a.has_booking_path),
        boolInt(a.has_phone_path), boolInt(a.has_email_path), boolInt(a.has_chat_path),
        a.copyright_year || null, nowIso(), boolInt(a.has_contact_page));
    }
  } else {
    await run(env.DB,
      `INSERT INTO website_research (id, run_id, organization_id, source_url, final_url, status, error_code, inspected_at)
       VALUES (?, ?, ?, ?, '', ?, ?, ?)`,
      makeId("web"), generationRun.id, organization.id,
      organization.normalized_domain ? `https://${organization.normalized_domain}/` : "",
      result.status === "blocked" ? "blocked" : "failed", result.error || "unknown", nowIso());
  }
  await generationEvent(env, { runId: generationRun.id, stage: "website-research",
    eventType: "website-research", status: result.status === "fetched" ? "succeeded" : "failed",
    errorCode: result.error || "", retryable: Boolean(result.retryable),
    detail: { organization_id: organization.id, pages: result.pages?.length || 0 } });
}

async function recordProviderCall(env, generationRun, candidate, provider, stage, operation, estimate, result, latencyMs) {
  const failed = Boolean(result?.error);
  await run(env.DB,
    `INSERT INTO provider_usage (id, provider, operation, request_count, credits_estimated, campaign_id, occurred_at)
     VALUES (?, ?, ?, 1, ?, ?, ?)`,
    makeId("u"), provider.name, operation, Number(estimate?.estimated || 0), generationRun.campaign_id, nowIso());
  await generationEvent(env, { runId: generationRun.id, candidateId: candidate?.id, provider: provider.name,
    stage, eventType: "provider-call", status: failed ? "failed" : "succeeded",
    errorCode: result?.error || "", retryable: providerErrorRetryable(result?.error),
    credits: Number(estimate?.estimated || 0), detail: { operation, latency_ms: latencyMs,
      records: result?.records?.length || 0 } });
}

async function generationEvent(env, { runId, candidateId = null, provider = "", stage,
  eventType, status, errorCode = "", retryable = false, detail = {}, credits = 0 }) {
  await run(env.DB,
    `INSERT INTO generation_events (id, run_id, candidate_id, provider, stage, event_type, status,
       error_code, retryable, detail, credits_estimated, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    makeId("ge"), runId, candidateId, provider, stage, eventType, status, errorCode,
    retryable ? 1 : 0, JSON.stringify(detail || {}), credits, nowIso());
}

async function setCandidateStage(env, candidate, stage, changes = {}) {
  await run(env.DB,
    `UPDATE generation_candidates SET stage = ?, primary_person_id = COALESCE(?, primary_person_id),
       contact_route_id = COALESCE(?, contact_route_id), rejection_reason = ?, last_error = ?, updated_at = ? WHERE id = ?`,
    stage, changes.primaryPersonId || null, changes.contactRouteId || null,
    changes.rejectionReason || "", changes.lastError || "", nowIso(), candidate.id);
  candidate.stage = stage;
  await generationEvent(env, { runId: candidate.run_id, candidateId: candidate.id, stage,
    eventType: "candidate-stage", status: stage === "failed" ? "failed" : "succeeded",
    errorCode: changes.lastError || changes.rejectionReason || "", retryable: changes.retryable,
    detail: changes });
}

async function rejectCandidate(env, candidate, reason) {
  await setCandidateStage(env, candidate, "rejected", { rejectionReason: reason });
}

async function failCandidate(env, candidate, reason, retryable) {
  if (!retryable || Number(candidate.attempt_count || 0) >= 3) return rejectCandidate(env, candidate, reason);
  await setCandidateStage(env, candidate, "failed", { lastError: reason, retryable: true });
}

async function completeRun(env, generationRun, reason, partial = false) {
  const ready = await readyCount(env, generationRun.id);
  const status = partial && ready < generationRun.target_ready ? "partial" : "completed";
  await refreshRunCounts(env, generationRun.id);
  await run(env.DB,
    "UPDATE generation_runs SET status = ?, failure_code = ?, last_error = ?, completed_at = ?, updated_at = ? WHERE id = ?",
    status, status === "partial" ? reason : "", status === "partial"
      ? `Candidate pool exhausted with ${ready} of ${generationRun.target_ready} review-ready.` : "",
    nowIso(), nowIso(), generationRun.id);
  await generationEvent(env, { runId: generationRun.id, stage: "run", eventType: "run-complete",
    status: status === "partial" ? "failed" : "succeeded", errorCode: status === "partial" ? reason : "",
    detail: { ready, target: generationRun.target_ready, stop_reason: reason } });
}

async function generationRunPayload(env, id) {
  const generationRun = await loadRun(env, id);
  if (!generationRun) return null;
  await refreshRunCounts(env, id);
  const refreshed = decorateRun(await loadRun(env, id));
  const candidates = await all(env.DB,
    `SELECT gc.*, o.display_name AS organization_name, o.normalized_domain, o.location,
       p.full_name AS person_name, p.title AS person_title, cr.route_type, cr.route_value,
       cr.verification_state AS contact_verification_state, cr.confidence AS contact_confidence,
       cs.name AS service_name, os.signal_type, os.claim AS opportunity_claim,
       pp.status AS packet_status, pp.packet_hash
     FROM generation_candidates gc JOIN organizations o ON o.id = gc.organization_id
     LEFT JOIN people p ON p.id = gc.primary_person_id
     LEFT JOIN contact_routes cr ON cr.id = gc.contact_route_id
     LEFT JOIN client_services cs ON cs.id = gc.recommended_service_id
     LEFT JOIN opportunity_signals os ON os.id = gc.primary_signal_id
     LEFT JOIN prospect_packets pp ON pp.candidate_id = gc.id
     WHERE gc.run_id = ? ORDER BY
       CASE gc.stage WHEN 'message-ready' THEN 0 WHEN 'qualified' THEN 1 WHEN 'contact-found' THEN 2
         WHEN 'researching' THEN 3 WHEN 'discovered' THEN 4 WHEN 'failed' THEN 5 ELSE 6 END,
       gc.updated_at DESC`, id);
  const events = await all(env.DB,
    `SELECT candidate_id, provider, stage, event_type, status, error_code, retryable,
       detail, credits_estimated, occurred_at FROM generation_events WHERE run_id = ?
     ORDER BY occurred_at DESC, rowid DESC LIMIT 200`, id);
  return { run: refreshed, candidates: candidates.map(decorateCandidate),
    events: events.map((event) => ({ ...event, detail: parseJsonColumn(event.detail, {}) })) };
}

async function refreshRunCounts(env, runId) {
  const rows = await all(env.DB,
    "SELECT stage, COUNT(*) AS n FROM generation_candidates WHERE run_id = ? GROUP BY stage", runId);
  const counts = Object.fromEntries(rows.map((row) => [row.stage, Number(row.n)]));
  counts.total = rows.reduce((sum, row) => sum + Number(row.n), 0);
  counts.message_ready = Number(counts["message-ready"] || 0);
  counts.researched = counts.total - Number(counts.discovered || 0);
  counts.contactable = Number(counts["contact-found"] || 0) + Number(counts.qualified || 0) + counts.message_ready;
  counts.research_failures = Number(counts.failed || 0);
  const usage = await one(env.DB,
    `SELECT COALESCE(SUM(credits_estimated), 0) AS credits FROM generation_events
     WHERE run_id = ? AND event_type = 'provider-call' AND status IN ('succeeded','failed')`, runId);
  counts.provider_credits_estimated = Number(usage?.credits || 0);
  counts.candidate_to_ready_yield = counts.total ? counts.message_ready / counts.total : null;
  counts.contactability_rate = counts.researched ? counts.contactable / counts.researched : null;
  await run(env.DB, "UPDATE generation_runs SET counts = ?, updated_at = ? WHERE id = ?",
    JSON.stringify(counts), nowIso(), runId);
  return counts;
}

async function currentSourceFingerprint(env, campaignId, organizationId) {
  const [evidence, people] = await Promise.all([
    all(env.DB, "SELECT * FROM evidence_items WHERE campaign_id = ? AND organization_id = ?", campaignId, organizationId),
    all(env.DB, "SELECT * FROM people WHERE organization_id = ?", organizationId),
  ]);
  return dossierFingerprint(evidence, people);
}

async function readyCount(env, runId) {
  return Number((await one(env.DB,
    "SELECT COUNT(*) AS n FROM generation_candidates WHERE run_id = ? AND stage = 'message-ready'", runId))?.n || 0);
}

async function providerBudgetAllows(env, generationRun, estimate) {
  const used = Number((await one(env.DB,
    `SELECT COALESCE(SUM(credits_estimated), 0) AS n FROM generation_events
     WHERE run_id = ? AND event_type = 'provider-call' AND status IN ('succeeded','failed')`, generationRun.id))?.n || 0);
  if (used + Number(estimate || 0) > Number(generationRun.credit_budget)) return false;
  const ceiling = Number.parseInt(env.PROVIDER_CREDIT_CEILING || "0", 10);
  if (!ceiling) return true;
  const month = new Date().toISOString().slice(0, 7);
  const globalUsed = Number((await one(env.DB,
    "SELECT COALESCE(SUM(credits_estimated), 0) AS n FROM provider_usage WHERE occurred_at LIKE ?",
    `${month}%`))?.n || 0);
  return globalUsed + Number(estimate || 0) <= ceiling;
}

function selectProviders(available, requested) {
  if (!requested?.length) return available;
  const normalized = new Set(requested.map((name) => name === "tavily" ? "tavily-web" : name));
  return available.filter((provider) => normalized.has(provider.name));
}

function deriveKeywords(campaign) {
  const signals = parseJsonColumn(campaign.positive_signals, []);
  if (signals.length) return signals.slice(0, 12);
  const stop = new Set(["and", "the", "with", "for", "that", "from", "local", "business", "businesses",
    "company", "companies", "owner", "owned", "small", "ideal", "customer", "customers"]);
  return [...new Set(String(campaign.icp || "").toLowerCase().match(/[a-z][a-z-]{3,}/g) || [])]
    .filter((word) => !stop.has(word)).slice(0, 6);
}

function decorateRun(row) {
  return row ? { ...row, source_plan: parseJsonColumn(row.source_plan, []),
    query_snapshot: parseJsonColumn(row.query_snapshot, {}), counts: parseJsonColumn(row.counts, {}) } : null;
}

function decorateCandidate(row) {
  return { ...row, discovery_sources: parseJsonColumn(row.discovery_sources, []),
    fit_recommendation: parseJsonColumn(row.fit_recommendation, {}),
    evidence_recommendation: parseJsonColumn(row.evidence_recommendation, {}),
    audit_recommendation: parseJsonColumn(row.audit_recommendation, {}),
    market_evaluation: parseJsonColumn(row.market_evaluation, {}) };
}

function decorateFeedCampaign(row) {
  return { id: row.id, name: row.name, offer: row.offer, icp: row.icp,
    geography: row.geography, positive_signals: parseJsonColumn(row.positive_signals, []),
    buying_triggers: parseJsonColumn(row.buying_triggers, []),
    disqualifiers: parseJsonColumn(row.disqualifiers, []), status: row.status };
}

function validateFitInputs(inputs) {
  const required = ["offer_match", "timing_signal", "geography", "economics", "capacity_growth", "reachable"];
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(inputs || {}, key)) return `missing ${key}`;
    if (!Number.isFinite(Number(inputs[key])) || Number(inputs[key]) < 0 || Number(inputs[key]) > 1) return `${key} must be between 0 and 1`;
  }
  if (Object.keys(inputs || {}).some((key) => !required.includes(key))) return "unknown fit factor";
  return "";
}

function normalizeDisqualifiers(values) {
  return (values || []).filter((item) => item && typeof item.rule === "string" && typeof item.reason === "string")
    .map((item) => ({ rule: item.rule.slice(0, 200), reason: item.reason.slice(0, 500) }));
}

function providerErrorRetryable(value) {
  return ["rate-limited", "provider-timeout", "provider-network", "request-limit"].includes(value)
    || /^provider-5\d\d$/.test(String(value || ""));
}

function boolInt(value) { return value ? 1 : 0; }

function fixtureWebsiteDocuments(organization) {
  const root = `https://${organization.normalized_domain}/`;
  return { [root]: `<!doctype html><html><head><title>${escapeFixture(organization.display_name)}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
    <h1>${escapeFixture(organization.display_name)}</h1><p>Local professional services.</p>
    <form><label>Email <input name="email" type="email"></label></form>
    <a href="mailto:owner@${escapeFixture(organization.normalized_domain)}">Email our owner</a>
    <footer>Copyright 2021</footer></body></html>` };
}

function escapeFixture(value) {
  return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function loadRun(env, id) {
  return one(env.DB,
    `SELECT gr.*, ca.name AS campaign_name, cl.name AS client_name
     FROM generation_runs gr JOIN campaigns ca ON ca.id = gr.campaign_id JOIN clients cl ON cl.id = gr.client_id
     WHERE gr.id = ?`, id);
}

function campaignBriefComplete(campaign) {
  let channels = [];
  try { channels = JSON.parse(campaign?.allowed_channels || "[]"); } catch { channels = []; }
  return Boolean(campaign?.offer && campaign?.icp && campaign?.geography
    && campaign?.min_economics && Array.isArray(channels) && channels.length > 0);
}

export const generationRoutes = [
  ["GET", "/api/providers", ({ env }) => json(env, generationSourcesStatus(env))],
  ["GET", "/api/prospect-feed", prospectFeed],
  ["POST", "/api/generation-runs", createGenerationRun],
  ["GET", "/api/generation-runs", listGenerationRuns],
  ["GET", "/api/generation-runs/:id", getGenerationRun],
  ["POST", "/api/generation-runs/:id/advance", advanceGenerationRun],
  ["POST", "/api/generation-runs/:id/retry", retryGenerationRun],
  ["PATCH", "/api/generation-runs/:id", patchGenerationRun],
  ["GET", "/api/generation-runs/:rid/candidates/:cid/packet", getProspectPacket],
  ["POST", "/api/generation-runs/:rid/candidates/:cid/decision", decideProspectPacket],
];
