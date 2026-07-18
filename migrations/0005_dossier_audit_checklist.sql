-- Reachwright D1 schema · migration 0005 · 2026-07-15
-- Accurate dossier audits retain the operator's required verification checks.

PRAGMA foreign_keys = ON;

ALTER TABLE dossier_audits ADD COLUMN checklist TEXT NOT NULL DEFAULT '{}';
