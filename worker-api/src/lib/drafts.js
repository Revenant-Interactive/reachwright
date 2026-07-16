/**
 * Reachwright outreach drafts — evidence-only assembly.
 *
 * Hard rules (playbook + build spec):
 * - A draft may state ONLY facts present in accepted evidence items.
 * - The generator may not invent revenue, budget, ad spend, problems,
 *   family information, statistics, partnerships, technology, urgency,
 *   or personal familiarity.
 * - Insufficient evidence → the literal outcome "insufficient evidence
 *   for personalized outreach", never filler.
 * - Every draft carries the evidence IDs it used and a content hash.
 * - Editing an approved draft returns it to draft status (enforced in routes).
 */

export const PROMPT_VERSION = "deterministic-template-0.1";
export const INSUFFICIENT = "insufficient evidence for personalized outreach";

const FORBIDDEN_INVENTIONS = [
  /\$[\d,.]+\s*(?:k|m|million|thousand)?\s*(?:revenue|budget|spend)/i,
  /\b(?:i noticed you(?:'re| are) struggling|i know you)\b/i,
  /\b(?:act now|limited time|urgent)\b/i,
];

/**
 * Deterministically assemble an outreach draft from accepted evidence.
 * @param campaign {offer, voice_notes}
 * @param organization {display_name}
 * @param person {full_name, title} | null
 * @param evidence accepted evidence rows [{id, claim, strength, observed_at}]
 * @param channel "email" | "linkedin-manual" | "dm"
 * @returns {ok, body?, evidence_ids?, reason?}
 */
export function assembleDraft({ campaign, organization, person, evidence, channel }) {
  const usable = (evidence || []).filter(
    (item) => item
      && item.reviewer_state === "accepted"
      && (item.strength === "first-party" || item.strength === "authoritative-directory")
      && typeof item.claim === "string" && item.claim.trim().length > 0,
  );
  if (usable.length === 0) return { ok: false, reason: INSUFFICIENT };
  if (!campaign?.offer || !organization?.display_name) {
    return { ok: false, reason: "missing campaign offer or organization identity" };
  }

  const firstName = person?.full_name ? person.full_name.trim().split(/\s+/)[0] : "";
  const greeting = firstName ? `Hi ${firstName},` : `Hello ${organization.display_name} team,`;
  // Observation sentence built ONLY from the strongest accepted claim, cited verbatim.
  const primary = usable.sort((a, b) => strengthRank(a) - strengthRank(b))[0];
  const secondary = usable.find((item) => item.id !== primary.id);

  const lines = [
    greeting,
    "",
    `I'm reaching out because ${lowerFirst(trimPeriod(primary.claim))}.`,
  ];
  if (secondary) lines.push(`I also saw that ${lowerFirst(trimPeriod(secondary.claim))}.`);
  lines.push(
    "",
    `${trimPeriod(campaign.offer)}. If that's relevant, I'd welcome a short conversation — and if it's not, a one-word "no" is a complete answer.`,
    "",
    "Michael Taylor",
    "ReeMergence Holdings",
  );
  const body = lines.join("\n");

  for (const pattern of FORBIDDEN_INVENTIONS) {
    if (pattern.test(body)) return { ok: false, reason: "generated text violated invention rules" };
  }
  if (channel === "email" && !campaign.email_gate_passed) {
    // Draft may exist, but routes must keep email drafts un-exportable until the gate passes.
  }
  return { ok: true, body, evidence_ids: usable.slice(0, 2).map((item) => item.id) };
}

/** SHA-256 hex of exact draft text (WebCrypto, available in Workers and Node). */
export async function contentHash(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function strengthRank(item) {
  return item.strength === "first-party" ? 0 : 1;
}
function trimPeriod(text) {
  return text.trim().replace(/[.\s]+$/, "");
}
function lowerFirst(text) {
  // Don't lowercase proper nouns blindly: only lowercase if the first word is a common starter.
  const starters = /^(The|They|Their|Your|You|Its|It|This|A|An)\b/;
  return starters.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}
