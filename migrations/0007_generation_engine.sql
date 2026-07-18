-- Reachwright D1 schema · migration 0007 · 2026-07-16
-- Durable generation runs, evidence-led assessments, contact provenance,
-- client separation, and feedback-ready message attribution.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS clients (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  owner      TEXT NOT NULL DEFAULT 'michael',
  mode       TEXT NOT NULL DEFAULT 'internal'
             CHECK (mode IN ('internal','managed-client')),
  status     TEXT NOT NULL DEFAULT 'active'
             CHECK (status IN ('active','paused','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO clients (id, name, owner, mode, status, created_at, updated_at)
VALUES ('rw-client-reemergence', 'Reemergence Holdings', 'michael', 'internal', 'active',
        '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z');

-- SQLite cannot safely add a non-null foreign-key column with a non-null
-- default to an existing table. Route-level parent checks enforce this link.
ALTER TABLE campaigns ADD COLUMN client_id TEXT NOT NULL DEFAULT 'rw-client-reemergence';
CREATE INDEX IF NOT EXISTS idx_campaigns_client ON campaigns(client_id, status);

CREATE TABLE IF NOT EXISTS client_services (
  id              TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL REFERENCES clients(id),
  name            TEXT NOT NULL,
  description     TEXT NOT NULL,
  entry_angle     TEXT NOT NULL,
  signal_types    TEXT NOT NULL DEFAULT '[]',
  delivery_type   TEXT NOT NULL DEFAULT 'service'
                  CHECK (delivery_type IN ('consultation','diagnostic','sprint','retainer','service','custom')),
  public_rung     INTEGER NOT NULL DEFAULT 1 CHECK (public_rung IN (0,1)),
  priority        INTEGER NOT NULL DEFAULT 100,
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_client_services_client ON client_services(client_id, active, priority);

INSERT OR IGNORE INTO client_services
  (id, client_id, name, description, entry_angle, signal_types, delivery_type, public_rung, priority, active, created_at, updated_at)
VALUES
  ('rw-service-website-conversion', 'rw-client-reemergence', 'Website conversion build',
   'A focused website or landing-page improvement that makes the offer clearer and the next step easier to take.',
   'Lead with one observable website conversion constraint and offer a practical review.',
   '["missing-website","missing-mobile-viewport","missing-primary-cta","missing-contact-path","stale-copyright"]',
   'service', 1, 10, 1, '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z'),
  ('rw-service-conversion-copy', 'rw-client-reemergence', 'Conversion copy and positioning',
   'Clarify the promise, audience, proof, and call to action so qualified visitors understand why to respond.',
   'Lead with a specific messaging or offer-clarity observation, not a broad redesign pitch.',
   '["missing-page-title","missing-meta-description","missing-primary-heading","weak-offer-clarity"]',
   'service', 1, 20, 1, '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z'),
  ('rw-service-lead-automation', 'rw-client-reemergence', 'Lead capture and follow-up automation',
   'Connect inquiry, qualification, booking, and follow-up steps without removing human control.',
   'Lead with the missing or high-friction next step visible on the company site.',
   '["missing-form","missing-booking-path","missing-chat-path","manual-only-contact"]',
   'service', 1, 30, 1, '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z'),
  ('rw-service-growth-diagnostic', 'rw-client-reemergence', 'Growth-systems diagnostic',
   'A paid diagnosis of the acquisition and conversion system with a prioritized action plan.',
   'Use when several connected constraints are visible and a build recommendation would be premature.',
   '["multiple-connected-gaps","conflicting-evidence","unclear-primary-constraint"]',
   'diagnostic', 1, 40, 1, '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z'),
  ('rw-service-custom-platform', 'rw-client-reemergence', 'Custom platform or AI workflow',
   'A separately scoped internal tool, customer workflow, or AI-assisted operating system.',
   'Lead only from a concrete workflow constraint supported by evidence.',
   '["workflow-bottleneck","manual-repetitive-process","platform-opportunity"]',
   'custom', 1, 50, 1, '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z');

CREATE TABLE IF NOT EXISTS generation_runs (
  id                TEXT PRIMARY KEY,
  client_id         TEXT NOT NULL REFERENCES clients(id),
  campaign_id       TEXT NOT NULL REFERENCES campaigns(id),
  target_ready      INTEGER NOT NULL DEFAULT 5 CHECK (target_ready BETWEEN 1 AND 10),
  candidate_cap     INTEGER NOT NULL DEFAULT 25 CHECK (candidate_cap BETWEEN 5 AND 50),
  credit_budget     REAL NOT NULL DEFAULT 10 CHECK (credit_budget BETWEEN 0 AND 1000),
  status            TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','discovering','researching','paused','partial','completed','failed','canceled')),
  source_plan       TEXT NOT NULL DEFAULT '[]',
  query_snapshot    TEXT NOT NULL DEFAULT '{}',
  counts            TEXT NOT NULL DEFAULT '{}',
  failure_code      TEXT NOT NULL DEFAULT '',
  last_error        TEXT NOT NULL DEFAULT '',
  started_at        TEXT NOT NULL,
  completed_at      TEXT,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_generation_runs_campaign ON generation_runs(campaign_id, started_at);
CREATE INDEX IF NOT EXISTS idx_generation_runs_client ON generation_runs(client_id, started_at);

CREATE TABLE IF NOT EXISTS generation_candidates (
  id                    TEXT PRIMARY KEY,
  run_id                TEXT NOT NULL REFERENCES generation_runs(id),
  campaign_id           TEXT NOT NULL REFERENCES campaigns(id),
  organization_id       TEXT NOT NULL REFERENCES organizations(id),
  stage                 TEXT NOT NULL DEFAULT 'discovered'
                        CHECK (stage IN ('discovered','researching','contact-found','qualified','message-ready','rejected','failed')),
  primary_person_id     TEXT REFERENCES people(id),
  contact_route_id      TEXT,
  primary_signal_id     TEXT,
  recommended_service_id TEXT REFERENCES client_services(id),
  fit_recommendation    TEXT NOT NULL DEFAULT '{}',
  evidence_recommendation TEXT NOT NULL DEFAULT '{}',
  audit_recommendation  TEXT NOT NULL DEFAULT '{}',
  qualification_rationale TEXT NOT NULL DEFAULT '',
  confidence            INTEGER NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 100),
  rejection_reason      TEXT NOT NULL DEFAULT '',
  attempt_count         INTEGER NOT NULL DEFAULT 0,
  last_error            TEXT NOT NULL DEFAULT '',
  discovery_sources     TEXT NOT NULL DEFAULT '[]',
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (run_id, organization_id)
);
CREATE INDEX IF NOT EXISTS idx_generation_candidates_run ON generation_candidates(run_id, stage, updated_at);

CREATE TABLE IF NOT EXISTS website_research (
  id                   TEXT PRIMARY KEY,
  run_id               TEXT NOT NULL REFERENCES generation_runs(id),
  organization_id      TEXT NOT NULL REFERENCES organizations(id),
  source_url           TEXT NOT NULL,
  final_url            TEXT NOT NULL DEFAULT '',
  http_status          INTEGER,
  content_hash         TEXT NOT NULL DEFAULT '',
  page_title           TEXT NOT NULL DEFAULT '',
  meta_description     TEXT NOT NULL DEFAULT '',
  primary_heading      TEXT NOT NULL DEFAULT '',
  has_viewport         INTEGER NOT NULL DEFAULT 0 CHECK (has_viewport IN (0,1)),
  has_form             INTEGER NOT NULL DEFAULT 0 CHECK (has_form IN (0,1)),
  has_primary_cta      INTEGER NOT NULL DEFAULT 0 CHECK (has_primary_cta IN (0,1)),
  has_booking_path     INTEGER NOT NULL DEFAULT 0 CHECK (has_booking_path IN (0,1)),
  has_phone_path       INTEGER NOT NULL DEFAULT 0 CHECK (has_phone_path IN (0,1)),
  has_email_path       INTEGER NOT NULL DEFAULT 0 CHECK (has_email_path IN (0,1)),
  has_chat_path        INTEGER NOT NULL DEFAULT 0 CHECK (has_chat_path IN (0,1)),
  copyright_year       INTEGER,
  status               TEXT NOT NULL CHECK (status IN ('fetched','failed','blocked')),
  error_code           TEXT NOT NULL DEFAULT '',
  inspected_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_website_research_org ON website_research(run_id, organization_id, inspected_at);

CREATE TABLE IF NOT EXISTS opportunity_signals (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES generation_runs(id),
  campaign_id     TEXT NOT NULL REFERENCES campaigns(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  signal_type     TEXT NOT NULL,
  claim           TEXT NOT NULL,
  source_url      TEXT NOT NULL,
  evidence_id     TEXT NOT NULL REFERENCES evidence_items(id),
  confidence      INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  service_id      TEXT REFERENCES client_services(id),
  review_state    TEXT NOT NULL DEFAULT 'proposed'
                  CHECK (review_state IN ('proposed','confirmed','rejected')),
  detected_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signals_candidate ON opportunity_signals(run_id, organization_id, confidence);

CREATE TABLE IF NOT EXISTS contact_routes (
  id                 TEXT PRIMARY KEY,
  organization_id    TEXT NOT NULL REFERENCES organizations(id),
  person_id          TEXT NOT NULL REFERENCES people(id),
  route_type         TEXT NOT NULL CHECK (route_type IN ('email','linkedin','phone','dm','contact-page')),
  route_value        TEXT NOT NULL,
  source_url         TEXT NOT NULL DEFAULT '',
  verification_state TEXT NOT NULL
                     CHECK (verification_state IN ('provider-verified','provider-reported','first-party','syntax-only','operator-verified','conflicted','rejected')),
  confidence         INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  observed_at        TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (person_id, route_type, route_value)
);
CREATE INDEX IF NOT EXISTS idx_contact_routes_org ON contact_routes(organization_id, verification_state, confidence);

CREATE TABLE IF NOT EXISTS strategic_message_options (
  id                    TEXT PRIMARY KEY,
  run_id                TEXT NOT NULL REFERENCES generation_runs(id),
  candidate_id          TEXT NOT NULL REFERENCES generation_candidates(id),
  campaign_id           TEXT NOT NULL REFERENCES campaigns(id),
  organization_id       TEXT NOT NULL REFERENCES organizations(id),
  person_id             TEXT NOT NULL REFERENCES people(id),
  channel               TEXT NOT NULL,
  strategy              TEXT NOT NULL,
  service_id            TEXT NOT NULL REFERENCES client_services(id),
  opportunity_signal_id TEXT NOT NULL REFERENCES opportunity_signals(id),
  evidence_ids          TEXT NOT NULL DEFAULT '[]',
  body                  TEXT NOT NULL,
  content_hash          TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'proposed'
                        CHECK (status IN ('proposed','selected','rejected','converted')),
  converted_draft_id    TEXT REFERENCES outreach_drafts(id),
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_options_candidate ON strategic_message_options(candidate_id, status);

CREATE TABLE IF NOT EXISTS prospect_packets (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES generation_runs(id),
  candidate_id    TEXT NOT NULL REFERENCES generation_candidates(id),
  campaign_id     TEXT NOT NULL REFERENCES campaigns(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  person_id       TEXT NOT NULL REFERENCES people(id),
  payload         TEXT NOT NULL,
  packet_hash     TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'operator-review'
                  CHECK (status IN ('operator-review','approved','rejected','stale')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (candidate_id)
);
CREATE INDEX IF NOT EXISTS idx_prospect_packets_run ON prospect_packets(run_id, status);

CREATE TABLE IF NOT EXISTS generation_events (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES generation_runs(id),
  candidate_id      TEXT REFERENCES generation_candidates(id),
  provider          TEXT NOT NULL DEFAULT '',
  stage             TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('started','succeeded','failed','skipped','retrying')),
  error_code        TEXT NOT NULL DEFAULT '',
  retryable         INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0,1)),
  detail            TEXT NOT NULL DEFAULT '{}',
  credits_estimated REAL NOT NULL DEFAULT 0,
  occurred_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_generation_events_run ON generation_events(run_id, occurred_at);

ALTER TABLE outreach_drafts ADD COLUMN generation_candidate_id TEXT;
ALTER TABLE outreach_drafts ADD COLUMN message_option_id TEXT;
ALTER TABLE outreach_drafts ADD COLUMN service_id TEXT;
ALTER TABLE outreach_drafts ADD COLUMN strategy TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_drafts_generation_candidate
  ON outreach_drafts(generation_candidate_id, status);
