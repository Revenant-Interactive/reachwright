-- Reachwright D1 schema · migration 0014 · 2026-07-18
-- Remove HTML-structure trivia from the automatic opportunity gate and add a
-- general project-copy service for verified copy/content hiring demand.

PRAGMA foreign_keys = ON;

UPDATE signal_taxonomy
SET qualifying = 0,
    guidance = 'An absent detectable H1 is a technical observation, not enough evidence of commercial copy demand by itself.',
    updated_at = '2026-07-18T00:00:00.000Z'
WHERE signal_type = 'missing-primary-heading';

INSERT OR IGNORE INTO client_services
  (id, client_id, name, description, entry_angle, signal_types, delivery_type, public_rung, priority, active,
   target_business_type, target_buyer, company_stage, minimum_commercial_value,
   capacity_indicators, buying_triggers, service_disqualifiers, required_evidence, contact_roles,
   permitted_claims, prohibited_claims, typical_cta, next_step, created_at, updated_at)
VALUES
  ('rw-svc-content-campaign-copy', 'rw-client-reemergence', 'Content & campaign copy',
   'Project-based copy across articles, case studies, landing pages, email, sales collateral, and campaign assets for teams with an active writing workload.',
   'Name the exact current role and ask whether project support would help while the team fills or evaluates that need.',
   '["hiring-copy-content-roles"]',
   'service', 1, 65, 1,
   'B2B companies and agencies with a current, specific copy or content role',
   'Owner, founder, CEO, marketing leader, content lead, or creative director',
   'Established and actively producing marketing or client work',
   'Supports a four-figure project or ongoing monthly work',
   '["hiring-current","agency-client-workload","visible-growth-investment"]',
   '["hiring-current","published-request-for-help"]',
   '["icp-exclusion","no-supportable-route","role is stale or not actually a copy/content opening"]',
   '["public-job-posting","official-page","observed-date-recorded","exact-role-title"]',
   '["owner","founder","ceo","marketing-director","content-lead","creative-director"]',
   '["Your current careers page lists <exact role>","I can support one defined project while the workload is active"]',
   '["I know you cannot fill the role","your team is overwhelmed","you need to outsource","the posting proves budget"]',
   'Ask whether project support is relevant; offer a small defined first brief',
   'A short capabilities conversation or paid trial brief',
   '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z');
