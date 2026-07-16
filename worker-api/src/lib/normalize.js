/**
 * Reachwright normalization — deterministic identity handling for
 * organizations, people, and contact keys. Pure functions, no I/O.
 */

/** Lowercase a domain, strip protocol/www/paths/ports. Returns "" if unusable. */
export function normalizeDomain(input) {
  if (typeof input !== "string") return "";
  let value = input.trim().toLowerCase();
  if (!value) return "";
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // protocol
  value = value.replace(/^www\./, "");
  value = value.split(/[/?#]/, 1)[0];
  value = value.split("@").pop();                        // strip mailbox part if pasted
  value = value.split(":")[0];                           // port
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(value)) return "";
  return value;
}

/** Normalize a business name: lowercase, strip punctuation and legal suffixes. */
export function normalizeName(input) {
  if (typeof input !== "string") return "";
  let value = input.trim().toLowerCase();
  value = value.replace(/&/g, " and ");
  value = value.replace(/\.(?=\S)/g, "");   // dotted abbreviations collapse: l.l.c → llc
  value = value.replace(/[^\p{L}\p{N}\s]/gu, " ");
  const suffixes = new Set(["llc", "inc", "incorporated", "ltd", "limited", "corp",
    "corporation", "co", "company", "plc", "gmbh", "srl", "sa", "pty", "llp", "pc"]);
  const words = value.split(/\s+/).filter(Boolean);
  while (words.length > 1 && suffixes.has(words[words.length - 1])) words.pop();
  return words.join(" ");
}

/** Digits-only phone with country handling. Returns "" if fewer than 7 digits. */
export function normalizePhone(input) {
  if (typeof input !== "string") return "";
  const digits = input.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return "";
  // US 11-digit with leading 1 collapses to 10 so 1-555… and 555… match.
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

/** Lowercased email; plus-tags removed; gmail dots collapsed. */
export function normalizeEmail(input) {
  if (typeof input !== "string") return "";
  const value = input.trim().toLowerCase();
  const match = value.match(/^([a-z0-9._%+-]+)@([a-z0-9.-]+\.[a-z]{2,})$/);
  if (!match) return "";
  let local = match[1].split("+")[0];
  const domain = match[2];
  if (domain === "gmail.com" || domain === "googlemail.com") local = local.replaceAll(".", "");
  return `${local}@${domain}`;
}

/** Social handle: strip URL, @, trailing slashes; lowercase. */
export function normalizeHandle(input) {
  if (typeof input !== "string") return "";
  let value = input.trim().toLowerCase();
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^www\./, "");
  value = value.replace(/^(facebook\.com|instagram\.com|x\.com|twitter\.com|tiktok\.com|linkedin\.com\/(company|in))\//, "");
  value = value.replace(/^@/, "").split(/[/?#]/, 1)[0];
  return /^[a-z0-9._-]{2,100}$/.test(value) ? value : "";
}

/** Normalize a street-ish location string for identity keys. */
export function normalizeLocation(input) {
  if (typeof input !== "string") return "";
  return input.trim().toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * Identity keys for an organization, strongest first.
 * Primary: domain+location. Fallbacks: name+location, phone, platform page id.
 * Every key is prefixed with its type so keys never collide across types.
 */
export function identityKeys(org) {
  const keys = [];
  const domain = normalizeDomain(org.domain || org.normalized_domain || "");
  const name = normalizeName(org.name || org.display_name || "");
  const location = normalizeLocation(org.location || "");
  const phone = normalizePhone(org.phone || "");
  if (domain) keys.push(`domain:${domain}|loc:${location}`);
  if (domain) keys.push(`domain:${domain}`);
  if (name && location) keys.push(`name:${name}|loc:${location}`);
  if (phone) keys.push(`phone:${phone}`);
  if (org.platform_page_id) keys.push(`page:${String(org.platform_page_id).toLowerCase()}`);
  return [...new Set(keys)];
}
