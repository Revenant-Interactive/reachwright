/**
 * Reachwright suppression — normalized keys, cross-channel expansion,
 * and match logic. An opt-out on ANY channel suppresses the company and
 * all known contact points across ALL channels (playbook rule).
 */

import {
  normalizeDomain,
  normalizeEmail,
  normalizeHandle,
  normalizeName,
  normalizePhone,
} from "./normalize.js";

/** Build the full set of suppression keys derivable from a prospect. */
export function suppressionKeysFor({ organization = {}, person = {} }) {
  const keys = [];
  const domain = normalizeDomain(organization.normalized_domain || organization.domain || "");
  const orgName = normalizeName(organization.normalized_name || organization.name || "");
  if (domain) keys.push({ key_type: "domain", key_value: domain });
  if (orgName) keys.push({ key_type: "org", key_value: orgName });
  const email = normalizeEmail(person.business_email || person.email || "");
  if (email) {
    keys.push({ key_type: "email", key_value: email });
    const emailDomain = email.split("@")[1];
    // A personal-mailbox domain is NOT an org key; only add corporate domains.
    if (emailDomain && emailDomain === domain) keys.push({ key_type: "domain", key_value: emailDomain });
  }
  const phone = normalizePhone(person.business_phone || person.phone || organization.phone || "");
  if (phone) keys.push({ key_type: "phone", key_value: phone });
  const handle = normalizeHandle(person.public_profile_url || organization.social_url || "");
  if (handle) keys.push({ key_type: "handle", key_value: handle });
  for (const alias of organization.aliases || []) {
    const normalized = normalizeName(alias);
    if (normalized) keys.push({ key_type: "alias", key_value: normalized });
  }
  const seen = new Set();
  return keys.filter(({ key_type, key_value }) => {
    const composite = `${key_type}:${key_value}`;
    if (seen.has(composite)) return false;
    seen.add(composite);
    return true;
  });
}

/** Normalize a raw value for a given suppression key type. "" = invalid. */
export function normalizeSuppressionValue(keyType, value) {
  switch (keyType) {
    case "email": return normalizeEmail(value);
    case "domain": return normalizeDomain(value);
    case "phone": return normalizePhone(value);
    case "handle": return normalizeHandle(value);
    case "org":
    case "alias": return normalizeName(value);
    default: return "";
  }
}

/**
 * Match candidate keys against stored entries.
 * @param candidateKeys [{key_type, key_value}]
 * @param entries stored rows [{key_type, key_value, reason, expires_at}]
 * @param now Date for expiry checks
 * @returns {suppressed, matches:[{key_type,key_value,reason}]}
 */
export function checkSuppression(candidateKeys, entries, now = new Date()) {
  const active = (entries || []).filter((entry) => {
    if (!entry?.expires_at) return true;
    const expiry = new Date(entry.expires_at);
    return !Number.isFinite(expiry.getTime()) || expiry > now;
  });
  const index = new Map(active.map((e) => [`${e.key_type}:${e.key_value}`, e]));
  const matches = [];
  for (const key of candidateKeys || []) {
    const hit = index.get(`${key.key_type}:${key.key_value}`);
    if (hit) matches.push({ key_type: hit.key_type, key_value: hit.key_value, reason: hit.reason });
  }
  return { suppressed: matches.length > 0, matches };
}

/**
 * Expand an opt-out into entries covering every known channel key.
 * Called when a prospect opts out anywhere.
 */
export function expandOptOut(prospect, reason, sourceChannel) {
  return suppressionKeysFor(prospect).map((key) => ({
    ...key,
    reason: reason || "opt-out",
    source_channel: sourceChannel || "",
  }));
}
