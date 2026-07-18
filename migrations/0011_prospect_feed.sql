-- Reachwright D1 schema · migration 0011 · 2026-07-18
-- Operator-first copywriting prospect feed. Seeds one broad internal market,
-- retires the pre-copywriting service rows, and stores the market-model
-- evaluation beside every generated candidate.

PRAGMA foreign_keys = ON;

ALTER TABLE generation_candidates ADD COLUMN market_evaluation TEXT NOT NULL DEFAULT '{}';
ALTER TABLE opportunity_signals ADD COLUMN dimension TEXT NOT NULL DEFAULT 'copy-opportunity';

UPDATE client_services
SET active = 0, updated_at = '2026-07-18T00:00:00.000Z'
WHERE id LIKE 'rw-service-%';

INSERT OR IGNORE INTO client_offers
  (id, client_id, name, description, ideal_customer, proof_points, economics_note,
   active, created_at, updated_at)
VALUES
  ('rw-client-offer-copywriting', 'rw-client-reemergence',
   'Conversion copywriting services',
   'Focused website, landing-page, offer-positioning, email, proof, case-study, and campaign copywriting projects tied to an observable public opportunity.',
   'Active owner-led or marketing-led businesses with a visible acquisition asset, a supportable copy opportunity, buying capacity, and a permitted route to the right person.',
   '[]',
   'Start with one evidence-backed asset or campaign; do not claim business harm or invent performance data.',
   1, '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z');

INSERT OR IGNORE INTO campaigns
  (id, owner, name, offer, icp, geography, positive_signals, disqualifiers,
   min_economics, allowed_channels, max_batch_size, voice_notes, success_metric,
   status, created_at, updated_at, client_id, client_offer_id, client_offer_snapshot,
   buying_triggers, score_thresholds)
VALUES
  ('rw-c-copywriting-feed', 'michael', 'Copywriting opportunity feed',
   'Michael Taylor provides focused conversion copywriting: website and homepage messaging, landing pages, positioning, email sequences, proof assets, case studies, sales enablement, and campaign copy.',
   'Active owner-led and marketing-led businesses across B2B, professional services, software, agencies, healthcare, finance, real estate, and established local services. A candidate must show a cited copy opportunity, observable buying capacity, and a permitted route to an owner, founder, executive, or marketing leader.',
   'United States',
   '["marketing agency","SaaS","software company","consulting firm","law firm","financial services","dental practice","med spa","professional services","home services","real estate","B2B services"]',
   '["dormant or parked website","franchise headquarters","no observable copy opportunity","no observable buying capacity","no supportable contact route","incompatible or prohibited industry"]',
   'The public business appears active and shows observable investment in acquisition, a customer base, or a high-value offer that can plausibly support a focused copywriting project.',
   '["email","linkedin-manual"]', 40,
   'Respectful, concise, evidence-led, and specific. State only what was observed on a cited public asset. Never say the prospect needs a copywriter, has bad copy, is losing money, or has poor conversion without verified data.',
   'Qualified positive replies and booked fit conversations from evidence-backed manual outreach.',
   'researching', '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z',
   'rw-client-reemergence', 'rw-client-offer-copywriting',
   '{"id":"rw-client-offer-copywriting","name":"Conversion copywriting services"}',
   '["active lead-generation infrastructure","current hiring or growth investment","product or service launch","rebrand or expansion","high-value offer","agency overflow or public request"]',
   '{"icp_fit":60,"copy_opportunity":60,"buying_capacity":50,"evidence_quality":60,"evidence_recency":50,"reachability":60,"overall_priority":60}');

-- Old browser/fixture campaigns stay in the audit trail but no longer pollute
-- the operator queue. The broad campaign above becomes the active default.
UPDATE campaigns
SET status = 'closed', updated_at = '2026-07-18T00:00:00.000Z'
WHERE UPPER(name) LIKE 'DEV SEED%'
   OR LOWER(name) LIKE '%browser test%';
