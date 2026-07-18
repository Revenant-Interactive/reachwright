/**
 * Bind a dossier audit to the exact campaign evidence the operator reviewed.
 * Any material evidence change produces a different SHA-256 fingerprint and
 * forces a fresh audit before drafting.
 */
export async function evidenceFingerprint(items) {
  const canonical = (items || []).map((item) => ({
    id: item.id,
    person_id: item.person_id || null,
    claim: item.claim,
    source_url: item.source_url,
    observed_at: item.observed_at,
    strength: item.strength,
    reviewer_state: item.reviewer_state,
    contradiction_state: item.contradiction_state,
  })).sort((a, b) => a.id.localeCompare(b.id));
  const bytes = new TextEncoder().encode(JSON.stringify(canonical));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Bind audit and score validity to both campaign evidence and the current
 * decision-maker/contact records. Correcting or enriching a person must force
 * a fresh operator check instead of inheriting an older contact attestation.
 */
export async function dossierFingerprint(items, people = []) {
  const canonicalPeople = (people || []).map((person) => ({
    id: person.id,
    full_name: person.full_name || "",
    title: person.title || "",
    business_email: person.business_email || "",
    email_status: person.email_status || "",
    business_phone: person.business_phone || "",
    public_profile_url: person.public_profile_url || "",
    verification_state: person.verification_state || "",
    do_not_contact: Number(person.do_not_contact || 0),
    observed_at: person.observed_at || "",
  })).sort((a, b) => a.id.localeCompare(b.id));
  const evidenceHash = await evidenceFingerprint(items);
  const bytes = new TextEncoder().encode(JSON.stringify({ evidenceHash, people: canonicalPeople }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const REQUIRED_DOSSIER_AUDIT_CHECKS = Object.freeze([
  "identity_verified",
  "offer_signal_verified",
  "geography_verified",
  "decision_maker_verified",
  "contact_path_verified",
  "contradictions_checked",
]);

/**
 * Accurate is not just a verdict string. It is valid only when the operator
 * persisted every required verification attestation. This deliberately makes
 * pre-checklist audits stale after migration rather than grandfathering them
 * into drafting or reporting.
 */
export function dossierAuditChecklistComplete(auditOrChecklist) {
  let checklist = auditOrChecklist;
  if (auditOrChecklist && typeof auditOrChecklist === "object"
    && Object.prototype.hasOwnProperty.call(auditOrChecklist, "checklist")) {
    checklist = auditOrChecklist.checklist;
  }
  if (typeof checklist === "string") {
    try { checklist = JSON.parse(checklist); } catch { return false; }
  }
  return Boolean(checklist && typeof checklist === "object" && !Array.isArray(checklist)
    && REQUIRED_DOSSIER_AUDIT_CHECKS.every((name) => checklist[name] === true));
}
