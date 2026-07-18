-- Reachwright D1 schema · migration 0004 · 2026-07-15
-- Fit/evidence scores are valid only for the exact campaign evidence scored.

PRAGMA foreign_keys = ON;

ALTER TABLE fit_scores ADD COLUMN evidence_hash TEXT NOT NULL DEFAULT '';
