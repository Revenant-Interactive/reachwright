import test from "node:test";
import assert from "node:assert/strict";
import { analyzeHtml, detectCapacitySignals, detectOpportunitySignals, safeResearchUrl } from "../worker-api/src/lib/website-research.js";
import {
  buildMessageOptions, contactRoutesForPerson, prepareAuditRecommendation,
  recommendScores, recommendService, selectContactRoute,
} from "../worker-api/src/lib/generation.js";

test("website research blocks local/private destinations and observes bounded first-party signals", () => {
  for (const value of ["http://localhost:8788", "http://127.0.0.1", "http://10.0.0.2", "file:///tmp/a"]) {
    assert.equal(safeResearchUrl(value).ok, false, value);
  }
  assert.equal(safeResearchUrl("example.com").ok, true);
  const html = `<!doctype html><html><head><title>Acme Roofing</title>
    <meta name="viewport" content="width=device-width"></head><body>
    <h1>Commercial roofing in Champaign</h1><a href="mailto:owner@acme.example">Email</a>
    <footer>Copyright 2021</footer></body></html>`;
  const analysis = analyzeHtml(html, "https://acme.example/", 2026);
  assert.equal(analysis.title, "Acme Roofing");
  assert.equal(analysis.has_form, false);
  assert.equal(analysis.has_email_path, true);
  const signals = detectOpportunitySignals([{ final_url: "https://acme.example/", analysis }], 2026);
  assert.ok(signals.some((signal) => signal.type === "missing-form"));
  assert.ok(signals.some((signal) => signal.type === "stale-copyright"));
  assert.ok(signals.every((signal) => signal.source_url === "https://acme.example/"));
});

test("buying capacity requires observable public lead-generation infrastructure", () => {
  const withoutFlow = analyzeHtml("<html><body><h1>Consulting</h1></body></html>", "https://acme.example/");
  assert.deepEqual(detectCapacitySignals([{ final_url: "https://acme.example/", analysis: withoutFlow }]), []);
  const withFlow = analyzeHtml("<html><body><h1>Consulting</h1><form><input name='email'></form></body></html>",
    "https://acme.example/");
  const signals = detectCapacitySignals([{ final_url: "https://acme.example/", analysis: withFlow }]);
  assert.equal(signals[0].type, "lead-gen-infrastructure-active");
  assert.equal(signals[0].dimension, "buying-trigger");
  assert.match(signals[0].claim, /official page reviewed/);
});

test("an official current copy-role posting is both opportunity and buying-capacity evidence", () => {
  const analysis = analyzeHtml("<html><body><h1>Careers</h1><p>We are hiring a Content Strategist.</p></body></html>",
    "https://acme.example/careers");
  const pages = [{ final_url: "https://acme.example/careers", analysis }];
  const opportunity = detectOpportunitySignals(pages).find((signal) => signal.type === "hiring-copy-content-roles");
  assert.equal(opportunity.role_title, "Content Strategist");
  assert.match(opportunity.claim, /Content Strategist/);
  assert.ok(detectCapacitySignals(pages).some((signal) => signal.type === "hiring-current"));
});

test("careers-page navigation and service copy do not impersonate an open writing role", () => {
  const agency = analyzeHtml(`<html><body><nav><a href='/services/content-marketing'>Legal Content Marketing</a></nav>
    <h1>Careers</h1><h4>Marketing Coordinator</h4><p>Our content helps clients grow.</p></body></html>`,
  "https://agency.example/careers/");
  const software = analyzeHtml(`<html><body><nav><a href='/features/email-marketing'>Email marketing</a>
    <a href='/features/ai-content-writer'>AI Content Writer</a></nav><h1>Careers</h1>
    <h3>Marketing</h3><p>Send us your resume if a future role fits.</p></body></html>`,
  "https://software.example/careers/");
  for (const analysis of [agency, software]) {
    const pages = [{ final_url: analysis.source_url, analysis }];
    assert.equal(detectOpportunitySignals(pages).some((signal) => signal.type === "hiring-copy-content-roles"), false);
    assert.equal(detectCapacitySignals(pages).some((signal) => signal.type === "hiring-current"), false);
  }
});

test("a company-linked public job board can supply the same current hiring signal", () => {
  const home = analyzeHtml("<html><body><h1>Acme</h1><a href='https://jobs.lever.co/acme'>Careers</a></body></html>",
    "https://acme.example/");
  assert.deepEqual(home.public_job_links, ["https://jobs.lever.co/acme"]);
  const jobs = analyzeHtml("<html><body><h1>Open roles</h1><p>Content Writer</p></body></html>",
    "https://jobs.lever.co/acme");
  const signals = detectOpportunitySignals([{ final_url: "https://acme.example/", analysis: home }],
    2026, [{ final_url: "https://jobs.lever.co/acme", analysis: jobs }]);
  const hiring = signals.find((signal) => signal.type === "hiring-copy-content-roles");
  assert.equal(hiring.strength, "authoritative-directory");
  assert.equal(hiring.source_url, "https://jobs.lever.co/acme");
  assert.equal(hiring.role_title, "Content Writer");
});

