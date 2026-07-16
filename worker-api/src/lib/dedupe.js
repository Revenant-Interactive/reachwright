/**
 * Reachwright deduplication — identity-key matching with merge semantics.
 * Primary key: normalized domain + location. Fallbacks: name+location,
 * verified phone, platform page ID (playbook §Duplicate logic).
 * A match merges evidence into the existing record; it never spawns a twin.
 */

import { identityKeys } from "./normalize.js";

/**
 * Find whether a candidate org duplicates an existing one.
 * @param candidate raw org {domain, name, location, phone, platform_page_id}
 * @param existing array of stored orgs with identity_keys (JSON array or array)
 * @returns {match: existingOrg|null, matchedKey: string|null, confidence: "primary"|"fallback"|null}
 */
export function findDuplicate(candidate, existing) {
  const candidateKeys = identityKeys(candidate);
  if (candidateKeys.length === 0) return { match: null, matchedKey: null, confidence: null };

  const primaryKeys = new Set(candidateKeys.filter((k) => k.startsWith("domain:")));
  const candidateSet = new Set(candidateKeys);

  for (const org of existing || []) {
    if (org.merge_state === "merged") continue; // only match against canonical records
    const keys = Array.isArray(org.identity_keys)
      ? org.identity_keys
      : safeParseArray(org.identity_keys);
    for (const key of keys) {
      if (candidateSet.has(key)) {
        return {
          match: org,
          matchedKey: key,
          confidence: primaryKeys.has(key) ? "primary" : "fallback",
        };
      }
    }
  }
  return { match: null, matchedKey: null, confidence: null };
}

/** Union of identity keys after a merge, canonical record first. */
export function mergedIdentityKeys(canonical, duplicate) {
  const a = Array.isArray(canonical) ? canonical : safeParseArray(canonical);
  const b = Array.isArray(duplicate) ? duplicate : safeParseArray(duplicate);
  return [...new Set([...a, ...b])];
}

function safeParseArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
