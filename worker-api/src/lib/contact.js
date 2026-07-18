import { normalizeEmail, normalizePhone } from "./normalize.js";

const UNUSABLE_EMAIL_STATUSES = new Set([
  "bounced", "invalid", "rejected", "risky", "unavailable",
]);

const DM_HOSTS = Object.freeze([
  "facebook.com", "instagram.com", "linkedin.com", "tiktok.com", "twitter.com", "x.com",
]);

function hostMatches(hostname, expected) {
  return hostname === expected || hostname.endsWith(`.${expected}`);
}

/**
 * Contact destinations remain exactly as stored, but only syntactically usable
 * destinations are allowed to cross a drafting/approval/export gate. In
 * particular, an ordinary company/team webpage is evidence, not a DM address.
 */
function usableProfileUrl(value, channel) {
  let parsed;
  try { parsed = new URL(value); } catch { return ""; }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return "";
  const hostname = parsed.hostname.toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, "");
  if (!hostname || !path) return "";
  if (channel === "linkedin-manual") {
    return hostMatches(hostname, "linkedin.com") && /^\/in\//i.test(path) ? value : "";
  }
  return DM_HOSTS.some((host) => hostMatches(hostname, host)) ? value : "";
}

/** Return the exact, usable contact destination required by an outreach channel. */
export function contactForChannel(person, channel) {
  if (!person || person.do_not_contact || person.verification_state === "rejected") return "";
  if (channel === "email") {
    const exact = String(person.business_email || "").trim();
    const status = String(person.email_status || "").trim().toLowerCase();
    return normalizeEmail(exact) && !UNUSABLE_EMAIL_STATUSES.has(status) ? exact : "";
  }
  if (channel === "phone") {
    const exact = String(person.business_phone || "").trim();
    return normalizePhone(exact) ? exact : "";
  }
  if (channel === "linkedin-manual" || channel === "dm") {
    const exact = String(person.public_profile_url || "").trim();
    return usableProfileUrl(exact, channel);
  }
  return "";
}

export function hasAllowedContact(person, channels) {
  return Array.isArray(channels) && channels.some((channel) => contactForChannel(person, channel));
}
