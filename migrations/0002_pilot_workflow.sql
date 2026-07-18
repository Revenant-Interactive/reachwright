-- Reachwright D1 schema · migration 0002 · 2026-07-15
-- Manual-first pilot audit and outreach-frequency controls.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS dossier_audits (
  id              TEXT PRIMARY KEY,
  campaign_id     TEXT NOT NULL REFERENCES campaigns(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  verdict         TEXT NOT NULL CHECK (verdict IN ('accurate','partly-accurate','reject')),
  notes           TEXT NOT NULL DEFAULT '',
  auditor         TEXT NOT NULL DEFAULT 'operator',
  audited_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dossier_audits_lookup
  ON dossier_audits(campaign_id, organization_id, audited_at);

ALTER TABLE outreach_drafts ADD COLUMN outreach_kind TEXT NOT NULL DEFAULT 'initial'
  CHECK (outreach_kind IN ('initial','follow-up'));
