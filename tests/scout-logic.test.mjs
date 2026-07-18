import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeDomain, normalizeName, normalizePhone, normalizeEmail,
  normalizeHandle, normalizeLocation, identityKeys,
} from "../worker-api/src/lib/normalize.js";
import { findDuplicate, mergedIdentityKeys } from "../worker-api/src/lib/dedupe.js";
import {
  scoreFit, scoreEvidence, deriveEvidenceInputs, passesQueueThreshold, RULE_VERSION,
} from "../worker-api/src/lib/scoring.js";
import {
  suppressionKeysFor, checkSuppression, normalizeSuppressionValue, expandOptOut,
} from "../worker-api/src/lib/suppression.js";
import { assembleDraft, contentHash, INSUFFICIENT } from "../worker-api/src/lib/drafts.js";
import { csvEscape, toCsv } from "../worker-api/src/lib/csv.js";
import { validObservedDate, validateBody } from "../worker-api/src/lib/validate.js";
import { contactForChannel } from "../worker-api/src/lib/contact.js";

// ---------------------------------------------------------------- normalize
test("domain normalization strips protocol, www, paths, ports", () => {
  assert.equal(normalizeDomain("https://www.Harbor-Roofing.com/about?x=1"), "harbor-roofing.com");
  assert.equal(normalizeDomain("HARBOR-ROOFING.COM:443"), "harbor-roofing.com");
  assert.equal(normalizeDomain("not a domain"), "");
});

test("channel contacts are exact, syntactically usable, and never fall back across channels", () => {
  const person = {
    business_email: "Owner@Example.com",
    email_status: "verified",
    business_phone: "+1 (217) 555-0101",
    public_profile_url: "https://www.linkedin.com/in/example-owner",
    verification_state: "verified",
  };
  assert.equal(contactForChannel(person, "email"), "Owner@Example.com");
  assert.equal(contactForChannel(person, "phone"), "+1 (217) 555-0101");
  assert.equal(contactForChannel(person, "linkedin-manual"), person.public_profile_url);
  assert.equal(contactForChannel(person, "dm"), person.public_profile_url);

  assert.equal(contactForChannel({ ...person, business_email: "not-an-email" }, "email"), "");
  assert.equal(contactForChannel({ ...person, email_status: "bounced" }, "email"), "");
  assert.equal(contactForChannel({ ...person, business_phone: "call me" }, "phone"), "");
  assert.equal(contactForChannel({ ...person, public_profile_url: "https://example.com/team/owner" }, "linkedin-manual"), "");
  assert.equal(contactForChannel({ ...person, public_profile_url: "https://facebook.com/example-owner" }, "linkedin-manual"), "");
  assert.equal(contactForChannel({ ...person, public_profile_url: "https://linkedin.com/company/example" }, "linkedin-manual"), "");
  assert.equal(contactForChannel({ ...person, public_profile_url: "https://facebook.com/example-owner" }, "dm"),
    "https://facebook.com/example-owner");
  assert.equal(contactForChannel({ ...person, do_not_contact: 1 }, "email"), "");
});

test("name normalization removes legal suffixes and punctuation", () => {
  assert.equal(normalizeName("Harbor Roofing Co."), "harbor roofing");
  assert.equal(normalizeName("Harbor Roofing, LLC"), "harbor roofing");
  assert.equal(normalizeName("Smith & Sons Inc"), "smith and sons");
});

test("phone normalization collapses US country code", () => {
  assert.equal(normalizePhone("+1 (217) 555-0101"), "2175550101");
  assert.equal(normalizePhone("217.555.0101"), "2175550101");
  assert.equal(normalizePhone("12345"), "");
});

test("email normalization handles plus tags and gmail dots", () => {
  assert.equal(normalizeEmail("Owner+tag@Example.COM"), "owner@example.com");
  assert.equal(normalizeEmail("j.o.h.n@gmail.com"), "john@gmail.com");
  assert.equal(normalizeEmail("nope"), "");
});

