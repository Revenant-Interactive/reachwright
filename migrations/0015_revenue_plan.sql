-- Reachwright D1 schema · migration 0015 · 2026-07-18
-- Owner-controlled revenue target and explicit funnel-planning assumptions.
-- Actual pipeline and revenue remain derived from audited operational records.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS revenue_plan (
  id                                      TEXT PRIMARY KEY CHECK (id = 'owner'),
  target_mrr_cents                        INTEGER NOT NULL CHECK (target_mrr_cents BETWEEN 100000 AND 100000000),
  average_client_mrr_cents                INTEGER NOT NULL CHECK (average_client_mrr_cents BETWEEN 10000 AND 10000000),
  assumed_held_call_close_rate            REAL NOT NULL CHECK (assumed_held_call_close_rate > 0 AND assumed_held_call_close_rate <= 1),
  assumed_booking_show_rate               REAL NOT NULL CHECK (assumed_booking_show_rate > 0 AND assumed_booking_show_rate <= 1),
  assumed_positive_reply_to_booking_rate  REAL NOT NULL CHECK (assumed_positive_reply_to_booking_rate > 0 AND assumed_positive_reply_to_booking_rate <= 1),
  assumed_outreach_to_positive_reply_rate REAL NOT NULL CHECK (assumed_outreach_to_positive_reply_rate > 0 AND assumed_outreach_to_positive_reply_rate <= 1),
  weekly_outreach_days                    INTEGER NOT NULL CHECK (weekly_outreach_days BETWEEN 1 AND 7),
  updated_at                              TEXT NOT NULL
);

INSERT OR IGNORE INTO revenue_plan
  (id, target_mrr_cents, average_client_mrr_cents,
   assumed_held_call_close_rate, assumed_booking_show_rate,
   assumed_positive_reply_to_booking_rate, assumed_outreach_to_positive_reply_rate,
   weekly_outreach_days, updated_at)
VALUES
  ('owner', 1000000, 150000, 0.25, 0.70, 0.50, 0.10, 5,
   '2026-07-18T00:00:00.000Z');
