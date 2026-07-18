import { scoreFit, scoreEvidence, deriveEvidenceInputs, DEFAULT_THRESHOLDS } from "./scoring.js";
import { contentHash } from "./drafts.js";

export const GENERATION_VERSION = "generation-0.3";
export const SERVICE_MATCH_VERSION = "reemergence-services-0.3";
export const MESSAGE_OPTION_VERSION = "evidence-options-0.3";

const EXECUTIVE_TITLE = /\b(owner|co[- ]?founder|founder|chief executive(?: officer)?|ceo|president|principal|managing (?:partner|director|member)|general manager|partner)\b/i;
const NON_PRIMARY_EXECUTIVE = /\b(?:vice|assistant|associate|regional|division|branch)\s+president\b|\bvp\b/i;
const CONTACT_CONFIRMED = new Set(["provider-verified", "first-party", "operator-verified"]);
export const QUALIFYING_SIGNAL_TYPES = new Set([
  "missing-mobile-viewport", "missing-primary-cta", "missing-lead-capture", "manual-only-contact",
  "hiring-copy-content-roles",
]);

const MARKET_PATTERNS = Object.freeze({
  roofing: /\b(?:roof|roofing|roofer)\b/i,
  remodeling: /\b(?:remodel|remodeling|renovation|home improvement|general contractor)\b/i,
  landscaping: /\b(?:landscape|landscaping|lawn care|hardscape|outdoor living|tree service|arborist)\b/i,
  hvac: /\b(?:hvac|heating|air conditioning|cooling)\b/i,
  plumbing: /\b(?:plumber|plumbing)\b/i,
});
const GENERIC_MARKET_TERMS = new Set(["business", "businesses", "service", "services", "professional",
  "company", "companies", "owner", "owned", "small", "local", "home", "customer", "customers"]);

export function recommendService(signals, services, context = {}) {
  const active = (services || []).filter((service) => Number(service.active) === 1);
  const ranked = active.map((service) => {
    const types = jsonArray(service.signal_types);
    const matches = (signals || []).filter((signal) => types.includes(signal.type) && isQualifyingSignal(signal));
    const best = matches.sort((a, b) => Number(b.confidence) - Number(a.confidence))[0] || null;
    const contextBonus = best ? serviceContextBonus(service, best, context) : 0;
    return { service, best_signal: best, match_count: matches.length,
      score: best ? Number(best.confidence) + Math.min(10, matches.length * 2) + contextBonus : 0 };
  }).filter((item) => item.best_signal)
    .sort((a, b) => b.score - a.score || Number(a.service.priority) - Number(b.service.priority));
  if (!ranked.length) return null;
  const selected = ranked[0];
  return {
    service: selected.service,
    signal: selected.best_signal,
    confidence: Math.min(95, Math.round(selected.score)),
    rationale: `${selected.service.name} matches the observable ${selected.best_signal.type} signal${selected.best_signal.role_title ? ` (${selected.best_signal.role_title})` : ""}. The opening angle stays focused on that one constraint.`,
    version: SERVICE_MATCH_VERSION,
  };
}

export function isQualifyingSignal(signal) {
  return Boolean(signal && QUALIFYING_SIGNAL_TYPES.has(signal.type || signal.signal_type)
    && Number(signal.confidence) >= 75);
}

