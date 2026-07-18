-- Local-only compatibility shim for databases initialized before Reachwright
-- switched to Wrangler's migration ledger. On a fresh database both SELECTs
-- are false, so Wrangler applies every migration normally. On an existing
-- local database they mark only the schema changes that are already present.

CREATE TABLE IF NOT EXISTS d1_migrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

INSERT OR IGNORE INTO d1_migrations (name)
SELECT '0001_init.sql'
WHERE EXISTS (
  SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'campaigns'
);

INSERT OR IGNORE INTO d1_migrations (name)
SELECT '0002_pilot_workflow.sql'
WHERE EXISTS (
  SELECT 1 FROM pragma_table_info('outreach_drafts') WHERE name = 'outreach_kind'
);

INSERT OR IGNORE INTO d1_migrations (name)
SELECT '0003_audit_evidence_fingerprint.sql'
WHERE EXISTS (
  SELECT 1 FROM pragma_table_info('dossier_audits') WHERE name = 'evidence_hash'
);

INSERT OR IGNORE INTO d1_migrations (name)
SELECT '0004_score_evidence_fingerprint.sql'
WHERE EXISTS (
  SELECT 1 FROM pragma_table_info('fit_scores') WHERE name = 'evidence_hash'
);

INSERT OR IGNORE INTO d1_migrations (name)
SELECT '0005_dossier_audit_checklist.sql'
WHERE EXISTS (
  SELECT 1 FROM pragma_table_info('dossier_audits') WHERE name = 'checklist'
);

INSERT OR IGNORE INTO d1_migrations (name)
SELECT '0006_sales_call_console.sql'
WHERE EXISTS (
  SELECT 1 FROM pragma_table_info('bookings') WHERE name = 'agreement_status'
);

INSERT OR IGNORE INTO d1_migrations (name)
SELECT '0007_generation_engine.sql'
WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'generation_runs')
  AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'prospect_packets')
  AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'contact_routes')
  AND EXISTS (SELECT 1 FROM pragma_table_info('campaigns') WHERE name = 'client_id')
  AND EXISTS (SELECT 1 FROM pragma_table_info('outreach_drafts') WHERE name = 'generation_candidate_id');

INSERT OR IGNORE INTO d1_migrations (name)
SELECT '0008_client_attribution_and_feedback.sql'
WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'client_offers')
  AND EXISTS (SELECT 1 FROM pragma_table_info('campaigns') WHERE name = 'client_offer_snapshot')
  AND EXISTS (SELECT 1 FROM pragma_table_info('bookings') WHERE name = 'generation_candidate_id')
  AND EXISTS (SELECT 1 FROM pragma_table_info('bookings') WHERE name = 'client_id');

INSERT OR IGNORE INTO d1_migrations (name)
SELECT '0009_generation_quality_evidence.sql'
WHERE EXISTS (SELECT 1 FROM pragma_table_info('organizations') WHERE name = 'employee_range')
  AND EXISTS (SELECT 1 FROM pragma_table_info('people') WHERE name = 'role_source_url')
  AND EXISTS (SELECT 1 FROM pragma_table_info('website_research') WHERE name = 'has_contact_page')
  AND EXISTS (SELECT 1 FROM pragma_table_info('generation_candidates') WHERE name = 'market_fit_recommendation');
