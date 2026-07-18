/**
 * Reachwright request validation — small, strict, dependency-free.
 * Every operator endpoint validates its body against a closed schema:
 * unknown keys are rejected, strings are length-limited, enums are exact.
 */

export const LIMITS = Object.freeze({
  shortText: 200,
  mediumText: 2000,
  longText: 8000,
  url: 2048,
});

/**
 * Schema shape: { field: {type, required?, enum?, max?, min?, items?, integer?} }
 * type ∈ string|number|boolean|array|object
 * @returns {ok, value?, errors?}
 */
export function validateBody(body, schema) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: ["body must be a JSON object"] };
  }
  const errors = [];
  const allowed = new Set(Object.keys(schema));
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) errors.push(`unknown field: ${key}`);
  }
  const value = {};
  for (const [key, rule] of Object.entries(schema)) {
    const raw = body[key];
    if (raw === undefined || raw === null || raw === "") {
      if (rule.required) errors.push(`missing required field: ${key}`);
      else if (rule.default !== undefined) value[key] = rule.default;
      continue;
    }
    const err = checkValue(key, raw, rule);
    if (err) errors.push(err);
    else value[key] = raw;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

function checkValue(key, raw, rule) {
  switch (rule.type) {
    case "string": {
      if (typeof raw !== "string") return `${key} must be a string`;
      const max = rule.max ?? LIMITS.mediumText;
      if (raw.length > max) return `${key} exceeds ${max} characters`;
      if (rule.enum && !rule.enum.includes(raw)) return `${key} must be one of: ${rule.enum.join(", ")}`;
      if (rule.pattern && !rule.pattern.test(raw)) return `${key} has an invalid format`;
      return null;
    }
    case "number": {
      if (typeof raw !== "number" || !Number.isFinite(raw)) return `${key} must be a number`;
      if (rule.integer && !Number.isInteger(raw)) return `${key} must be an integer`;
      if (rule.min !== undefined && raw < rule.min) return `${key} must be ≥ ${rule.min}`;
      if (rule.max !== undefined && raw > rule.max) return `${key} must be ≤ ${rule.max}`;
      return null;
    }
    case "boolean":
      return typeof raw === "boolean" ? null : `${key} must be a boolean`;
    case "array": {
      if (!Array.isArray(raw)) return `${key} must be an array`;
      const maxItems = rule.maxItems ?? 50;
      if (raw.length > maxItems) return `${key} exceeds ${maxItems} items`;
      if (rule.minItems !== undefined && raw.length < rule.minItems) return `${key} needs at least ${rule.minItems} items`;
      if (rule.items) {
        for (const item of raw) {
          const err = checkValue(`${key}[]`, item, rule.items);
          if (err) return err;
        }
      }
      return null;
    }
    case "object":
      return raw && typeof raw === "object" && !Array.isArray(raw) ? null : `${key} must be an object`;
    default:
      return `${key} has an unknown schema type`;
  }
}

/** Generate an identifier: rw-<tag>-<time36><random>. Sortable enough, unguessable enough. */
export function makeId(tag) {
  const time = Date.now().toString(36);
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const random = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `rw-${tag}-${time}${random}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Reject calendar-invalid and future observation dates. */
export function validObservedDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && value <= today();
}