test("verified hiring demand produces a role-specific capacity message and context-aware service match", async () => {
  const signal = { type: "hiring-copy-content-roles", confidence: 90, evidence_id: "ev-job",
    role_title: "Senior Content Writer", claim: "The current careers page lists “Senior Content Writer”." };
  const services = [
    { id: "rw-svc-lifecycle-email", name: "Lifecycle email", description: "Email retention copy.",
      active: 1, priority: 70, signal_types: '["hiring-copy-content-roles"]' },
    { id: "rw-svc-agency-overflow", name: "Agency overflow / white-label copy",
      description: "White-label copywriting capacity for agencies.", active: 1, priority: 130,
      signal_types: '["hiring-copy-content-roles"]' },
  ];
  const organization = { display_name: "JSA", industry: "PR and marketing agency" };
  const match = recommendService([signal], services, { organization });
  assert.equal(match.service.id, "rw-svc-agency-overflow");
  const options = await buildMessageOptions({ campaign: {}, organization,
    person: { full_name: "Jaymie Cutaia" }, signal, service: match.service, channel: "email" });
  assert.equal(options.length, 3);
  assert.ok(options.every((option) => option.body.includes("Senior Content Writer")));
  assert.ok(options.some((option) => option.strategy === "fit-question"));
  assert.ok(options.every((option) => !/documented one specific point|path behind this observation/i.test(option.body)));
});

test("service, score, audit, contact, and message recommendations remain proposals with citations", async () => {
  const services = [{ id: "svc", name: "Lead capture and follow-up automation", active: 1,
    priority: 1, signal_types: '["missing-lead-capture"]', entry_angle: "Lead with the missing next step.",
    description: "Connect inquiry and follow-up." }];
  const signal = { id: "sig", evidence_id: "ev-1", type: "missing-lead-capture", signal_type: "missing-lead-capture",
    claim: "No form, booking path, phone link, email link, or contact page was detected on the official homepage reviewed", confidence: 92,
    source_url: "https://acme.example/" };
  const match = recommendService([signal], services);
  assert.equal(match.service.id, "svc");

  const person = { id: "p1", full_name: "Avery Owner", title: "Owner",
    business_email: "avery@acme.example", email_status: "verified", source_provider: "hunter-domain",
    observed_at: "2026-07-16" };
  const routes = contactRoutesForPerson(person);
  assert.equal(routes[0].verification_state, "provider-verified");
  const route = selectContactRoute(routes, '["email","linkedin-manual"]');
  assert.equal(route.route_type, "email");

  const evidence = [
    { id: "ev-1", strength: "first-party", reviewer_state: "unreviewed", observed_at: "2026-07-16", contradiction_state: "none" },
    { id: "ev-2", strength: "first-party", reviewer_state: "unreviewed", observed_at: "2026-07-16", contradiction_state: "none" },
  ];
  const campaign = { allowed_channels: '["email"]' };
  const organization = { display_name: "Acme Roofing", location: "Champaign, IL" };
  const scores = recommendScores({ campaign, organization, evidence, signals: [signal], contactRoute: route,
    marketFit: { supported: true, matched_keywords: ["roofing"], confidence: 80 } });
  assert.equal(scores.proposed_pass, true);
  const audit = prepareAuditRecommendation({ organization, evidence, person, contactRoute: route,
    primarySignal: signal });
  assert.equal(audit.complete_recommendation, false, "contradiction and identity checks still need a human");
  assert.equal(audit.checks.contradictions_checked.status, "needs-review");

  const options = await buildMessageOptions({ campaign: { offer: "ignored" }, organization, person,
    signal, service: services[0], channel: "email" });
  assert.equal(options.length, 3);
  assert.ok(options.every((option) => option.evidence_ids[0] === "ev-1"));
  assert.ok(options.every((option) => option.body.includes("No form, booking path, phone link, email link, or contact page was detected")));
  assert.equal(new Set(options.map((option) => option.strategy)).size, 3);
});

test("a missing primary heading remains an observation but cannot qualify outreach by itself", () => {
  const services = [{ id: "homepage", name: "Website & homepage messaging", active: 1, priority: 1,
    signal_types: '["missing-primary-heading"]' }];
  const match = recommendService([{ type: "missing-primary-heading", confidence: 85,
    claim: "The reviewed homepage has no detectable H1.", source_url: "https://acme.example/" }], services);
  assert.equal(match, null);
});
