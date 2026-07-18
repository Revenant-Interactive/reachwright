-- Reachwright D1 schema · migration 0009 · 2026-07-16
-- Provider company-profile evidence, first-party role provenance, and a
-- market-fit recommendation that prevents weak website observations from
-- becoming qualified prospects by themselves.

PRAGMA foreign_keys = ON;

ALTER TABLE organizations ADD COLUMN industry TEXT NOT NULL DEFAULT '';
ALTER TABLE organizations ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE organizations ADD COLUMN employee_range TEXT NOT NULL DEFAULT '';
ALTER TABLE organizations ADD COLUMN company_type TEXT NOT NULL DEFAULT '';
ALTER TABLE organizations ADD COLUMN headquarters_location TEXT NOT NULL DEFAULT '';
ALTER TABLE organizations ADD COLUMN profile_tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE organizations ADD COLUMN enrichment_source TEXT NOT NULL DEFAULT '';
ALTER TABLE organizations ADD COLUMN enriched_at TEXT;

ALTER TABLE people ADD COLUMN role_source_url TEXT NOT NULL DEFAULT '';

ALTER TABLE website_research ADD COLUMN has_contact_page INTEGER NOT NULL DEFAULT 0
  CHECK (has_contact_page IN (0,1));

ALTER TABLE generation_candidates ADD COLUMN market_fit_recommendation TEXT NOT NULL DEFAULT '{}';

-- These are the only deterministic website observations strong enough to
-- qualify a generation packet without additional operator evidence.
UPDATE client_services
SET signal_types = '["missing-mobile-viewport","missing-primary-cta","missing-lead-capture"]',
    updated_at = '2026-07-16T00:00:00.000Z'
WHERE id = 'rw-service-website-conversion';

UPDATE client_services
SET signal_types = '["missing-lead-capture","manual-only-contact"]',
    updated_at = '2026-07-16T00:00:00.000Z'
WHERE id = 'rw-service-lead-automation';
