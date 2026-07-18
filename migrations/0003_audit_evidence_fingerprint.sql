-- Reachwright D1 schema · migration 0003 · 2026-07-15
-- Dossier audits are valid only for the exact campaign evidence reviewed.

PRAGMA foreign_keys = ON;

ALTER TABLE dossier_audits ADD COLUMN evidence_hash TEXT NOT NULL DEFAULT '';
