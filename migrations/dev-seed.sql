-- DEV/TEST SEED ONLY — never apply to production (deployment doc enforces this).
-- One sample campaign so the operator app has something to click on first run.

INSERT OR IGNORE INTO campaigns (
  id, owner, name, offer, icp, geography, positive_signals, disqualifiers,
  min_economics, allowed_channels, max_batch_size, voice_notes, success_metric,
  status, created_at, updated_at
) VALUES (
  'rw-c-devseed0000000001', 'michael', 'DEV SEED — local pilot',
  'We book qualified sales calls for service businesses without landing pages',
  'local service businesses, 5–50 employees, already spending on ads',
  'Illinois', '["running paid ads","hiring"]', '["franchise HQ","under $500 customer value"]',
  'customer value >= $2,000', '["linkedin-manual","dm"]', 10,
  'plain, respectful, evidence-only', '5 audited dossiers', 'blocked-brief',
  '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z'
);
