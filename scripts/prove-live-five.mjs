/**
 * Private, no-send acceptance harness for capability 20.
 *
 * It creates a fresh campaign through a running local API, performs a real
 * Hunter + official-site Generate 5 run, and writes ignored review artifacts.
 * It never approves a packet, creates a draft, exports, or records a send.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function args() {
  const values = Object.fromEntries(process.argv.slice(2).map((part) => {
    const [key, ...rest] = part.replace(/^--/, "").split("=");
    return [key, rest.join("=") || "true"];
  }));
  return {
    mode: values.mode || "direct",
    base: values.base || "http://localhost:8788",
    target: Number(values.target || 5),
    candidateCap: Number(values["candidate-cap"] || 25),
    creditBudget: Number(values["credit-budget"] || 15),
    location: values.location || "United States",
    keywords: String(values.keywords || "roofing,remodeling,landscaping,hvac,plumbing")
      .split(",").map((value) => value.trim()).filter(Boolean),
  };
}

function parseEnv(text) {
  const result = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    result[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return result;
}

function maskContact(route) {
  if (!route) return null;
  if (route.type === "email") return `***@${String(route.value).split("@").at(-1) || "unknown"}`;
  if (route.type === "phone") return "***";
  return route.value ? "[professional route retained only in private raw artifact]" : "";
}

async function main() {
  const options = args();
  if (options.target !== 5) throw new Error("The live-five proof requires --target=5.");
  if (options.candidateCap < 5 || options.candidateCap > 50) throw new Error("candidate-cap must be 5–50.");
  const localEnv = parseEnv(await readFile(resolve("worker-api/.dev.vars"), "utf8"));
  if (!localEnv.OPERATOR_TOKEN || localEnv.OPERATOR_TOKEN.length < 16) throw new Error("A valid OPERATOR_TOKEN is required in worker-api/.dev.vars.");
  if (!localEnv.HUNTER_API_KEY) throw new Error("HUNTER_API_KEY is required for this live proof.");
  const headers = { authorization: `Bearer ${localEnv.OPERATOR_TOKEN}`, "content-type": "application/json" };
  let directState = null;
  if (options.mode === "direct") {
    const [{ createFakeD1 }, { handleRequest }] = await Promise.all([
      import("../tests/helpers/fake-d1.mjs"), import("../worker-api/src/index.js"),
    ]);
    directState = {
      DB: createFakeD1(), OPERATOR_TOKEN: localEnv.OPERATOR_TOKEN,
      HUNTER_API_KEY: localEnv.HUNTER_API_KEY,
      ...(localEnv.TAVILY_API_KEY ? { TAVILY_API_KEY: localEnv.TAVILY_API_KEY } : {}),
      PROSPECT_PROVIDER: "hunter", DEV_FIXTURES: "false", EMAIL_GATE_PASSED: "false",
      APP_ORIGIN: "http://localhost:8123", BODY_MAX_BYTES: "65536",
      PROVIDER_TIMEOUT_MS: "15000", PROVIDER_CREDIT_CEILING: String(options.creditBudget),
      WEBSITE_RESEARCH_TIMEOUT_MS: "12000", WEBSITE_RESEARCH_MAX_PAGES: "4",
      WEBSITE_RESEARCH_MAX_BYTES: "300000",
    };
    directState.handleRequest = handleRequest;
  } else if (options.mode !== "http") {
    throw new Error("--mode must be direct or http.");
  }
  const call = async (method, path, body) => {
    const request = new Request(`${options.mode === "direct" ? "https://proof.local" : options.base}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const response = options.mode === "direct"
      ? await directState.handleRequest(request, directState)
      : await fetch(request);
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${payload?.error || "unknown"}`);
    return payload;
  };

  const health = await call("GET", "/api/health");
  const sourceRows = health.generation_sources?.providers || [];
  if (!sourceRows.some((row) => row.provider === "hunter")) throw new Error("The running API does not have Hunter configured.");
  if (sourceRows.some((row) => row.provider === "local-fixtures")) throw new Error("Fixture provider contamination detected.");
  if (health.email_gate_passed) throw new Error("EMAIL_GATE_PASSED must remain false during the proof.");

  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const campaignPayload = {
    name: `Capability 20 live proof — ${stamp}`, owner: "Michael Taylor",
    offer: "Reemergence Holdings identifies and fixes observable website conversion, messaging, lead-capture, and growth-system constraints.",
    icp: "Owner-led home-service businesses with 1–50 employees in the United States.",
    geography: options.location, positive_signals: options.keywords,
    disqualifiers: ["franchise headquarters", "inactive business", "no current owner-level decision maker"],
    min_economics: "Operator must confirm sufficient service economics before outreach.",
    allowed_channels: ["email", "linkedin-manual"], max_batch_size: options.candidateCap,
    voice_notes: "Specific, evidence-led, concise; no assumed harm or guaranteed result.",
    success_metric: "Five manually verified decision-maker-level, message-ready prospect packets.",
    client_id: "rw-client-reemergence", client_offer_id: "rw-client-offer-growth-systems",
  };
  const campaign = (await call("POST", "/api/campaigns", campaignPayload)).campaign;
  let result = await call("POST", "/api/generation-runs", {
    campaign_id: campaign.id, target_ready: 5, candidate_cap: options.candidateCap,
    credit_budget: options.creditBudget, sources: ["hunter"], keywords: options.keywords,
    locations: [options.location], employee_ranges: ["1-10", "11-50"],
    start_immediately: true, initial_batch: 1,
  });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (["completed", "partial", "failed", "canceled"].includes(result.run.status)) break;
    result = await call("POST", `/api/generation-runs/${result.run.id}/advance`, { batch: 1 });
  }

  const ready = result.candidates.filter((candidate) => candidate.stage === "message-ready");
  const packets = [];
  for (const candidate of ready) {
    packets.push(await call("GET", `/api/generation-runs/${result.run.id}/candidates/${candidate.id}/packet`));
  }
  const report = await call("GET", `/api/reports/campaigns/${campaign.id}`);
  const failures = [];
  const serialized = JSON.stringify({ result, packets });
  const domains = ready.map((candidate) => String(candidate.normalized_domain || "").toLowerCase());
  if (result.run.status !== "completed") failures.push(`run status is ${result.run.status}, not completed`);
  if (ready.length !== 5) failures.push(`expected 5 message-ready candidates; received ${ready.length}`);
  if (JSON.stringify(result.run.source_plan) !== JSON.stringify(["hunter"])) failures.push("source plan was not exactly Hunter");
  if (/local-fixtures|\[fixture\]|provider:local-fixtures/i.test(serialized)) failures.push("fixture marker detected");
  if (result.candidates.some((candidate) => (candidate.discovery_sources || []).some((source) => ["local-fixtures", "manual-or-existing"].includes(source)))) failures.push("fixture or pre-existing candidate entered the isolated run");
  if (domains.some((domain) => !domain || /\.(example|test|invalid)$/.test(domain))) failures.push("invalid/test candidate domain detected");
  if (new Set(domains).size !== domains.length) failures.push("duplicate candidate domain detected");
  if (!result.events.some((event) => event.provider === "hunter" && event.stage === "discovery"
    && event.event_type === "provider-call" && event.status === "succeeded" && Number(event.detail?.records || 0) > 0)) failures.push("no successful Hunter discovery event with records");
  if (Number(result.run.counts.provider_credits_estimated || 0) > options.creditBudget) failures.push("estimated credits exceeded the run budget");
  if (report.generation_performance.messages_selected !== 0 || report.generation_performance.messages_sent !== 0) failures.push("a draft or send was recorded during the no-send proof");
  for (const [index, item] of packets.entries()) {
    const packet = item.packet;
    if (item.status !== "operator-review" || item.stale) failures.push(`packet ${index + 1} is not a fresh operator-review packet`);
    if (!packet?.company?.official_website || !packet?.decision_maker?.name || !packet?.decision_maker?.title) failures.push(`packet ${index + 1} lacks company or executive identity`);
    if (!packet?.contact_route?.value || !["provider-verified", "first-party", "operator-verified"].includes(packet?.contact_route?.verification_state)
      || Number(packet?.contact_route?.confidence || 0) < 75) failures.push(`packet ${index + 1} lacks a sufficiently verified exact route`);
    if (!(packet?.cited_facts || []).some((fact) => /^https?:\/\//.test(fact.source_url))) failures.push(`packet ${index + 1} lacks an HTTP(S) citation`);
    if (!packet?.opportunity?.evidence_id || !packet?.recommended_service?.id || !packet?.qualification?.rationale) failures.push(`packet ${index + 1} lacks opportunity, service, or rationale`);
    if (packet?.message_options?.length !== 3 || packet.message_options.some((message) => !(message.evidence_ids || []).length)) failures.push(`packet ${index + 1} lacks three evidence-bound alternatives`);
  }

  const checks = ["company_identity", "market_and_size_fit", "current_executive_role", "exact_contact_route",
    "email_vs_role_verification", "citations_visible", "absence_claim_page_scope", "opportunity_is_observable",
    "one_service_only", "service_matches_signal", "message_claim_traceability", "no_invented_roi_urgency_or_relationship"];
  const manualReview = {
    state: "MANUAL REVIEW REQUIRED", run_id: result.run.id, campaign_id: campaign.id,
    instructions: "Record pass/fail and a specific note for every check. A completed run is not proof.",
    prospects: packets.map((item, index) => ({ candidate_id: ready[index]?.id || "", company: item.packet.company.name,
      checks: Object.fromEntries(checks.map((check) => [check, { result: null, note: "" }])), final_result: null })),
  };
  const masked = {
    state: failures.length ? "AUTOMATED GATE FAILED" : "AUTOMATED GATE PASSED — MANUAL REVIEW PENDING",
    run_id: result.run.id, campaign_id: campaign.id, run_status: result.run.status,
    counts: result.run.counts, failures,
    prospects: packets.map((item) => ({ company: item.packet.company.name, domain: item.packet.company.domain,
      decision_maker: { name: item.packet.decision_maker.name, title: item.packet.decision_maker.title },
      contact_route: { type: item.packet.contact_route.type, value: maskContact(item.packet.contact_route),
        verification_state: item.packet.contact_route.verification_state, confidence: item.packet.contact_route.confidence },
      opportunity: item.packet.opportunity, recommended_service: item.packet.recommended_service.name,
      messages_prepared: item.packet.message_options.length })),
  };
  const artifactDir = resolve(`.wrangler/proof-five/${stamp}`);
  await mkdir(artifactDir, { recursive: true });
  await Promise.all([
    writeFile(resolve(artifactDir, "raw-run.json"), JSON.stringify({ health, campaign, ...result, packets, report }, null, 2)),
    writeFile(resolve(artifactDir, "manual-review.json"), JSON.stringify(manualReview, null, 2)),
    writeFile(resolve(artifactDir, "masked-summary.json"), JSON.stringify(masked, null, 2)),
  ]);
  console.log(masked.state);
  console.log(`Ready: ${ready.length}/5 · Candidates: ${result.run.counts.total || 0} · Est. credits: ${result.run.counts.provider_credits_estimated || 0}`);
  console.log(`Private review artifacts: ${artifactDir}`);
  if (failures.length) {
    for (const failure of failures) console.log(`- ${failure}`);
    process.exitCode = 1;
  }
}

main().catch((cause) => {
  console.error(`LIVE FIVE PROOF STOPPED: ${cause.message}`);
  process.exitCode = 1;
});
