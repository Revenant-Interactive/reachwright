-- Reachwright D1 schema · migration 0008 · 2026-07-16
-- Client-owned market offers and traceable generation-to-sale attribution.
-- This remains a single-operator system; these records separate work and
-- reporting without pretending to be a client-facing multi-tenant portal.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS client_offers (
  id              TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL REFERENCES clients(id),
  name            TEXT NOT NULL,
  description     TEXT NOT NULL,
  ideal_customer  TEXT NOT NULL DEFAULT '',
  proof_points    TEXT NOT NULL DEFAULT '[]',
  economics_note  TEXT NOT NULL DEFAULT '',
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_client_offers_client
  ON client_offers(client_id, active, name);

INSERT OR IGNORE INTO client_offers
  (id, client_id, name, description, ideal_customer, proof_points, economics_note,
   active, created_at, updated_at)
VALUES
  ('rw-client-offer-growth-systems', 'rw-client-reemergence',
   'Reemergence growth-systems partnership',
   'Advisory and focused implementation that improves a business acquisition or conversion constraint.',
   'Owner-led small businesses with an observable growth constraint and the capacity to act.',
   '[]',
   'Commercial scope is selected separately in the protected Sales Console.',
   1, '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z');

ALTER TABLE campaigns ADD COLUMN client_offer_id TEXT;
ALTER TABLE campaigns ADD COLUMN client_offer_snapshot TEXT NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_campaigns_client_offer
  ON campaigns(client_id, client_offer_id);

ALTER TABLE bookings ADD COLUMN client_id TEXT NOT NULL DEFAULT 'rw-client-reemergence';
ALTER TABLE bookings ADD COLUMN generation_candidate_id TEXT;
CREATE INDEX IF NOT EXISTS idx_bookings_generation_attribution
  ON bookings(client_id, campaign_id, generation_candidate_id, payment_status);
