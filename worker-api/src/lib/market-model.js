/**
 * Copywriting market model — deterministic multi-dimension qualification.
 *
 * Six separate dimension scores (ICP fit, copy opportunity, buying
 * trigger/capacity, evidence quality, evidence recency, reachability) plus an
 * overall priority. Nothing here is an AI judgment: inputs are 0..1 facts the
 * operator or pipeline supplies, weights and thresholds come from the active
 * scoring model row, and a missing input scores zero and is reported as
 * unknown — never estimated.
 *
 * Hard gates encode the non-compensation rules: high ICP fit cannot rescue a
 * missing copy opportunity, a strong opportunity cannot rescue absent buying
 * capacity, neither rescues weak/stale evidence or an unusable contact route,
 * and any recorded disqualifier fails the candidate outright.
 */

export const MARKET_MODEL_VERSION = "copywriting-1.0";

export const DIMENSION_KEYS = Object.freeze([
  "icp_fit", "copy_opportunity", "buying_capacity",
  "evidence_quality", "evidence_recency", "reachability",
]);

const GATE_DIMENSIONS = Object.freeze({
  "copy-opportunity-required": ["copy_opportunity"],
  "buying-capacity-required": ["buying_capacity"],
  "evidence-required": ["evidence_quality", "evidence_recency"],
  "reachability-required": ["reachability"],
});

function clamp01(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.min(1, Math.max(0, num));
}

export function parseModelRow(row) {
  if (!row) return null;
  const parse = (text, fallback) => {
    try {
      const value = JSON.parse(text);
      return value && typeof value === "object" ? value : fallback;
    } catch { return fallback; }
  };
  return {
    id: row.id,
    version: row.version,
    label: row.label,
    dimensions: parse(row.dimensions, {}),
    thresholds: parse(row.thresholds, {}),
    priority_weights: parse(row.priority_weights, {}),
    hard_gates: parse(row.hard_gates, []),
    active: Number(row.active) === 1,
    notes: row.notes || "",
    updated_at: row.updated_at,
  };
}

/**
 * Score one dimension.
 * @param dimension {label, factors:[{factor,weight,label}]}
 * @param inputs    object factor → 0..1 | boolean | null/undefined (= unknown)
 * @returns {total, factors:[{factor,weight,label,input,points,known}], missing:[factor], max}
 */
export function scoreDimension(dimension, inputs = {}) {
  const factors = (dimension?.factors || []).map(({ factor, weight, label }) => {
    const raw = inputs?.[factor];
    const known = raw !== undefined && raw !== null && raw !== "";
    const input = known ? clamp01(raw === true ? 1 : raw === false ? 0 : raw) : 0;
    return { factor, weight: Number(weight) || 0, label, input, known,
      points: Math.round((Number(weight) || 0) * input) };
  });
  return {
    total: Math.min(100, factors.reduce((sum, f) => sum + f.points, 0)),
    max: factors.reduce((sum, f) => sum + f.weight, 0),
    factors,
    missing: factors.filter((f) => !f.known).map((f) => f.factor),
  };
}

/**
 * Deterministically evaluate a candidate against the model.
 *
 * @param model  parsed scoring model (parseModelRow output)
 * @param inputs { icp_fit: {...}, copy_opportunity: {...}, ... } per-factor 0..1 facts
 * @param disqualifiers array of {rule, reason} — any entry fails the candidate
 * @param thresholdOverrides optional campaign-level {dimension: minScore}
 * @returns {
 *   qualified, dimensions:{key:{total,factors,missing,threshold,passed}},
 *   overall_priority, priority_components, gates:[{gate,passed,reason,dimensions}],
 *   disqualifiers, missing, rule_version
 * }
 */
