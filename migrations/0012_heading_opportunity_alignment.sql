-- Reachwright D1 schema · migration 0012 · 2026-07-18
-- Align the taxonomy with the seeded Website & homepage messaging service:
-- a missing primary heading is a specific, first-party page-structure
-- observation and may anchor a review when capacity and reachability also pass.

PRAGMA foreign_keys = ON;

UPDATE signal_taxonomy
SET qualifying = 1,
    guidance = 'Qualifies only when tied to the exact reviewed page and mapped to Website & homepage messaging. Do not claim business or conversion harm.',
    updated_at = '2026-07-18T00:00:00.000Z'
WHERE signal_type = 'missing-primary-heading';
