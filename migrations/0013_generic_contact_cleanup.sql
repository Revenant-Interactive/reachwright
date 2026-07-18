-- Reachwright D1 schema · migration 0013 · 2026-07-18
-- Provider rows such as "Client Services" are departmental labels, not
-- decision-makers. Reject any persisted packet built on one of these exact
-- generic names; future ingestion also filters them before storage.

PRAGMA foreign_keys = ON;

UPDATE people
SET verification_state = 'rejected', do_not_contact = 1, updated_at = '2026-07-18T00:00:00.000Z'
WHERE LOWER(TRIM(full_name)) IN
  ('client services','customer service','customer services','sales team','marketing team',
   'support team','contact team','business development','general office');

UPDATE prospect_packets
SET status = 'rejected', updated_at = '2026-07-18T00:00:00.000Z'
WHERE person_id IN (SELECT id FROM people WHERE verification_state = 'rejected' AND do_not_contact = 1);

UPDATE generation_candidates
SET stage = 'rejected', rejection_reason = 'invalid-generic-contact',
    updated_at = '2026-07-18T00:00:00.000Z'
WHERE primary_person_id IN
  (SELECT id FROM people WHERE verification_state = 'rejected' AND do_not_contact = 1);