export function assessMarketFit({ campaign, organization, website, queryKeywords = [], employeeRanges = [] }) {
  const officialText = (website?.pages || []).flatMap((page) => [page.analysis?.title,
    page.analysis?.meta_description, page.analysis?.primary_heading]).filter(Boolean).join(" ");
  const providerText = [organization?.industry, organization?.description,
    ...jsonArray(organization?.profile_tags), organization?.company_type].filter(Boolean).join(" ");
  const profileText = `${officialText} ${providerText}`.replace(/\s+/g, " ").trim();
  const requested = [...new Set((queryKeywords.length ? queryKeywords : jsonArray(campaign?.positive_signals))
    .map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
  const matchedKeywords = [];
  for (const keyword of requested) {
    const pattern = MARKET_PATTERNS[keyword] || marketFallbackPattern(keyword);
    if (!pattern || !pattern.test(profileText)) continue;
    if (keyword === "plumbing" && /\b(?:mep|mechanical|plumbing)\s+(?:consulting|design|engineer(?:ing)?)\b/i.test(profileText)
      && !/\b(?:plumbing repair|plumbing contractor|residential plumbing|commercial plumbing services)\b/i.test(profileText)) continue;
    matchedKeywords.push(keyword);
  }
  const employeeRange = String(organization?.employee_range || "").trim();
  const employeeRangeSupported = employeeRanges.length > 0 && employeeRange
    ? employeeRanges.includes(employeeRange) : employeeRanges.length === 0 ? true : false;
  const disqualifierText = jsonArray(campaign?.disqualifiers).map((item) => String(item).toLowerCase());
  const disqualifierHits = [];
  if (disqualifierText.some((item) => item.includes("franchise")) && /\bfranchis(?:e|or|ing|es)\b/i.test(profileText)) {
    disqualifierHits.push("franchise-indicator");
  }
  const supported = matchedKeywords.length > 0 && employeeRangeSupported && disqualifierHits.length === 0;
  const reasons = [
    matchedKeywords.length ? `Official/provider company profile matches: ${matchedKeywords.join(", ")}.`
      : "No campaign market term is supported by the official/provider company profile.",
    employeeRanges.length === 0 ? "No employee-range constraint was requested."
      : employeeRangeSupported ? `Provider company profile reports ${employeeRange} employees.`
        : employeeRange ? `Provider company profile reports ${employeeRange}, outside the requested range.`
          : "The requested employee range is not supported by a company profile.",
    ...(disqualifierHits.length ? [`Hard-disqualifier indicators: ${disqualifierHits.join(", ")}.`] : []),
  ];
  return { supported, matched_keywords: matchedKeywords, requested_keywords: requested,
    employee_range: employeeRange, employee_range_supported: employeeRangeSupported,
    disqualifier_hits: disqualifierHits, profile_sources: {
      official_site: Boolean(officialText), provider_company_profile: Boolean(providerText),
    }, confidence: supported ? (officialText && providerText ? 90 : 80) : 0, reasons };
}

export function recommendScores({ campaign, organization, evidence, signals, contactRoute, marketFit }) {
  const allowed = jsonArray(campaign?.allowed_channels);
  const geographyKnown = Boolean(String(organization?.location || "").trim());
  const routeUsable = Boolean(contactRoute && routeChannel(contactRoute.route_type)
    && allowed.includes(routeChannel(contactRoute.route_type)));
  const fitInputs = {
    offer_match: marketFit?.supported ? 1 : 0,
    timing_signal: signals?.some(isQualifyingSignal) ? 1 : 0,
    geography: geographyKnown ? 1 : 0.5,
    economics: 0,
    capacity_growth: 0,
    reachable: routeUsable ? 1 : 0,
  };
  const fit = scoreFit(fitInputs, []);
  // This is a proposal only. Clone extracted first-party observations as if
  // accepted so the operator can see the score that confirmation would yield.
  // Actual fit_scores remain impossible until explicit confirmation.
  const proposedEvidence = (evidence || []).map((item) => ({ ...item, reviewer_state: "accepted" }));
  const contactVerified = Boolean(contactRoute && CONTACT_CONFIRMED.has(contactRoute.verification_state));
  const evidenceInputs = deriveEvidenceInputs(proposedEvidence, { contactVerified });
  const evidenceScore = scoreEvidence(evidenceInputs);
  return {
    fit: { ...fit, proposed_inputs: fitInputs },
    evidence: { ...evidenceScore, proposed_inputs: evidenceInputs },
    assumptions: [
      ...(geographyKnown ? [] : ["Geography is inferred from the campaign search and still needs source confirmation."]),
      ...(marketFit?.supported ? [] : ["The company profile does not yet support the campaign market and employee-range constraints."]),
      "Customer economics remain unknown until the operator confirms them.",
      "Capacity or growth intent remains unknown unless cited evidence is added.",
      ...(contactVerified ? [] : ["The contact route is not verified strongly enough to earn contact evidence points."]),
    ],
    proposed_pass: fit.total >= DEFAULT_THRESHOLDS.fit && evidenceScore.total >= DEFAULT_THRESHOLDS.evidence,
    thresholds: DEFAULT_THRESHOLDS,
  };
}

export function prepareAuditRecommendation({ organization, evidence, person, contactRoute, primarySignal, marketFit }) {
  const firstPartyIds = (evidence || []).filter((item) => item.strength === "first-party").map((item) => item.id);
  const signalIds = primarySignal?.evidence_id ? [primarySignal.evidence_id] : [];
  const checks = {
    identity_verified: recommendation(firstPartyIds.length > 0 && marketFit?.supported ? "supported" : "exception",
      firstPartyIds, firstPartyIds.length && marketFit?.supported
        ? "Official-site observations support company identity and the provider/official profile supports campaign market fit."
        : "Company identity or campaign market fit is not supported strongly enough."),
    offer_signal_verified: recommendation(signalIds.length ? "supported" : "exception", signalIds,
      signalIds.length ? "The proposed opportunity is tied to a cited first-party observation." : "No cited opportunity signal is available."),
    geography_verified: recommendation(String(organization?.location || "").trim() ? "needs-review" : "exception", [],
      String(organization?.location || "").trim()
        ? `The candidate location is recorded as ${organization.location}; confirm it against a source.`
        : "The provider returned no durable location evidence."),
    decision_maker_verified: recommendation(person && isDecisionMaker(person)
      && person.verification_state === "verified" && person.role_source_url ? "supported" : "exception", [],
      person?.role_source_url ? `${person.full_name} is shown as ${person.title} on an official company page; open the role source and confirm it.`
        : "No owner, founder, CEO, or appropriate executive was resolved."),
    contact_path_verified: recommendation(contactRoute && CONTACT_CONFIRMED.has(contactRoute.verification_state) ? "supported" : "exception", [],
      contactRoute ? `${contactRoute.route_type} is ${contactRoute.verification_state} at ${contactRoute.confidence}% confidence.`
        : "No exact professional contact route was resolved."),
    contradictions_checked: recommendation("needs-review", [],
      "Automation cannot certify that every material contradiction has been checked. The operator must review all cited sources."),
  };
  return { checks, complete_recommendation: Object.values(checks).every((item) => item.status === "supported"),
    note: "These are evidence-backed recommendations, never an audit approval." };
}

export function contactRoutesForPerson(person, officialContacts = []) {
  if (!person) return [];
  const routes = [];
  const add = (routeType, routeValue, sourceUrl, verificationState, confidence) => {
    if (!String(routeValue || "").trim()) return;
    routes.push({ route_type: routeType, route_value: String(routeValue).trim(), source_url: sourceUrl || "",
      verification_state: verificationState, confidence, observed_at: person.observed_at });
  };
  const provider = String(person.source_provider || person.provider || "");
  const emailStatus = String(person.email_status || "").toLowerCase();
  if (person.business_email) {
    const official = officialContacts.find((item) => item.type === "email"
      && String(item.value || "").toLowerCase() === String(person.business_email).toLowerCase());
    add("email", person.business_email, official?.source_url || (provider ? `provider:${provider}` : ""),
      official ? "first-party" : ["verified", "valid", "deliverable", "operator-verified"].includes(emailStatus)
        ? (emailStatus === "operator-verified" ? "operator-verified" : "provider-verified") : "provider-reported",
      official ? 96 : ["verified", "valid", "deliverable", "operator-verified"].includes(emailStatus) ? 90 : 60);
  }
  if (person.public_profile_url && /linkedin\.com\/in\//i.test(person.public_profile_url)) {
    const official = officialContacts.find((item) => item.type === "linkedin"
      && normalizeUrl(item.value) === normalizeUrl(person.public_profile_url));
    add("linkedin", person.public_profile_url, official?.source_url || (provider ? `provider:${provider}` : ""),
      official ? "first-party" : "provider-reported", official ? 88 : 68);
  }
  if (person.business_phone) {
    const official = officialContacts.find((item) => item.type === "phone"
      && digits(item.value) === digits(person.business_phone));
    add("phone", person.business_phone, official?.source_url || (provider ? `provider:${provider}` : ""),
      official ? "first-party" : "provider-reported", official ? 85 : 60);
  }
  return uniqueBy(routes, (route) => `${route.route_type}|${route.route_value.toLowerCase()}`)
    .sort((a, b) => b.confidence - a.confidence);
}

export function selectContactRoute(routes, allowedChannels) {
  const allowed = new Set(jsonArray(allowedChannels));
  return (routes || []).filter((route) => {
    const channel = routeChannel(route.route_type);
    const reviewableLinkedIn = route.route_type === "linkedin"
      && route.verification_state === "provider-reported" && Number(route.confidence) >= 65;
    return channel && allowed.has(channel)
      && (CONTACT_CONFIRMED.has(route.verification_state) || reviewableLinkedIn)
      && Number(route.confidence) >= (reviewableLinkedIn ? 65 : 75);
  }).sort((a, b) => b.confidence - a.confidence || contactPreference(a.route_type) - contactPreference(b.route_type))[0] || null;
}

export function routeChannel(routeType) {
  if (routeType === "linkedin") return "linkedin-manual";
  if (["email", "phone", "dm"].includes(routeType)) return routeType;
  return "";
}

export async function buildMessageOptions({ campaign, organization, person, signal, service, channel }) {
  if (!campaign || !organization || !person || !signal?.claim || !signal?.evidence_id || !service) return [];
  const first = String(person.full_name || "").trim().split(/\s+/)[0];
  const greeting = first ? `Hi ${first},` : `Hello ${organization.display_name} team,`;
  const observation = trimPeriod(signal.claim);
  const serviceName = String(service.name || "a focused growth-system improvement").trim();
  const serviceDescription = trimPeriod(service.description || serviceName);
  const signatures = signal.type === "hiring-copy-content-roles"
    ? hiringMessageOptions({ greeting, organization, signal, serviceName, serviceDescription })
    : [
    {
      strategy: "observation-led",
      body: [greeting, "", `I reviewed ${organization.display_name}'s website and documented one specific point: ${observation}.`,
        "", `My work in ${serviceName.toLowerCase()} starts with that kind of concrete constraint, not a broad everything-at-once pitch. Would a short, free fit conversation be useful?`,
        "", "Michael Taylor", "Reemergence Holdings"].join("\n"),
    },
    {
      strategy: "question-led",
      body: [greeting, "", `Quick question: is improving the path behind this observation already on your radar? ${observation}.`,
        "", `If it is, I can show you the first ${serviceName.toLowerCase()} change I would test. If it is not a priority, a quick “not now” is completely fine.`,
        "", "Michael Taylor", "Reemergence Holdings"].join("\n"),
    },
    {
      strategy: "diagnostic-led",
      body: [greeting, "", `I put together a source-backed observation from your public website: ${observation}.`,
        "", `If that observation matters operationally, the focused lane I would examine is ${serviceName.toLowerCase()}: ${lowerFirst(serviceDescription)}. I would be glad to walk through the evidence—no obligation and no assumed fit.`,
        "", "Michael Taylor", "Reemergence Holdings"].join("\n"),
    },
    ];
  const limited = channel === "linkedin-manual"
    ? signatures.map((option) => ({ ...option, body: option.body.slice(0, 1_500) })) : signatures;
  return Promise.all(limited.map(async (option) => ({
    ...option,
    evidence_ids: [signal.evidence_id],
    content_hash: await contentHash(option.body),
    version: MESSAGE_OPTION_VERSION,
  })));
}

function hiringMessageOptions({ greeting, organization, signal, serviceName, serviceDescription }) {
  const role = signal.role_title || hiringRoleFromClaim(signal.claim) || "copy/content role";
  const company = organization.display_name;
  const focusedHelp = lowerFirst(serviceDescription);
  return [
    {
      strategy: "capacity-bridge",
      body: [greeting, "", `I saw that ${company} is currently hiring a ${role}. That shows the work is active; it does not tell me whether outside support would be useful.`,
        "", `If the backlog is moving faster than the hiring timeline, I can take on one defined ${serviceName.toLowerCase()} brief without adding another permanent seat. Would it help if I sent a short outline for a first project?`,
        "", "Michael Taylor", "Reemergence Holdings"].join("\n"),
    },
    {
      strategy: "fit-question",
      body: [greeting, "", `Your current ${role} opening caught my attention. Is the team open to project-based copy support while that role is being filled, or is the need strictly in-house?`,
        "", `I work on ${focusedHelp}. If contract help is irrelevant, no problem—I would rather ask than assume.`,
        "", "Michael Taylor", "Reemergence Holdings"].join("\n"),
    },
    {
      strategy: "paid-trial",
      body: [greeting, "", `I found ${company}'s current ${role} posting and took it as a specific sign of copy workload—not as proof that you need an agency.`,
        "", `I provide ${serviceName.toLowerCase()} support on a focused project or retainer basis. If overflow is a real constraint, I can propose one small paid trial brief so you can judge the work and process before considering anything ongoing. Worth sending the outline?`,
        "", "Michael Taylor", "Reemergence Holdings"].join("\n"),
    },
  ];
}

function serviceContextBonus(service, signal, context) {
  if (signal.type !== "hiring-copy-content-roles") return 0;
  const role = String(signal.role_title || signal.claim || "").toLowerCase();
  const profile = [context.organization?.display_name, context.organization?.industry,
    context.organization?.description,
    ...(context.website?.pages || []).flatMap((page) => [page.analysis?.title,
      page.analysis?.meta_description, page.analysis?.primary_heading])]
    .filter(Boolean).join(" ").toLowerCase();
  const id = String(service.id || "");
  if (id.includes("agency-overflow") && /\b(?:agency|marketing firm|creative studio|public relations|\bpr\b|web design)\b/.test(profile)) return 70;
  if (id.includes("lifecycle-email") && /\b(?:lifecycle|email|retention|crm)\b/.test(role)) return 65;
  if (id.includes("founder-thought-leadership") && /\b(?:thought leadership|editorial|executive content)\b/.test(role)) return 55;
  if (id.includes("executive-ghostwriting") && /\b(?:executive|brand writer|speechwriter)\b/.test(role)) return 50;
  if (id.includes("content-campaign-copy") && /\b(?:copywriter|content writer|content strategist|content marketing)\b/.test(role)) return 45;
  return 0;
}

function hiringRoleFromClaim(value) {
  const match = String(value || "").match(/[“\"]([^”\"]+)[”\"]/);
  return match?.[1]?.trim() || "";
}

export function candidateConfidence({ serviceMatch, contactRoute, scoreRecommendation, auditRecommendation }) {
  const components = [
    Number(serviceMatch?.confidence || 0),
    Number(contactRoute?.confidence || 0),
    Number(scoreRecommendation?.fit?.total || 0),
    Number(scoreRecommendation?.evidence?.total || 0),
    Math.round(Object.values(auditRecommendation?.checks || {})
      .filter((item) => item.status === "supported").length / 6 * 100),
  ];
  return Math.round(components.reduce((sum, value) => sum + value, 0) / components.length);
}

export function decisionMakerRank(person) {
  const title = String(person?.title || "").toLowerCase();
  if (NON_PRIMARY_EXECUTIVE.test(title)) return 9;
  if (/\b(owner|founder|co-founder)\b/.test(title)) return 0;
  if (/\b(ceo|chief executive|president)\b/.test(title)) return 1;
  if (EXECUTIVE_TITLE.test(title)) return 2;
  return 9;
}

export function isDecisionMaker(person) {
  return Boolean(person?.full_name && EXECUTIVE_TITLE.test(person.title || "")
    && !NON_PRIMARY_EXECUTIVE.test(person.title || ""));
}

function recommendation(status, evidenceIds, note) {
  return { status, evidence_ids: evidenceIds, note };
}

function jsonArray(value) {
  if (Array.isArray(value)) return value;
  try { const parsed = JSON.parse(value || "[]"); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}

function trimPeriod(value) {
  return String(value || "").trim().replace(/[.\s]+$/, "");
}

function lowerFirst(value) {
  const text = String(value || "").trim();
  return text ? `${text[0].toLowerCase()}${text.slice(1)}` : text;
}

function marketFallbackPattern(keyword) {
  const tokens = String(keyword || "").toLowerCase().match(/[a-z][a-z-]{2,}/g) || [];
  const meaningful = tokens.filter((token) => !GENERIC_MARKET_TERMS.has(token));
  if (!meaningful.length) return null;
  return new RegExp(`\\b(?:${meaningful.map(escapeRegex).join("|")})\\b`, "i");
}

function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function normalizeUrl(value) {
  try { const url = new URL(value); url.hash = ""; return url.href.replace(/\/$/, "").toLowerCase(); }
  catch { return String(value || "").trim().toLowerCase(); }
}

function digits(value) { return String(value || "").replace(/\D/g, ""); }

function contactPreference(type) {
  return type === "linkedin" ? 0 : type === "email" ? 1 : type === "phone" ? 2 : 9;
}

function uniqueBy(items, key) {
  const seen = new Set();
  return (items || []).filter((item) => {
    const value = key(item);
    if (!value || seen.has(value)) return false;
    seen.add(value); return true;
  });
}