test("handle normalization strips platform URLs", () => {
  assert.equal(normalizeHandle("https://facebook.com/HarborRoofing/"), "harborroofing");
  assert.equal(normalizeHandle("@harbor_roofing"), "harbor_roofing");
});

test("observation dates reject impossible and future calendar values", () => {
  assert.equal(validObservedDate("2026-07-15"), true);
  assert.equal(validObservedDate("2026-02-30"), false);
  assert.equal(validObservedDate("2099-01-01"), false);
});

test("location normalization aligns common US state and country variants", () => {
  assert.equal(normalizeLocation("Chicago, Illinois, United States"), "chicago il");
  assert.equal(normalizeLocation("Chicago, IL"), "chicago il");
});

// ------------------------------------------------------------------- dedupe
test("duplicate detection: same domain+location merges; franchises with different locations do not", () => {
  const existing = [{
    id: "org-1", merge_state: "active",
    identity_keys: identityKeys({ domain: "harbor-roofing.com", name: "Harbor Roofing Co", location: "Champaign, Illinois", phone: "+1 217 555 0101" }),
  }];
  const dupHit = findDuplicate(
    { domain: "www.harbor-roofing.com", name: "Harbor Roofing Company", location: "Champaign, Illinois" },
    existing,
  );
  assert.equal(dupHit.match?.id, "org-1");
  assert.equal(dupHit.confidence, "primary");

  // Domainless fallback: name+location matches
  const nameHit = findDuplicate(
    { name: "Harbor Roofing, LLC", location: "Champaign — Illinois" },
    existing,
  );
  assert.equal(nameHit.match?.id, "org-1");
  assert.equal(nameHit.confidence, "fallback");

  // Different location, no domain → no match (multi-branch stays separate until merged by phone/page id)
  const miss = findDuplicate({ name: "Harbor Roofing", location: "Peoria, Illinois" }, existing);
  assert.equal(miss.match, null);

  // A corporate domain shared by multiple branches is not enough to merge
  // two known, different locations.
  const branchMiss = findDuplicate(
    { domain: "harbor-roofing.com", name: "Harbor Roofing", location: "Peoria, Illinois" },
    existing,
  );
  assert.equal(branchMiss.match, null);

  const sharedPhoneBranch = findDuplicate(
    { name: "Harbor Roofing", location: "Peoria, IL", phone: "+1 217 555 0101" },
    existing,
  );
  assert.equal(sharedPhoneBranch.match, null, "a shared corporate phone cannot merge known different branches");
});

test("merged records are not merge targets; key union preserved", () => {
  const existing = [
    { id: "org-dup", merge_state: "merged", identity_keys: ["domain:harbor-roofing.com"] },
    { id: "org-canon", merge_state: "active", identity_keys: ["domain:harbor-roofing.com"] },
  ];
  const hit = findDuplicate({ domain: "harbor-roofing.com" }, existing);
  assert.equal(hit.match?.id, "org-canon");
  assert.deepEqual(
    mergedIdentityKeys(["a", "b"], ["b", "c"]),
    ["a", "b", "c"],
  );
});

// ------------------------------------------------------------------ scoring
test("fit rubric weights match the playbook and full marks total 100", () => {
  const full = scoreFit({
    offer_match: 1, timing_signal: 1, geography: 1, economics: 1, capacity_growth: 1, reachable: 1,
  });
  assert.equal(full.total, 100);
  assert.equal(full.rule_version, RULE_VERSION);
  assert.equal(full.factors.find((f) => f.factor === "offer_match").weight, 30);
  assert.equal(full.factors.find((f) => f.factor === "reachable").weight, 10);
});