export function evaluateCandidate({ model, inputs = {}, disqualifiers = [], thresholdOverrides = {} } = {}) {
  if (!model || !model.dimensions) {
    return { qualified: false, error: "scoring-model-missing", dimensions: {}, gates: [], disqualifiers: [], missing: [] };
  }
  const dq = (Array.isArray(disqualifiers) ? disqualifiers : [])
    .filter((d) => d && typeof d.rule === "string" && typeof d.reason === "string");

  const dimensions = {};
  const missing = [];
  for (const key of DIMENSION_KEYS) {
    const scored = scoreDimension(model.dimensions[key], inputs[key]);
    const threshold = Number.isFinite(Number(thresholdOverrides[key]))
      ? Number(thresholdOverrides[key])
      : Number(model.thresholds?.[key] ?? 0);
    dimensions[key] = { ...scored, threshold, passed: scored.total >= threshold,
      label: model.dimensions[key]?.label || key };
    for (const factor of scored.missing) missing.push(`${key}.${factor}`);
  }

  const gates = (model.hard_gates || []).map(({ gate, reason }) => {
    if (gate === "no-disqualifiers") {
      return { gate, reason, passed: dq.length === 0,
        detail: dq.length ? dq.map((d) => d.rule).join(", ") : "" };
    }
    if (gate === "no-guessing") {
      // Structural rule: unknown inputs already scored zero above. Always
      // reported as passed so the packet shows the rule is in force.
      return { gate, reason, passed: true, detail: missing.length ? `${missing.length} unknown input(s) scored zero` : "" };
    }
    const keys = GATE_DIMENSIONS[gate] || [];
    const failed = keys.filter((key) => !dimensions[key]?.passed);
    return { gate, reason, passed: failed.length === 0,
      detail: failed.length ? `below threshold: ${failed.join(", ")}` : "", dimensions: keys };
  });

  const priorityWeights = model.priority_weights || {};
  const weightTotal = DIMENSION_KEYS.reduce((sum, key) => sum + (Number(priorityWeights[key]) || 0), 0) || 1;
  const priorityComponents = DIMENSION_KEYS.map((key) => ({
    dimension: key,
    weight: Number(priorityWeights[key]) || 0,
    score: dimensions[key].total,
    contribution: Math.round(((Number(priorityWeights[key]) || 0) * dimensions[key].total) / weightTotal * 100) / 100,
  }));
  const overallPriority = Math.round(priorityComponents.reduce((sum, c) => sum + c.contribution, 0));

  const priorityThreshold = Number.isFinite(Number(thresholdOverrides.overall_priority))
    ? Number(thresholdOverrides.overall_priority)
    : Number(model.thresholds?.overall_priority ?? 0);

  const qualified = gates.every((g) => g.passed)
    && DIMENSION_KEYS.every((key) => dimensions[key].passed)
    && overallPriority >= priorityThreshold;

  return {
    qualified,
    dimensions,
    overall_priority: overallPriority,
    priority_threshold: priorityThreshold,
    priority_components: priorityComponents,
    gates,
    disqualifiers: dq,
    missing,
    rule_version: model.version || MARKET_MODEL_VERSION,
  };
}

/** Validate an edited scoring-model payload before persisting. */
export function validateModelEdit({ dimensions, thresholds, priority_weights }, existing) {
  const errors = [];
  if (dimensions !== undefined) {
    if (!dimensions || typeof dimensions !== "object") errors.push("dimensions must be an object");
    else {
      for (const key of DIMENSION_KEYS) {
        const dim = dimensions[key];
        const base = existing?.dimensions?.[key];
        if (!dim || !Array.isArray(dim.factors)) { errors.push(`${key}: factors array required`); continue; }
        const baseFactors = (base?.factors || []).map((f) => f.factor).sort().join(",");
        const editFactors = dim.factors.map((f) => f?.factor).sort().join(",");
        if (baseFactors && baseFactors !== editFactors) {
          errors.push(`${key}: factor set cannot change (weights and labels are editable)`);
          continue;
        }
        const sum = dim.factors.reduce((total, f) => total + (Number(f?.weight) || 0), 0);
        if (sum !== 100) errors.push(`${key}: factor weights must sum to 100 (got ${sum})`);
        for (const f of dim.factors) {
          if (!Number.isInteger(Number(f?.weight)) || Number(f.weight) < 0 || Number(f.weight) > 100) {
            errors.push(`${key}.${f?.factor}: weight must be an integer 0–100`);
          }
        }
      }
    }
  }
  if (thresholds !== undefined) {
    if (!thresholds || typeof thresholds !== "object") errors.push("thresholds must be an object");
    else {
      for (const [key, value] of Object.entries(thresholds)) {
        if (![...DIMENSION_KEYS, "overall_priority"].includes(key)) errors.push(`thresholds.${key}: unknown dimension`);
        else if (!Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > 100) {
          errors.push(`thresholds.${key}: must be an integer 0–100`);
        }
      }
    }
  }
  if (priority_weights !== undefined) {
    if (!priority_weights || typeof priority_weights !== "object") errors.push("priority_weights must be an object");
    else {
      const keys = Object.keys(priority_weights);
      for (const key of keys) {
        if (!DIMENSION_KEYS.includes(key)) errors.push(`priority_weights.${key}: unknown dimension`);
      }
      const sum = DIMENSION_KEYS.reduce((total, key) => total + (Number(priority_weights[key]) || 0), 0);
      if (sum !== 100) errors.push(`priority_weights must sum to 100 (got ${sum})`);
    }
  }
  return { ok: errors.length === 0, errors };
}
