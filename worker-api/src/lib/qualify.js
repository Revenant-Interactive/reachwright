/**
 * Reachwright Qualify — deterministic flow evaluation.
 *
 * A flow definition is operator-authored JSON:
 * {
 *   questions: [{ id, prompt, field, options: [{value, label}] }],
 *   rules: {
 *     disqualifiers: [{ when: {field, in:[...]}, reason }],
 *     humanReview:   [{ when: {field, in:[...]}, reason }],
 *     scoring:       [{ when: {field, in:[...]}, points }],
 *     strongAt: 6, maybeAt: 3
 *   },
 *   verdictCopy: { strong, maybe, no, "human-review" },
 *   fallbackCopy: { <questionId>: "...", verdict: "..." },
 *   route: { strong: "booking", maybe: "human", no: "none", "human-review": "human" }
 * }
 *
 * The verdict is ALWAYS computed here, server-side, from the closed answer
 * set. No model may choose or alter it.
 */

export function validateFlowDefinition(def) {
  const errors = [];
  if (!def || typeof def !== "object") return { ok: false, errors: ["definition must be an object"] };
  if (!Array.isArray(def.questions) || def.questions.length === 0) errors.push("questions[] required");
  const fields = new Set();
  for (const q of def.questions || []) {
    if (!q?.id || !q?.field || !q?.prompt) errors.push("each question needs id, field, prompt");
    if (fields.has(q?.field)) errors.push(`duplicate field: ${q?.field}`);
    fields.add(q?.field);
    if (!Array.isArray(q?.options) || q.options.length < 2) errors.push(`question ${q?.id} needs ≥2 options`);
    for (const opt of q?.options || []) {
      if (typeof opt?.value !== "string" || typeof opt?.label !== "string") {
        errors.push(`question ${q?.id} has a malformed option`);
      }
    }
  }
  if (!def.rules || typeof def.rules !== "object") errors.push("rules required");
  if (!Number.isFinite(def.rules?.strongAt) || !Number.isFinite(def.rules?.maybeAt)) {
    errors.push("rules.strongAt and rules.maybeAt must be numbers");
  }
  for (const list of ["disqualifiers", "humanReview", "scoring"]) {
    for (const rule of def.rules?.[list] || []) {
      if (!rule?.when?.field || !Array.isArray(rule?.when?.in)) errors.push(`${list} rule malformed`);
      if (rule?.when?.field && !fields.has(rule.when.field)) errors.push(`${list} rule references unknown field ${rule.when.field}`);
    }
  }
  if (!def.verdictCopy?.strong || !def.verdictCopy?.maybe || !def.verdictCopy?.no) {
    errors.push("verdictCopy.strong/maybe/no required");
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

/** Normalize submitted answers against the flow's closed schema. null = reject. */
export function normalizeFlowAnswers(def, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const byField = new Map(def.questions.map((q) => [q.field, q]));
  for (const key of Object.keys(input)) {
    if (!byField.has(key)) return null;
  }
  const answers = {};
  for (const q of def.questions) {
    const raw = input[q.field] ?? "unknown";
    if (raw === "unknown") { answers[q.field] = "unknown"; continue; }
    if (typeof raw !== "string" || !q.options.some((opt) => opt.value === raw)) return null;
    answers[q.field] = raw;
  }
  return answers;
}

function ruleMatches(rule, answers) {
  return rule.when.in.includes(answers[rule.when.field]);
}

/**
 * Deterministic evaluation. Returns
 * { next_question_id, verdict|null, factors:[...], route|null }
 */
export function evaluateFlow(def, answers) {
  for (const q of def.questions) {
    if (answers[q.field] === "unknown") {
      return { next_question_id: q.id, verdict: null, factors: [], route: null };
    }
  }
  const factors = [];
  for (const rule of def.rules.disqualifiers || []) {
    if (ruleMatches(rule, answers)) {
      factors.push({ kind: "disqualifier", reason: rule.reason });
      return { next_question_id: "verdict", verdict: "no", factors, route: def.route?.no ?? "none" };
    }
  }
  for (const rule of def.rules.humanReview || []) {
    if (ruleMatches(rule, answers)) {
      factors.push({ kind: "human-review", reason: rule.reason });
      return {
        next_question_id: "verdict",
        verdict: "human-review",
        factors,
        route: def.route?.["human-review"] ?? "human",
      };
    }
  }
  let score = 0;
  for (const rule of def.rules.scoring || []) {
    if (ruleMatches(rule, answers)) {
      score += rule.points;
      factors.push({ kind: "score", field: rule.when.field, points: rule.points });
    }
  }
  const verdict = score >= def.rules.strongAt ? "strong" : score >= def.rules.maybeAt ? "maybe" : "no";
  factors.push({ kind: "total", score });
  return { next_question_id: "verdict", verdict, factors, route: def.route?.[verdict] ?? "none" };
}

/** The built-in flow — mirrors the public worker's hardcoded interview. */
export const BUILTIN_FLOW = Object.freeze({
  questions: [
    { id: "q_business", field: "business", prompt: "What kind of business are you running?",
      options: [
        { value: "local", label: "Local service business" },
        { value: "b2b", label: "B2B / professional services" },
        { value: "ecom", label: "E-commerce" },
        { value: "other", label: "Something else" },
      ] },
    { id: "q_source", field: "leadSource", prompt: "Where are your inbound conversations coming from?",
      options: [
        { value: "ads", label: "Paid ads" },
        { value: "organic", label: "Organic / referrals" },
        { value: "outbound", label: "Outbound" },
        { value: "planning", label: "Still planning" },
      ] },
    { id: "q_value", field: "value", prompt: "Roughly what is a new customer worth in gross profit or first-year contribution?",
      options: [
        { value: "v0", label: "Under $500" },
        { value: "v1", label: "$500–$2K" },
        { value: "v2", label: "$2K–$10K" },
        { value: "v3", label: "$10K+" },
      ] },
    { id: "q_capacity", field: "capacity", prompt: "Could the business handle qualified conversations this month?",
      options: [
        { value: "now", label: "Yes" },
        { value: "soon", label: "In a few weeks" },
        { value: "explore", label: "Just exploring" },
      ] },
  ],
  rules: {
    disqualifiers: [
      { when: { field: "value", in: ["v0"] }, reason: "customer economics below service floor" },
      { when: { field: "capacity", in: ["explore"] }, reason: "not ready to take conversations" },
    ],
    humanReview: [],
    scoring: [
      { when: { field: "leadSource", in: ["ads"] }, points: 3 },
      { when: { field: "leadSource", in: ["organic", "outbound"] }, points: 2 },
      { when: { field: "value", in: ["v2", "v3"] }, points: 2 },
      { when: { field: "value", in: ["v1"] }, points: 1 },
      { when: { field: "capacity", in: ["now"] }, points: 2 },
      { when: { field: "capacity", in: ["soon"] }, points: 1 },
      { when: { field: "business", in: ["local", "b2b", "other"] }, points: 1 },
    ],
    strongAt: 6,
    maybeAt: 3,
  },
  verdictCopy: {
    strong: "This looks suitable for a controlled pilot using your approved rules.",
    maybe: "There may be a fit, but one operating constraint should be resolved before automation.",
    no: "This is not ready for automation under the current economics or capacity.",
    "human-review": "A human should review this conversation before any next step.",
  },
  route: { strong: "booking", maybe: "human", no: "none", "human-review": "human" },
});