test("hard disqualifier zeroes fit and records the reason", () => {
  const scored = scoreFit({ offer_match: 1, timing_signal: 1 }, [{ rule: "franchise-hq", reason: "corporate HQ, not local owner" }]);
  assert.equal(scored.total, 0);
  assert.equal(scored.disqualifiers[0].reason, "corporate HQ, not local owner");
});

test("scoring is deterministic and explainable", () => {
  const inputs = { offer_match: 0.5, timing_signal: 1, geography: 1, economics: 0, capacity_growth: 0, reachable: 1 };
  const a = scoreFit(inputs);
  const b = scoreFit(inputs);
  assert.deepEqual(a, b);
  assert.equal(a.total, 15 + 20 + 15 + 10);
  const explained = a.factors.reduce((sum, f) => sum + f.points, 0);
  assert.equal(explained, a.total);
});

test("evidence inputs derive from stored items; stale evidence scores low", () => {
  const today = "2026-07-15";
  const fresh = deriveEvidenceInputs([
    { strength: "first-party", observed_at: "2026-07-10", contradiction_state: "none", reviewer_state: "accepted" },
    { strength: "first-party", observed_at: "2026-07-12", contradiction_state: "none", reviewer_state: "accepted" },
  ], { today, contactVerified: true });
  const freshScore = scoreEvidence(fresh);
  assert.equal(freshScore.total, 93, "a clean ledger without an explicit contradiction resolution gets partial credit");

  const ignored = deriveEvidenceInputs([
    { strength: "first-party", observed_at: "2026-07-12", contradiction_state: "none", reviewer_state: "unreviewed" },
  ], { today, contactVerified: true });
  assert.equal(scoreEvidence(ignored).total, 15, "unreviewed facts cannot inflate evidence confidence");

  const stale = deriveEvidenceInputs([
    { strength: "first-party", observed_at: "2026-01-01", contradiction_state: "none", reviewer_state: "accepted" },
  ], { today });
  const staleScore = scoreEvidence(stale);
  assert.ok(staleScore.total < 40, `stale evidence should score low, got ${staleScore.total}`);

  const contradicted = deriveEvidenceInputs([
    { strength: "first-party", observed_at: "2026-07-10", contradiction_state: "contradicted", reviewer_state: "accepted" },
    { strength: "first-party", observed_at: "2026-07-10", contradiction_state: "none", reviewer_state: "accepted" },
  ], { today });
  assert.equal(contradicted.contradictions_handled, 0);
});

test("queue threshold: fit ≥65 AND evidence ≥70; overrides respected but originals kept", () => {
  assert.equal(passesQueueThreshold({ total: 65 }, { total: 70 }), true);
  assert.equal(passesQueueThreshold({ total: 64 }, { total: 100 }), false);
  assert.equal(passesQueueThreshold({ total: 100 }, { total: 69 }), false);
  assert.equal(passesQueueThreshold({ total: 40, override_total: 70 }, { total: 75 }), true);
});

// -------------------------------------------------------------- suppression
test("suppression keys cover email, domain, phone, handle, org, aliases", () => {
  const keys = suppressionKeysFor({
    organization: { domain: "harbor-roofing.com", name: "Harbor Roofing Co", aliases: ["Harbor Roofing of Champaign"] },
    person: { business_email: "dana@harbor-roofing.com", business_phone: "+1 217 555 0101", public_profile_url: "https://facebook.com/HarborRoofing" },
  });
  const types = keys.map((k) => k.key_type);
  for (const expected of ["email", "domain", "phone", "handle", "org", "alias"]) {
    assert.ok(types.includes(expected), `missing ${expected}`);
  }
});

test("an opt-out on one channel suppresses every known channel", () => {
  const entries = expandOptOut({
    organization: { domain: "harbor-roofing.com", name: "Harbor Roofing" },
    person: { business_email: "dana@harbor-roofing.com" },
  }, "opt-out", "email");
  const domainEntry = entries.find((e) => e.key_type === "domain");
  assert.ok(domainEntry, "opt-out must expand to the domain key");
  // Now a DM attempt to the same company is suppressed:
  const dmCheck = checkSuppression(
    suppressionKeysFor({ organization: { domain: "harbor-roofing.com", name: "Harbor Roofing" } }),
    entries,
  );
  assert.equal(dmCheck.suppressed, true);
});

