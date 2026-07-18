-- Reachwright D1 schema · migration 0006 · 2026-07-16
-- Extends the existing bookings record with an operator-only sales-call
-- workspace. Call, agreement, and payment truth remain independent.

ALTER TABLE bookings ADD COLUMN prospect_name TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN prospect_title TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN business_name TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN company_website TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN linkedin_profile_url TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN sales_source TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN source_context TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN discovery_notes TEXT NOT NULL DEFAULT '{}';
ALTER TABLE bookings ADD COLUMN call_summary TEXT NOT NULL DEFAULT '';

ALTER TABLE bookings ADD COLUMN offer_id TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN offer_snapshot TEXT NOT NULL DEFAULT '{}';
ALTER TABLE bookings ADD COLUMN offer_locked_at TEXT;

ALTER TABLE bookings ADD COLUMN agreement_status TEXT NOT NULL DEFAULT 'not-required'
  CHECK (agreement_status IN ('not-required','not-sent','sent','signed'));
ALTER TABLE bookings ADD COLUMN agreement_sent_at TEXT;
ALTER TABLE bookings ADD COLUMN agreement_signed_at TEXT;
ALTER TABLE bookings ADD COLUMN agreement_note TEXT NOT NULL DEFAULT '';

ALTER TABLE bookings ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'not-required'
  CHECK (payment_status IN ('not-required','not-sent','link-shared','invoice-sent','operator-confirmed-paid'));
ALTER TABLE bookings ADD COLUMN payment_link_shared_at TEXT;
ALTER TABLE bookings ADD COLUMN payment_dispatch_note TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN payment_confirmed_at TEXT;
ALTER TABLE bookings ADD COLUMN payment_confirmation_note TEXT NOT NULL DEFAULT '';

-- Archive instead of erasing a commercial record or its audit history.
ALTER TABLE bookings ADD COLUMN archived_at TEXT;

CREATE INDEX IF NOT EXISTS idx_bookings_sales_calls
  ON bookings(sales_source, scheduled_for, archived_at);
