-- Reachwright D1 schema · migration 0001 · 2026-07-15
-- Durable relational records for Scout + Qualify. KV is used only for
-- sessions, rate limits, and caches — never as the system of record.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- campaigns
CREATE TABLE IF NOT EXISTS campaigns (
  id               TEXT PRIMARY KEY,             -- immutable, rw-c-<ulid>
  owner            TEXT NOT NULL,
  name             TEXT NOT NULL,
  offer            TEXT NOT NULL,                -- offer + credible proof available today
  icp              TEXT NOT NULL,                -- ideal customer profile, prose
  geography        TEXT NOT NULL,
  positive_signals TEXT NOT NULL DEFAULT '[]',   -- JSON array of strings
  disqualifiers    TEXT NOT NULL DEFAULT '[]',   -- JSON array of strings
  min_economics    TEXT NOT NULL,                -- minimum customer economics, prose
  allowed_channels TEXT NOT NULL DEFAULT '[]',   -- JSON array: linkedin-manual|email|dm|phone
  max_batch_size   INTEGER NOT NULL DEFAULT 25 CHECK (max_batch_size BETWEEN 1 AND 100),
  voice_notes      TEXT NOT NULL DEFAULT '',     -- message voice, allowed and prohibited claims
  success_metric   TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'blocked-brief'
                   CHECK (status IN ('blocked-brief','researching','paused','closed')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- ------------------------------------------------------------ organizations
CREATE TABLE IF NOT EXISTS organizations (
  id                TEXT PRIMARY KEY,            -- rw-o-<ulid>
  normalized_domain TEXT,                        -- NULL allowed: domainless businesses exist
  normalized_name   TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  location          TEXT NOT NULL DEFAULT '',
  country           TEXT NOT NULL DEFAULT '',
  provider          TEXT NOT NULL DEFAULT '',    -- source provider of the base record
  provider_id       TEXT NOT NULL DEFAULT '',
  identity_keys     TEXT NOT NULL DEFAULT '[]',  -- JSON array of normalized fallback keys
  parent_org_id     TEXT REFERENCES organizations(id),
  duplicate_of      TEXT REFERENCES organizations(id),
  merge_state       TEXT NOT NULL DEFAULT 'active'
                    CHECK (merge_state IN ('active','merged','flagged')),
  first_seen        TEXT NOT NULL,
  last_verified     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_domain ON organizations(normalized_domain);
CREATE INDEX IF NOT EXISTS idx_org_name   ON organizations(normalized_name);

-- ------------------------------------------------------------------- people
CREATE TABLE IF NOT EXISTS people (
  id                 TEXT PRIMARY KEY,           -- rw-p-<ulid>
  organization_id    TEXT NOT NULL REFERENCES organizations(id),
  full_name          TEXT NOT NULL,
  title              TEXT NOT NULL DEFAULT '',
  seniority          TEXT NOT NULL DEFAULT '',
  business_email     TEXT NOT NULL DEFAULT '',   -- business contact field only
  email_status       TEXT NOT NULL DEFAULT 'unknown',
  business_phone     TEXT NOT NULL DEFAULT '',
  public_profile_url TEXT NOT NULL DEFAULT '',   -- business profile; manual-channel use only
  source_provider    TEXT NOT NULL DEFAULT '',
  provider_id        TEXT NOT NULL DEFAULT '',
  observed_at        TEXT NOT NULL,
  verification_state TEXT NOT NULL DEFAULT 'unverified'
                     CHECK (verification_state IN ('unverified','verified','stale','rejected')),
  do_not_contact     INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_people_org ON people(organization_id);

-- ----------------------------------------------------------- evidence_items
CREATE TABLE IF NOT EXISTS evidence_items (
  id                  TEXT PRIMARY KEY,          -- rw-e-<ulid>
  organization_id     TEXT NOT NULL REFERENCES organizations(id),
  person_id           TEXT REFERENCES people(id),
  campaign_id         TEXT REFERENCES campaigns(id),
  claim               TEXT NOT NULL,             -- the exact operational claim
  source_url          TEXT NOT NULL,
  observed_at         TEXT NOT NULL,             -- YYYY-MM-DD
  source_type         TEXT NOT NULL
                      CHECK (source_type IN ('first-party','authoritative-directory','secondary','weak','provider')),
  strength            TEXT NOT NULL
                      CHECK (strength IN ('first-party','authoritative-directory','secondary','weak')),
  contradiction_state TEXT NOT NULL DEFAULT 'none'
                      CHECK (contradiction_state IN ('none','contradicted','resolved')),
  reviewer_state      TEXT NOT NULL DEFAULT 'unreviewed'
                      CHECK (reviewer_state IN ('unreviewed','accepted','rejected')),
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_org ON evidence_items(organization_id);

-- --------------------------------------------------------------- fit_scores
-- Fit and evidence are separate rows (kind), never blended.
CREATE TABLE IF NOT EXISTS fit_scores (
  id              TEXT PRIMARY KEY,              -- rw-s-<ulid>
  campaign_id     TEXT NOT NULL REFERENCES campaigns(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  kind            TEXT NOT NULL CHECK (kind IN ('fit','evidence')),
  total           INTEGER NOT NULL CHECK (total BETWEEN 0 AND 100),
  rule_version    TEXT NOT NULL,
  factors         TEXT NOT NULL,                 -- JSON: [{factor, weight, input, points}]
  disqualifiers   TEXT NOT NULL DEFAULT '[]',    -- JSON array of {rule, reason}
  override_total  INTEGER CHECK (override_total BETWEEN 0 AND 100),
  override_reason TEXT,
  override_by     TEXT,
  scored_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scores_lookup ON fit_scores(campaign_id, organization_id, kind);

-- ------------------------------------------------------- suppression_entries
CREATE TABLE IF NOT EXISTS suppression_entries (
  id             TEXT PRIMARY KEY,               -- rw-x-<ulid>
  key_type       TEXT NOT NULL
                 CHECK (key_type IN ('email','domain','phone','handle','org','alias')),
  key_value      TEXT NOT NULL,                  -- normalized before insert
  reason         TEXT NOT NULL,
  source_channel TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  expires_at     TEXT                            -- NULL = permanent
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppress_key ON suppression_entries(key_type, key_value);

-- ------------------------------------------------------------ outreach_drafts
CREATE TABLE IF NOT EXISTS outreach_drafts (
  id              TEXT PRIMARY KEY,              -- rw-d-<ulid>
  campaign_id     TEXT NOT NULL REFERENCES campaigns(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  person_id       TEXT REFERENCES people(id),
  channel         TEXT NOT NULL,
  evidence_ids    TEXT NOT NULL DEFAULT '[]',    -- JSON array; every claim in body traces here
  model_provider  TEXT NOT NULL DEFAULT 'deterministic-template',
  model_version   TEXT NOT NULL DEFAULT 'n/a',
  prompt_version  TEXT NOT NULL DEFAULT 'n/a',
  body            TEXT NOT NULL,
  content_hash    TEXT NOT NULL,                 -- sha-256 of exact body
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','approved','ready-to-send','exported','sent','killed')),
  approved_at     TEXT,
  approved_by     TEXT,
  editor_history  TEXT NOT NULL DEFAULT '[]',    -- JSON: [{at, actor, content_hash, note}]
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drafts_campaign ON outreach_drafts(campaign_id, status);

-- ------------------------------------------------------------ approval_events
CREATE TABLE IF NOT EXISTS approval_events (
  id                         TEXT PRIMARY KEY,   -- rw-a-<ulid>
  subject_type               TEXT NOT NULL CHECK (subject_type IN ('dossier','draft','export')),
  subject_id                 TEXT NOT NULL,
  action                     TEXT NOT NULL CHECK (action IN ('approve','reject','revoke')),
  actor                      TEXT NOT NULL,
  reason                     TEXT NOT NULL DEFAULT '',
  packet_hash                TEXT NOT NULL DEFAULT '',  -- hash of the exact packet shown
  contacted_elsewhere_answer TEXT NOT NULL DEFAULT '',  -- required for draft approvals
  created_at                 TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_subject ON approval_events(subject_type, subject_id);

-- ----------------------------------------------------------- contact_attempts
CREATE TABLE IF NOT EXISTS contact_attempts (
  id              TEXT PRIMARY KEY,              -- rw-t-<ulid>
  campaign_id     TEXT NOT NULL REFERENCES campaigns(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  person_id       TEXT REFERENCES people(id),
  draft_id        TEXT REFERENCES outreach_drafts(id),
  channel         TEXT NOT NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
  status          TEXT NOT NULL
                  CHECK (status IN ('prepared','exported','sent','replied','positive-reply','opted-out','bounced','closed')),
  content_hash    TEXT NOT NULL DEFAULT '',
  notes           TEXT NOT NULL DEFAULT '',
  occurred_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_org ON contact_attempts(organization_id, occurred_at);

-- -------------------------------------------------------- qualification_flows
CREATE TABLE IF NOT EXISTS qualification_flows (
  id         TEXT PRIMARY KEY,                   -- rw-q-<ulid>
  name       TEXT NOT NULL,
  version    INTEGER NOT NULL,
  definition TEXT NOT NULL,                      -- JSON: questions, rules, verdicts, routes, fallback copy
  status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','inactive')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (name, version)
);

-- ----------------------------------------------------- qualification_sessions
CREATE TABLE IF NOT EXISTS qualification_sessions (
  id           TEXT PRIMARY KEY,                 -- server-generated session id (hash only, no PII)
  flow_id      TEXT REFERENCES qualification_flows(id),
  flow_version INTEGER,
  source       TEXT NOT NULL DEFAULT '',         -- attribution tag, no personal data
  started_at   TEXT NOT NULL,
  last_turn_at TEXT,
  turns        INTEGER NOT NULL DEFAULT 0,
  answers      TEXT NOT NULL DEFAULT '{}',       -- closed-enum answers only
  state        TEXT NOT NULL DEFAULT 'open'
               CHECK (state IN ('open','verdict','abandoned','human-review'))
);

-- ---------------------------------------------------- qualification_outcomes
CREATE TABLE IF NOT EXISTS qualification_outcomes (
  id         TEXT PRIMARY KEY,                   -- rw-v-<ulid>
  session_id TEXT NOT NULL REFERENCES qualification_sessions(id),
  verdict    TEXT NOT NULL CHECK (verdict IN ('strong','maybe','no','human-review')),
  factors    TEXT NOT NULL DEFAULT '[]',         -- JSON explanation
  routed_to  TEXT NOT NULL DEFAULT '',           -- booking|human|none
  created_at TEXT NOT NULL
);

-- ------------------------------------------------------------------ bookings
CREATE TABLE IF NOT EXISTS bookings (
  id                TEXT PRIMARY KEY,            -- rw-b-<ulid>
  campaign_id       TEXT REFERENCES campaigns(id),
  session_id        TEXT REFERENCES qualification_sessions(id),
  organization_id   TEXT REFERENCES organizations(id),
  provider          TEXT NOT NULL DEFAULT 'not-configured',
  provider_event_id TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL
                    CHECK (status IN ('booked','canceled','rescheduled','held','no-show')),
  scheduled_for     TEXT,                        -- ISO 8601 with offset
  timezone          TEXT NOT NULL DEFAULT '',
  attribution       TEXT NOT NULL DEFAULT '{}',  -- JSON: source/campaign/utm
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- -------------------------------------------------------------- audit_events
CREATE TABLE IF NOT EXISTS audit_events (
  id           TEXT PRIMARY KEY,                 -- rw-l-<ulid>
  actor        TEXT NOT NULL,
  action       TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  detail       TEXT NOT NULL DEFAULT '{}',       -- JSON, redacted: never secrets, never raw chats
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_events(created_at);

-- ------------------------------------------------------------ provider_usage
CREATE TABLE IF NOT EXISTS provider_usage (
  id                TEXT PRIMARY KEY,            -- rw-u-<ulid>
  provider          TEXT NOT NULL,
  operation         TEXT NOT NULL,
  request_count     INTEGER NOT NULL DEFAULT 1,
  credits_estimated REAL NOT NULL DEFAULT 0,
  credits_reported  REAL,
  campaign_id       TEXT REFERENCES campaigns(id),
  occurred_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_provider ON provider_usage(provider, occurred_at);