test("expired suppression entries stop matching; spelling variants still match via normalization", () => {
  const expired = [{ key_type: "domain", key_value: "old.example", reason: "test", expires_at: "2020-01-01T00:00:00Z" }];
  assert.equal(checkSuppression([{ key_type: "domain", key_value: "old.example" }], expired).suppressed, false);
  assert.equal(normalizeSuppressionValue("org", "Harbor Roofing, L.L.C."), normalizeSuppressionValue("org", "harbor roofing llc"));
});

// ------------------------------------------------------------------- drafts
const acceptedEvidence = [
  { id: "ev-1", claim: "The company's website lists commercial roofing as a primary service", strength: "first-party", reviewer_state: "accepted", observed_at: "2026-07-14" },
  { id: "ev-2", claim: "Their Google Business profile shows 40+ reviews this year", strength: "authoritative-directory", reviewer_state: "accepted", observed_at: "2026-07-13" },
];
const campaign = { offer: "We book qualified sales calls for roofing contractors without landing pages", voice_notes: "" };
const organization = { display_name: "Harbor Roofing Co" };

test("drafts use only accepted strong evidence and cite it", () => {
  const result = assembleDraft({ campaign, organization, person: { full_name: "Dana Example" }, evidence: acceptedEvidence, channel: "linkedin-manual" });
  assert.equal(result.ok, true);
  assert.ok(result.body.includes("website lists commercial roofing"));
  assert.deepEqual(result.evidence_ids, ["ev-1", "ev-2"]);
});

test("insufficient evidence yields the literal insufficient outcome, not filler", () => {
  const weak = [{ id: "ev-3", claim: "someone said they're big", strength: "weak", reviewer_state: "accepted", observed_at: "2026-07-14" }];
  const result = assembleDraft({ campaign, organization, person: null, evidence: weak, channel: "dm" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, INSUFFICIENT);
  const rejectedOnly = [{ id: "ev-4", claim: "good claim", strength: "first-party", reviewer_state: "rejected", observed_at: "2026-07-14" }];
  assert.equal(assembleDraft({ campaign, organization, person: null, evidence: rejectedOnly, channel: "dm" }).ok, false);
});

test("content hash is stable and collision-visible on edits", async () => {
  const h1 = await contentHash("hello");
  const h2 = await contentHash("hello");
  const h3 = await contentHash("hello.");
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.match(h1, /^[a-f0-9]{64}$/);
});

// ---------------------------------------------------------------------- csv
test("csv export escapes quotes and neutralizes formula injection", () => {
  assert.equal(csvEscape('=HYPERLINK("http://evil")'), `"'=HYPERLINK(""http://evil"")"`);
  assert.equal(csvEscape("plain"), "plain");
  const csv = toCsv(["a", "b"], [{ a: "1,2", b: "@cmd" }]);
  assert.ok(csv.includes('"1,2"'));
  assert.ok(csv.includes("'@cmd"));
});

// --------------------------------------------------------------- validation
test("closed schemas reject unknown keys, oversized strings, and bad enums", () => {
  const schema = { name: { type: "string", required: true, max: 10 }, kind: { type: "string", enum: ["a", "b"] } };
  assert.equal(validateBody({ name: "ok", kind: "a" }, schema).ok, true);
  assert.equal(validateBody({ name: "ok", extra: 1 }, schema).ok, false);
  assert.equal(validateBody({ name: "x".repeat(11) }, schema).ok, false);
  assert.equal(validateBody({ name: "ok", kind: "z" }, schema).ok, false);
  assert.equal(validateBody(null, schema).ok, false);
});
