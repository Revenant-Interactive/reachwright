/**
 * Reachwright deterministic scoring — implements the rubric from
 * prospect-playbook.md v0.1 verbatim. Fit and evidence are separate
 * numbers and are never blended. Every score is explainable: the
 * output lists each factor's weight, input, and awarded points.
 */

export const RULE_VERSION = "playbook-0.1";

export const FIT_FACTORS = Object.freeze([
  { factor: "offer_match",      weight: 30, label: "offer and business-model match" },
  { factor: "timing_signal",    weight: 20, label: "visible need or timing signal" },
  { factor: "geography",        weight: 15, label: "geography and serviceability" },
  { factor: "economics",        weight: 15, label: "plausible customer economics" },
  { factor: "capacity_growth",  weight: 10, label: "operational capacity or growth intent" },
  { factor: "reachable",        weight: 10, label: "reachable through an allowed channel" },
]);

export const EVIDENCE_FACTORS = Object.freeze([
  { factor: "identity_first_party",   weight: 40, label: "identity and material claims verified first-party" },
  { factor: "timing_current",         weight: 20, label: "timing signal is current and dated" },
  { factor: "contact_verified",       weight: 15, label: "contact path is verified" },
  { factor: "contradictions_handled", weight: 15, label: "material contradictions resolved or surfaced" },
  { factor: "freshness_window",       weight: 10, label: "verified within the campaign freshness window" },
]);

export const DEFAULT_THRESHOLDS = Object.freeze({ fit: 65, evidence: 70 });

function clamp01(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.min(1, Math.max(0, num));
}

/**
 * Score against a factor table.
 * @param inputs  object of factor → 0..1 (booleans accepted)
 * @param disqualifiers array of {rule, reason} — any entry zeroes the score
 * @returns {total, rule_version, factors:[{factor,weight,input,points,label}], disqualifiers}
 */
function scoreAgainst(table, inputs, disqualifiers) {
  const dq = Array.isArray(disqualifiers)
    ? disqualifiers.filter((d) => d && typeof d.rule === "string" && typeof d.reason === "string")
    : [];
  const factors = table.map(({ factor, weight, label }) => {
    const input = clamp01(inputs?.[factor] === true ? 1 : inputs?.[factor] === false ? 0 : inputs?.[factor]);
    return { factor, weight, input, points: Math.round(weight * input), label };
  });
  const raw = factors.reduce((sum, f) => sum + f.points, 0);
  return {
    total: dq.length > 0 ? 0 : Math.min(100, raw),
    rule_version: RULE_VERSION,
    factors,
    disqualifiers: dq,
  };
}

export function scoreFit(inputs, disqualifiers = []) {
  return scoreAgainst(FIT_FACTORS, inputs, disqualifiers);
}

export function scoreEvidence(inputs, disqualifiers = []) {
  // Evidence disqualifiers are rare; a fabricated-claim finding is one.
  return scoreAgainst(EVIDENCE_FACTORS, inputs, disqualifiers);
}

/**
 * Derive evidence-score inputs from stored evidence items, deterministically.
 * @param items evidence rows {source_type, strength, observed_at, contradiction_state, reviewer_state}
 * @param opts  {freshnessDays=60, today="YYYY-MM-DD", contactVerified=false}
 */
export function deriveEvidenceInputs(items, opts = {}) {
  const rows = Array.isArray(items) ? items.filter((i) => i && i.reviewer_state !== "rejected") : [];
  const freshnessDays = Number.isFinite(opts.freshnessDays) ? opts.freshnessDays : 60;
  const today = opts.today ? new Date(`${opts.today}T00:00:00Z`) : new Date();

  const firstParty = rows.filter((i) => i.strength === "first-party");
  const accepted = rows.filter((i) => i.reviewer_state === "accepted");
  const contradicted = rows.filter((i) => i.contradiction_state === "contradicted");

  const ageDays = (item) => {
    const observed = new Date(`${item.observed_at}T00:00:00Z`);
    return Number.isFinite(observed.getTime()) ? (today - observed) / 86_400_000 : Infinity;
  };
  const anyFresh = rows.some((i) => ageDays(i) <= freshnessDays);
  const timingCurrent = rows.some((i) => i.strength !== "weak" && ageDays(i) <= freshnessDays);

  return {
    identity_first_party: firstParty.length >= 2 ? 1 : firstParty.length === 1 ? 0.5 : 0,
    timing_current: timingCurrent ? 1 : 0,
    contact_verified: opts.contactVerified ? 1 : 0,
    contradictions_handled: contradicted.length === 0 ? 1 : 0,
    freshness_window: anyFresh && accepted.length > 0 ? 1 : anyFresh ? 0.5 : 0,
  };
}

/** Queue admission per playbook: fit ≥ 65 AND evidence ≥ 70 (or overrides). */
export function passesQueueThreshold(fitScore, evidenceScore, thresholds = DEFAULT_THRESHOLDS) {
  const effective = (s) => (Number.isInteger(s?.override_total) ? s.override_total : s?.total ?? 0);
  return effective(fitScore) >= thresholds.fit && effective(evidenceScore) >= thresholds.evidence;
}
