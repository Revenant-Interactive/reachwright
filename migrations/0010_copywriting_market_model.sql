-- Reachwright D1 schema · migration 0010 · 2026-07-17
-- Copywriting market model: an editable service catalog with full targeting
-- and claim rules, a five-dimension signal taxonomy, and a deterministic
-- multi-dimension scoring model. Nothing here removes or rewrites existing
-- services; new columns default safely and new catalogs sit beside old rows.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- services
-- The copywriting model needs far more per service than name + signals.
-- All columns default so existing rows remain valid.

ALTER TABLE client_services ADD COLUMN target_business_type     TEXT NOT NULL DEFAULT '';
ALTER TABLE client_services ADD COLUMN target_buyer             TEXT NOT NULL DEFAULT '';
ALTER TABLE client_services ADD COLUMN company_stage            TEXT NOT NULL DEFAULT '';
ALTER TABLE client_services ADD COLUMN minimum_commercial_value TEXT NOT NULL DEFAULT '';
ALTER TABLE client_services ADD COLUMN capacity_indicators      TEXT NOT NULL DEFAULT '[]';
ALTER TABLE client_services ADD COLUMN buying_triggers          TEXT NOT NULL DEFAULT '[]';
ALTER TABLE client_services ADD COLUMN service_disqualifiers    TEXT NOT NULL DEFAULT '[]';
ALTER TABLE client_services ADD COLUMN required_evidence        TEXT NOT NULL DEFAULT '[]';
ALTER TABLE client_services ADD COLUMN contact_roles            TEXT NOT NULL DEFAULT '[]';
ALTER TABLE client_services ADD COLUMN permitted_claims         TEXT NOT NULL DEFAULT '[]';
ALTER TABLE client_services ADD COLUMN prohibited_claims        TEXT NOT NULL DEFAULT '[]';
ALTER TABLE client_services ADD COLUMN typical_cta              TEXT NOT NULL DEFAULT '';
ALTER TABLE client_services ADD COLUMN next_step                TEXT NOT NULL DEFAULT '';

-- ------------------------------------------------------- signal taxonomy
-- Five separated dimensions. Every signal is structured, editable data —
-- not a hard-coded list in source. `qualifying` marks signals that may
-- anchor an outreach angle (copy-opportunity dimension only).

CREATE TABLE IF NOT EXISTS signal_taxonomy (
  id                  TEXT PRIMARY KEY,
  dimension           TEXT NOT NULL CHECK (dimension IN
                        ('icp-fit','copy-opportunity','buying-trigger','evidence-quality','reachability')),
  signal_type         TEXT NOT NULL UNIQUE,
  label               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  observable_asset    TEXT NOT NULL DEFAULT '',
  detection           TEXT NOT NULL DEFAULT 'manual' CHECK (detection IN ('automated','manual','either')),
  default_confidence  INTEGER NOT NULL DEFAULT 70 CHECK (default_confidence BETWEEN 0 AND 100),
  recency_window_days INTEGER NOT NULL DEFAULT 60 CHECK (recency_window_days BETWEEN 1 AND 365),
  qualifying          INTEGER NOT NULL DEFAULT 0 CHECK (qualifying IN (0,1)),
  guidance            TEXT NOT NULL DEFAULT '',
  active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signal_taxonomy_dimension ON signal_taxonomy(dimension, active);

-- ------------------------------------------------------------ ICP fit
INSERT OR IGNORE INTO signal_taxonomy
  (id, dimension, signal_type, label, description, observable_asset, detection, default_confidence, recency_window_days, qualifying, guidance, active, created_at, updated_at)
VALUES
  ('rw-sig-industry-match','icp-fit','industry-match','Industry match','The business operates in an industry named by the campaign ICP.','Official site, directory listing, or provider company profile','either',80,180,0,'Verify against the official site, not only a provider tag.',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-geography-match','icp-fit','geography-match','Geography match','The business operates in or serves the campaign geography.','Official site contact/location page or verified directory','either',80,180,0,'Service-area businesses may serve the geography without an address in it.',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-business-model-match','icp-fit','business-model-match','Business-model match','The business model (B2B, B2C, agency, local service, e-commerce) matches what the service targets.','Official site offer pages','manual',75,180,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-company-size-match','icp-fit','company-size-match','Company-size match','Observable size (team page, provider headcount range) is inside the campaign range.','Team page or provider company profile','either',65,180,0,'Provider headcounts are estimates; mark unknown when unsupported.',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-service-value-match','icp-fit','service-value-match','Service-value match','The business sells something whose value plausibly supports the service minimum engagement.','Public pricing, offer pages, or industry norms stated as inference','manual',60,180,0,'Price inference from industry norms must be labeled an inference.',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-customer-value-match','icp-fit','customer-value-match','Customer-value match','The business''s customer value (ticket size, LTV band) plausibly funds professional copywriting.','Public pricing or offer structure','manual',60,180,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-operating-capacity','icp-fit','operating-capacity-visible','Operating capacity visible','The business shows signs of active operation: current hours, recent posts, active offers.','Official site, business profile, recent public activity','either',70,90,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-icp-exclusion','icp-fit','icp-exclusion','ICP exclusion present','The business matches a campaign exclusion (franchise HQ, mature in-house team, incompatible industry).','Any cited source','either',85,180,0,'An exclusion is a disqualifier, not a low score.',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z');

-- ---------------------------------------------------- copy opportunity
-- Observable conditions tied to a specific public asset or event.
-- Labels stay respectful: they describe what was observed, never a verdict
-- on the prospect's competence.
INSERT OR IGNORE INTO signal_taxonomy
  (id, dimension, signal_type, label, description, observable_asset, detection, default_confidence, recency_window_days, qualifying, guidance, active, created_at, updated_at)
VALUES
  ('rw-sig-ad-page-mismatch','copy-opportunity','ad-to-page-mismatch','Message-match opportunity','An active advertisement and its destination page emphasize materially different offers.','The ad creative and the landing page it links to','manual',80,30,1,'Quote both the ad text and the page heading; the mismatch must be observable, not felt.',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-unclear-offer','copy-opportunity','unclear-offer-rubric','Value proposition requires review','Under the written messaging rubric, the reviewed page does not state who the offer serves, what it does, or why to act.','A specific reviewed page','manual',70,60,1,'Apply the rubric; record which rubric items were not found. Never describe the writing as bad.',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-missing-primary-cta','copy-opportunity','missing-primary-cta','CTA not found on reviewed page','No contact, quote, booking, consultation, purchase, or get-started call to action was detected on the reviewed page.','The reviewed page HTML','automated',78,60,1,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-launch-no-asset','copy-opportunity','launch-without-conversion-asset','Launch asset opportunity','A new product, service, or location was announced but no corresponding conversion asset was found.','The announcement and the page it should lead to','manual',75,45,1,'Cite the announcement URL and the reviewed destination.',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-rebrand-messaging','copy-opportunity','rebrand-messaging-update','Rebrand messaging opportunity','A public rebrand creates an observable need to update messaging across public assets.','Rebrand announcement plus current public pages','manual',75,60,1,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-expansion-materials','copy-opportunity','expansion-acquisition-materials','Expansion acquisition-materials opportunity','An expansion or new location requires new acquisition materials that were not found.','Expansion announcement plus current public pages','manual',72,60,1,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-hiring-copy-roles','copy-opportunity','hiring-copy-content-roles','Hiring for copy, content, lifecycle, growth, or marketing','A current public job posting shows investment in copy, content, lifecycle, growth, or marketing work.','A public job posting','either',85,30,1,'A posting is evidence of investment, not of dissatisfaction with current work.',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-copy-help-request','copy-opportunity','public-copy-help-request','Public request for copywriting support','The business publicly asked for copywriting or marketing help.','A public post or listing','manual',90,21,1,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-proof-not-visible','copy-opportunity','proof-not-visible','Proof-placement opportunity','Customer proof exists publicly (reviews, named clients, case results) but is not visibly used on the reviewed conversion page.','Review platforms plus the reviewed conversion page','manual',72,60,1,'Both halves must be cited: where the proof lives and the page where it was not found.',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-agency-overflow','copy-opportunity','agency-overflow-request','Agency overflow / white-label request','An agency publicly seeks overflow or white-label copywriting support.','A public post, listing, or partner page','manual',88,30,1,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-inconsistent-positioning','copy-opportunity','inconsistent-positioning','Positioning consistency opportunity','Public channels describe the same offer in materially different ways.','Two or more cited public pages or profiles','manual',68,90,1,'Quote the differing descriptions; inconsistency must be shown, not asserted.',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-nurture-path','copy-opportunity','nurture-path-missing','Nurture-path opportunity','Lead capture exists but no observable follow-up or nurture path (welcome content, sequence signup confirmation) was found.','The reviewed signup flow','manual',62,90,1,'Only observable from public assets; internal email flows are unknowable and stay unknown.',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z');

-- Existing automated website detectors join the taxonomy so every signal the
-- engine emits resolves to one editable row.
INSERT OR IGNORE INTO signal_taxonomy
  (id, dimension, signal_type, label, description, observable_asset, detection, default_confidence, recency_window_days, qualifying, guidance, active, created_at, updated_at)
VALUES
  ('rw-sig-missing-lead-capture','copy-opportunity','missing-lead-capture','Lead-capture path not found','No form, booking path, phone link, email link, or contact page was detected across the reviewed official pages.','Reviewed official pages','automated',92,60,1,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-manual-only-contact','copy-opportunity','manual-only-contact','Direct-contact-only path','The reviewed pages expose a direct phone or email path but no form or booking path.','Reviewed official pages','automated',76,60,1,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-missing-mobile-viewport','copy-opportunity','missing-mobile-viewport','Mobile viewport not found','The homepage HTML does not declare a mobile viewport.','Homepage HTML','automated',90,90,1,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-missing-page-title','copy-opportunity','missing-page-title','Page title not found','The reviewed page does not provide a non-empty HTML title.','Reviewed page HTML','automated',95,90,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-missing-meta-description','copy-opportunity','missing-meta-description','Meta description not found','The reviewed page does not provide a meta description.','Reviewed page HTML','automated',90,90,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-missing-primary-heading','copy-opportunity','missing-primary-heading','Primary heading not found','The reviewed page does not contain a detectable H1 heading.','Reviewed page HTML','automated',85,90,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-missing-form','copy-opportunity','missing-form','Form not found on reviewed pages','No HTML form was detected across the reviewed official pages.','Reviewed official pages','automated',82,60,0,'Weak alone; combine with missing-lead-capture or manual-only-contact.',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-missing-booking-path','copy-opportunity','missing-booking-path','Booking path not found','No booking or scheduling path was detected across the reviewed official pages.','Reviewed official pages','automated',72,60,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-stale-copyright','copy-opportunity','stale-copyright','Copyright year appears stale','The homepage displays a copyright year three or more years old.','Homepage footer','automated',70,90,0,'Supporting signal only; sites are often maintained without the year changing.',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-missing-website','copy-opportunity','missing-website','Official website not found','No official website could be located for the business.','Search and directory checks','either',80,90,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-missing-contact-path','copy-opportunity','missing-contact-path','Contact path not found','No usable contact path was detected on the reviewed pages.','Reviewed official pages','automated',80,60,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-weak-offer-clarity','copy-opportunity','weak-offer-clarity','Offer clarity requires review','The reviewed pages describe services without a clear primary offer under the messaging rubric.','Reviewed official pages','manual',65,90,1,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-multiple-gaps','copy-opportunity','multiple-connected-gaps','Multiple connected gaps observed','Several related conversion gaps are observable at once.','Reviewed official pages','manual',70,60,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-conflicting-evidence','copy-opportunity','conflicting-evidence','Conflicting evidence recorded','Public sources conflict about the business''s offer or status.','Two or more cited sources','manual',60,60,0,'Route to diagnostic conversations, not confident pitches.',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-unclear-constraint','copy-opportunity','unclear-primary-constraint','Primary constraint unclear','Evidence shows friction but no single constraint stands out.','Reviewed evidence ledger','manual',60,60,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-workflow-bottleneck','copy-opportunity','workflow-bottleneck','Workflow bottleneck observed','A public statement or posting describes a concrete internal workflow constraint.','A cited public statement','manual',65,60,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-manual-repetitive','copy-opportunity','manual-repetitive-process','Manual repetitive process observed','Public evidence shows a repetitive manual process a workflow could support.','A cited public source','manual',60,90,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-platform-opportunity','copy-opportunity','platform-opportunity','Platform opportunity observed','Public evidence supports a separately scoped platform or tool conversation.','A cited public source','manual',55,90,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z');

-- ---------------------------------------------------- buying trigger / capacity
INSERT OR IGNORE INTO signal_taxonomy
  (id, dimension, signal_type, label, description, observable_asset, detection, default_confidence, recency_window_days, qualifying, guidance, active, created_at, updated_at)
VALUES
  ('rw-sig-active-ads','buying-trigger','active-paid-advertising','Active paid advertising','The business is currently running paid advertisements.','Ad library entry or observed active ad','either',90,14,0,'Cite the ad library URL and observation date. Says nothing about spend or results.',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-hiring-current','buying-trigger','hiring-current','Currently hiring','The business has current public job postings.','Public job posting','either',85,30,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-new-funding','buying-trigger','new-funding','New funding announced','A funding round was publicly announced.','Official or reputable third-party announcement','manual',85,90,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-expansion','buying-trigger','expansion-announced','Expansion announced','The business publicly announced an expansion.','Official announcement','manual',80,90,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-new-location','buying-trigger','new-location','New location','A new location opened or was announced.','Official announcement or updated location page','manual',80,90,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-product-launch','buying-trigger','product-launch','Product or service launch','A new product or service was publicly launched.','Official announcement or launch page','manual',80,60,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-rebrand','buying-trigger','rebrand-announced','Rebrand announced','The business publicly announced or visibly executed a rebrand.','Official announcement or observable brand change','manual',75,90,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-new-marketing-leader','buying-trigger','new-marketing-leader','New marketing leader','A new marketing, growth, or brand leader was publicly announced.','Official announcement or public profile update','manual',80,90,0,'New leaders review messaging early; contact respectfully.',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-leadgen-active','buying-trigger','lead-gen-infrastructure-active','Active lead-gen infrastructure','Observable investment in lead generation: landing pages, booking flows, gated offers.','Reviewed public pages','either',70,60,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-high-value-offer','buying-trigger','high-value-offer','High-value offer','The business sells a high-ticket offer where copy improvements plausibly pay for themselves.','Public pricing or offer pages','manual',65,180,0,'Value inference must be labeled inference.',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-growth-investment','buying-trigger','visible-growth-investment','Visible growth investment','Observable spending on growth: events, sponsorships, content programs, tools.','Cited public sources','manual',65,90,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-agency-workload','buying-trigger','agency-client-workload','Agency client workload','An agency shows a visible client roster or workload consistent with overflow needs.','Agency site portfolio or public statements','manual',65,90,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-published-help-request','buying-trigger','published-request-for-help','Published request for outside help','The business publicly asked for outside marketing or copy support.','A public post or listing','manual',90,21,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z');

-- ---------------------------------------------------- evidence quality
INSERT OR IGNORE INTO signal_taxonomy
  (id, dimension, signal_type, label, description, observable_asset, detection, default_confidence, recency_window_days, qualifying, guidance, active, created_at, updated_at)
VALUES
  ('rw-sig-official-page','evidence-quality','official-page','Official page','The claim is supported by the business''s own website.','Official site URL','either',90,365,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-official-announcement','evidence-quality','official-announcement','Official announcement','The claim is supported by an official public announcement.','Announcement URL','either',88,365,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-active-ad-observed','evidence-quality','active-advertisement-observed','Active advertisement observed','The claim is supported by a directly observed, dated advertisement.','Ad library URL','either',85,365,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-public-job-posting','evidence-quality','public-job-posting','Public job posting','The claim is supported by a public job posting.','Job posting URL','either',85,365,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-verified-directory','evidence-quality','verified-business-directory','Verified business directory','The claim is supported by a verified business directory entry.','Directory URL','either',70,365,0,'Directories go stale; corroborate material claims first-party.',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-third-party-report','evidence-quality','reputable-third-party-report','Reputable third-party report','The claim is supported by a reputable third-party publication.','Report URL','manual',75,365,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-observed-date','evidence-quality','observed-date-recorded','Observed date recorded','The evidence item carries the date it was observed.','Evidence ledger','automated',95,365,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-corroborating-source','evidence-quality','corroborating-source','Corroborating source','A second independent source supports the claim.','Second source URL','either',85,365,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-contradiction','evidence-quality','contradiction-present','Contradiction present','Sources conflict on a material claim.','Both source URLs','either',90,365,0,'A contradiction stays visible until resolved; it is never deleted.',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-stale-evidence','evidence-quality','stale-evidence','Stale evidence','The supporting evidence is older than its recency window.','Evidence ledger dates','automated',90,365,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z');

-- ---------------------------------------------------- reachability
INSERT OR IGNORE INTO signal_taxonomy
  (id, dimension, signal_type, label, description, observable_asset, detection, default_confidence, recency_window_days, qualifying, guidance, active, created_at, updated_at)
VALUES
  ('rw-sig-verified-owner','reachability','verified-owner-founder','Verified owner or founder','An owner or founder is verified by a cited public source.','Cited public source','either',90,180,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-verified-marketing-leader','reachability','verified-marketing-leader','Verified marketing leader','A marketing leader is verified by a cited public source.','Cited public source','either',85,180,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-verified-growth-leader','reachability','verified-growth-leader','Verified growth leader','A growth leader is verified by a cited public source.','Cited public source','either',85,180,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-verified-creative-director','reachability','verified-creative-director','Verified creative director','A creative director is verified by a cited public source.','Cited public source','either',85,180,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-verified-agency-owner','reachability','verified-agency-owner','Verified agency owner','An agency owner is verified by a cited public source.','Cited public source','either',88,180,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-public-business-email','reachability','public-business-email','Public business email','A business email address is published on a permitted public source.','Cited public source','either',90,180,0,'Never infer an email pattern and mark it verified.',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-official-contact-form','reachability','official-contact-form','Official contact form','The business publishes an official contact form.','Official site contact page','automated',85,180,0,'',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-permitted-social','reachability','permitted-social-profile','Permitted social profile','A public social profile allows manual contact within platform rules.','Public profile URL','either',75,180,0,'LinkedIn stays strictly manual.',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-company-level-route','reachability','company-level-route','Company-level route','Only a company-level contact route (info@, main form) is available.','Cited public source','either',70,180,0,'Label honestly; a company route is not a named decision-maker.',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z'),
  ('rw-sig-no-route','reachability','no-supportable-route','No supportable route','No permitted contact route could be verified.','Research record','either',95,180,0,'This fails the reachability gate outright.',1,'2026-07-17T00:00:00.000Z','2026-07-17T00:00:00.000Z');

-- ------------------------------------------------------- scoring model
-- Deterministic, editable multi-dimension scoring. One active model at a
-- time. Weights inside a dimension sum to 100; priority weights sum to 100.

CREATE TABLE IF NOT EXISTS scoring_models (
  id         TEXT PRIMARY KEY,
  version    TEXT NOT NULL UNIQUE,
  label      TEXT NOT NULL,
  dimensions TEXT NOT NULL,
  thresholds TEXT NOT NULL,
  priority_weights TEXT NOT NULL,
  hard_gates TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  notes      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO scoring_models
  (id, version, label, dimensions, thresholds, priority_weights, hard_gates, active, notes, created_at, updated_at)
VALUES
  ('rw-score-copywriting-1', 'copywriting-1.0', 'Copywriting lead qualification',
   '{"icp_fit":{"label":"ICP fit","factors":[{"factor":"industry_match","weight":25,"label":"industry or business-type match"},{"factor":"geography_match","weight":15,"label":"geography and serviceability"},{"factor":"business_model_match","weight":15,"label":"business model matches the service"},{"factor":"company_size_match","weight":15,"label":"company size within the campaign range"},{"factor":"service_value_match","weight":20,"label":"plausible economics for the service minimum"},{"factor":"operating_capacity","weight":10,"label":"visible operating capacity"}]},"copy_opportunity":{"label":"Copy opportunity","factors":[{"factor":"observable_signal","weight":40,"label":"observable opportunity tied to a specific public asset"},{"factor":"asset_specific","weight":20,"label":"affected asset identified and cited"},{"factor":"service_mapped","weight":20,"label":"opportunity maps to one enabled service"},{"factor":"signal_strength","weight":20,"label":"signal confidence meets its taxonomy default"}]},"buying_capacity":{"label":"Buying trigger / capacity","factors":[{"factor":"trigger_present","weight":50,"label":"a dated buying trigger is observed"},{"factor":"capacity_indicator","weight":30,"label":"a capacity indicator is observed"},{"factor":"trigger_recent","weight":20,"label":"trigger is inside its recency window"}]},"evidence_quality":{"label":"Evidence quality","factors":[{"factor":"first_party","weight":40,"label":"material claims verified first-party"},{"factor":"source_cited","weight":25,"label":"every material claim has a source URL and observed date"},{"factor":"corroborated","weight":20,"label":"key claims corroborated by a second source"},{"factor":"contradictions_handled","weight":15,"label":"contradictions resolved or explicitly surfaced"}]},"evidence_recency":{"label":"Evidence recency","factors":[{"factor":"opportunity_fresh","weight":50,"label":"opportunity evidence inside its recency window"},{"factor":"trigger_fresh","weight":30,"label":"trigger evidence inside its recency window"},{"factor":"verified_recently","weight":20,"label":"dossier verified inside the campaign freshness window"}]},"reachability":{"label":"Reachability","factors":[{"factor":"role_appropriate","weight":40,"label":"contact role suits the recommended service"},{"factor":"route_verified","weight":40,"label":"exact contact route verified from a cited source"},{"factor":"channel_permitted","weight":20,"label":"route uses a campaign-permitted channel"}]}}',
   '{"icp_fit":60,"copy_opportunity":60,"buying_capacity":50,"evidence_quality":60,"evidence_recency":50,"reachability":60,"overall_priority":60}',
   '{"icp_fit":15,"copy_opportunity":30,"buying_capacity":20,"evidence_quality":15,"evidence_recency":10,"reachability":10}',
   '[{"gate":"copy-opportunity-required","reason":"No supportable copy opportunity means no outreach, regardless of ICP fit."},{"gate":"buying-capacity-required","reason":"A strong copy opportunity cannot compensate for no observable buying trigger or capacity."},{"gate":"evidence-required","reason":"Weak or stale evidence cannot support outreach, whatever the other scores say."},{"gate":"reachability-required","reason":"Without a verified permitted contact route the candidate cannot qualify."},{"gate":"no-disqualifiers","reason":"Any recorded disqualifier fails the candidate outright."},{"gate":"no-guessing","reason":"Missing inputs score zero and are listed as unknown; they are never estimated."}]',
   1, 'Seeded by migration 0010. Edit weights and thresholds in the Market screen; every change is audited.',
   '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z');

-- ------------------------------------------------------- campaigns
ALTER TABLE campaigns ADD COLUMN buying_triggers  TEXT NOT NULL DEFAULT '[]';
ALTER TABLE campaigns ADD COLUMN score_thresholds TEXT NOT NULL DEFAULT '{}';

-- ------------------------------------------- copywriting service catalog
-- Michael's actual copywriting services. Every field is editable in the
-- console; disable any service that does not apply. Claims lists encode
-- what outreach may and may not say.

INSERT OR IGNORE INTO client_services
  (id, client_id, name, description, entry_angle, signal_types, delivery_type, public_rung, priority, active,
   target_business_type, target_buyer, company_stage, minimum_commercial_value,
   capacity_indicators, buying_triggers, service_disqualifiers, required_evidence, contact_roles,
   permitted_claims, prohibited_claims, typical_cta, next_step, created_at, updated_at)
VALUES
  ('rw-svc-homepage-messaging', 'rw-client-reemergence', 'Website & homepage messaging',
   'Rewrite the homepage and core pages so a first-time visitor understands who the business serves, what it offers, and what to do next.',
   'Lead with one specific observation from the reviewed homepage.',
   '["unclear-offer-rubric","missing-primary-cta","missing-primary-heading","weak-offer-clarity","inconsistent-positioning"]',
   'service', 1, 10, 1,
   'Owner-led service businesses and B2B companies with an active website', 'Owner, founder, or marketing leader',
   'Established and actively marketing', 'Supports a four-figure project',
   '["active-paid-advertising","lead-gen-infrastructure-active","visible-growth-investment"]',
   '["rebrand-announced","new-marketing-leader","product-launch"]',
   '["icp-exclusion","no-supportable-route","site is a parked or inactive domain"]',
   '["official-page","observed-date-recorded"]',
   '["owner","founder","ceo","marketing-director","head-of-marketing"]',
   '["I reviewed your homepage on <date>","The page currently leads with X","A clearer next step could help visitors act"]',
   '["your copy is bad","you are losing customers","your conversion rate is low","I know you need a copywriter"]',
   'Offer a short review of specific observations', 'A brief call to walk through the observations',
   '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z'),

  ('rw-svc-landing-page-copy', 'rw-client-reemergence', 'Landing-page copy',
   'Write or rewrite a single conversion-focused landing page matched to one traffic source and one offer.',
   'Lead with the specific page reviewed and the single observable gap.',
   '["missing-primary-cta","missing-lead-capture","unclear-offer-rubric","proof-not-visible"]',
   'service', 1, 20, 1,
   'Businesses actively sending traffic to a page', 'Owner, marketing leader, or growth lead',
   'Actively acquiring customers', 'Supports a four-figure project',
   '["active-paid-advertising","lead-gen-infrastructure-active"]',
   '["active-paid-advertising","product-launch","expansion-announced"]',
   '["icp-exclusion","no-supportable-route","no observable traffic investment"]',
   '["official-page","active-advertisement-observed","observed-date-recorded"]',
   '["owner","marketing-director","head-of-marketing","growth-lead"]',
   '["The ad I saw emphasizes X while the page leads with Y","The reviewed page has no visible next step"]',
   '["your page does not convert","you are wasting ad spend","your customers are confused"]',
   'Offer a message-match review of one ad-to-page path', 'A short call comparing the ad and the page',
   '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z'),

  ('rw-svc-offer-positioning', 'rw-client-reemergence', 'Offer positioning & value proposition',
   'Sharpen what the business sells, for whom, and why it wins — the message architecture the other assets inherit.',
   'Lead with observed inconsistency or unclear positioning across cited public pages.',
   '["inconsistent-positioning","unclear-offer-rubric","weak-offer-clarity","unclear-primary-constraint"]',
   'service', 1, 30, 1,
   'Businesses with multiple public channels describing the same offer differently', 'Owner, founder, or CEO',
   'Established, rebranding, or repositioning', 'Supports a four-figure project',
   '["visible-growth-investment","agency-client-workload"]',
   '["rebrand-announced","new-marketing-leader","new-funding"]',
   '["icp-exclusion","no-supportable-route"]',
   '["official-page","corroborating-source","observed-date-recorded"]',
   '["owner","founder","ceo","marketing-director"]',
   '["Your site describes the offer as X while your profile describes it as Y"]',
   '["your positioning is broken","your brand is confusing","competitors are beating you"]',
   'Offer to share the observed inconsistencies', 'A positioning review call',
   '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z'),

  ('rw-svc-ad-copy', 'rw-client-reemergence', 'Ad copy',
   'Write advertisement copy variants matched to the offer and the destination page.',
   'Lead with the observed active advertising and one specific creative observation.',
   '["ad-to-page-mismatch","inconsistent-positioning"]',
   'service', 1, 40, 1,
   'Businesses currently running paid advertisements', 'Owner, marketing leader, or agency running the account',
   'Actively advertising', 'Supports ongoing or project work',
   '["active-paid-advertising"]',
   '["active-paid-advertising","product-launch","expansion-announced"]',
   '["icp-exclusion","no-supportable-route","no active advertising observed"]',
   '["active-advertisement-observed","observed-date-recorded"]',
   '["owner","marketing-director","head-of-marketing","agency-owner"]',
   '["I saw your current ad in the ad library on <date>"]',
   '["your ads are not working","you are burning money","your CTR must be low"]',
   'Offer ad-copy variants tied to the current campaign', 'A short call about the current campaign',
   '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z'),

  ('rw-svc-message-match', 'rw-client-reemergence', 'Ad-to-page message matching',
   'Align what the advertisement promises with what the destination page delivers, as one connected asset.',
   'Quote the ad emphasis and the page emphasis side by side; recommend alignment.',
   '["ad-to-page-mismatch"]',
   'service', 1, 50, 1,
   'Businesses running ads to their own landing pages', 'Owner, marketing leader, or growth lead',
   'Actively advertising', 'Supports a four-figure project',
   '["active-paid-advertising","lead-gen-infrastructure-active"]',
   '["active-paid-advertising"]',
   '["icp-exclusion","no-supportable-route","no active advertising observed"]',
   '["active-advertisement-observed","official-page","observed-date-recorded"]',
   '["owner","marketing-director","growth-lead"]',
   '["The ad emphasizes X while the destination page leads with Y — observed <date>"]',
   '["your funnel is leaking","visitors bounce because of this"]',
   'Offer a specific ad-to-page alignment review', 'A short review call',
   '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z'),

  ('rw-svc-email-nurture', 'rw-client-reemergence', 'Email nurture sequences',
   'Write the follow-up sequence that turns captured leads into conversations, matched to the business''s offer and tone.',
   'Lead with the observable capture-without-nurture gap.',
   '["nurture-path-missing","missing-lead-capture","manual-only-contact"]',
   'service', 1, 60, 1,
   'Businesses capturing leads without an observable follow-up path', 'Owner, marketing leader, or lifecycle lead',
   'Actively capturing leads', 'Supports a four-figure project',
   '["lead-gen-infrastructure-active","active-paid-advertising"]',
   '["hiring-current","lead-gen-infrastructure-active"]',
   '["icp-exclusion","no-supportable-route"]',
   '["official-page","observed-date-recorded"]',
   '["owner","marketing-director","lifecycle-lead","growth-lead"]',
   '["Your signup path is live; I could not find a visible follow-up sequence from the outside"]',
   '["your leads are going cold","you are ignoring your list"]',
   'Offer a nurture-path outline for the existing capture flow', 'A short call about the follow-up path',
   '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z'),

  ('rw-svc-lifecycle-email', 'rw-client-reemergence', 'Lifecycle email',
   'Ongoing customer email: onboarding, retention, win-back, and announcement copy.',
   'Lead with the observed lifecycle investment (role posting, program) and offer support.',
   '["hiring-copy-content-roles","nurture-path-missing"]',
   'service', 1, 70, 1,
   'Businesses with a customer base and active email investment', 'Marketing or lifecycle leader',
   'Established with recurring customers', 'Supports ongoing monthly work',
   '["hiring-current","visible-growth-investment"]',
   '["hiring-current","new-marketing-leader"]',
   '["icp-exclusion","no-supportable-route"]',
   '["public-job-posting","official-page","observed-date-recorded"]',
   '["marketing-director","lifecycle-lead","head-of-marketing"]',
   '["Your team appears to be investing in lifecycle marketing based on the current role posting"]',
   '["your emails are weak","your retention is poor"]',
   'Offer lifecycle copy support alongside the team''s current push', 'A short capabilities conversation',
   '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z'),

  ('rw-svc-sales-pages', 'rw-client-reemergence', 'Sales-page copy',
   'Long-form sales pages for high-value offers: structure, proof, objections, and a clear close.',
   'Lead with the observed high-value offer and one observable gap on its page.',
   '["unclear-offer-rubric","proof-not-visible","missing-primary-cta"]',
   'service', 1, 80, 1,
   'Businesses selling a high-ticket offer from a page', 'Owner or founder',
   'Established with a proven offer', 'Supports a four-to-five-figure project',
   '["high-value-offer","active-paid-advertising"]',
   '["product-launch","active-paid-advertising"]',
   '["icp-exclusion","no-supportable-route"]',
   '["official-page","observed-date-recorded"]',
   '["owner","founder","ceo"]',
   '["The offer page presents X; several strong proof elements exist elsewhere but are not on it"]',
   '["your page cannot sell this offer","buyers do not trust you"]',
   'Offer a sales-page review anchored to the observations', 'A scoping call',
   '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z'),

  ('rw-svc-case-studies', 'rw-client-reemergence', 'Case studies',
   'Interview-based customer case studies written for sales use, with verifiable results handling.',
   'Lead with the observed proof that exists (reviews, named clients) but is not written up.',
   '["proof-not-visible"]',
   'service', 1, 90, 1,
   'Businesses with happy customers and no written case studies', 'Owner, founder, or marketing leader',
   'Established with referenceable customers', 'Supports a per-asset project fee',
   '["visible-growth-investment","agency-client-workload"]',
   '["expansion-announced","new-funding","hiring-current"]',
   '["icp-exclusion","no-supportable-route"]',
   '["official-page","corroborating-source","observed-date-recorded"]',
   '["owner","founder","marketing-director"]',
   '["I found several strong customer examples that are not currently visible on the reviewed page"]',
   '["nobody believes your marketing","you have no proof"]',
   'Offer to turn one existing customer story into a usable asset', 'A short call to pick the first story',
   '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z'),

  ('rw-svc-proof-assets', 'rw-client-reemergence', 'Proof assets',
   'Testimonial curation, results summaries, and trust sections placed where buying decisions happen.',
   'Lead with the specific reviewed page where available proof is not visible.',
   '["proof-not-visible"]',
   'service', 1, 100, 1,
   'Businesses with public reviews or results not used on conversion pages', 'Owner or marketing leader',
   'Established with existing customer proof', 'Supports a small focused project',
   '["lead-gen-infrastructure-active"]',
   '["active-paid-advertising","product-launch"]',
   '["icp-exclusion","no-supportable-route"]',
   '["official-page","corroborating-source","observed-date-recorded"]',
   '["owner","marketing-director"]',
   '["Your reviews on <platform> are strong; the reviewed page does not currently show them"]',
   '["your page looks untrustworthy"]',
   'Offer a proof-placement pass on one page', 'A short review call',
   '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z'),

  ('rw-svc-founder-thought-leadership', 'rw-client-reemergence', 'Founder thought leadership',
   'Ghost-written articles and posts in the founder''s voice, built from their actual expertise and positions.',
   'Lead with the founder''s observable public activity and a respectful offer to extend it.',
   '["inconsistent-positioning","hiring-copy-content-roles"]',
   'service', 1, 110, 1,
   'Founder-led businesses where the founder''s voice drives trust', 'Founder or CEO',
   'Established, founder publicly active or wanting to be', 'Supports ongoing monthly work',
   '["visible-growth-investment","hiring-current"]',
   '["new-funding","new-marketing-leader","rebrand-announced"]',
   '["icp-exclusion","no-supportable-route","founder shows no interest in public voice"]',
   '["official-page","permitted-social-profile","observed-date-recorded"]',
   '["founder","ceo"]',
   '["Your recent post on X made a point worth developing further"]',
   '["your content is thin","nobody reads your posts"]',
   'Offer one developed piece in the founder''s voice', 'A voice-alignment conversation',
   '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z'),

  ('rw-svc-executive-ghostwriting', 'rw-client-reemergence', 'Executive ghostwriting',
   'Ongoing ghost-written communication for executives: posts, letters, internal and external messaging.',
   'Lead with an observed communication program or role posting; offer capacity.',
   '["hiring-copy-content-roles"]',
   'service', 1, 120, 1,
   'Companies whose executives communicate publicly at scale', 'CEO, founder, or head of communications',
   'Established with visible executive communication', 'Supports ongoing monthly retainer',
   '["hiring-current","visible-growth-investment"]',
   '["new-marketing-leader","new-funding"]',
   '["icp-exclusion","no-supportable-route"]',
   '["public-job-posting","permitted-social-profile","observed-date-recorded"]',
   '["ceo","founder","marketing-director"]',
   '["The current posting for <role> suggests the team is investing in this work"]',
   '["your executives sound generic"]',
   'Offer ghost-writing capacity for the current program', 'A capabilities conversation',
   '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z'),

  ('rw-svc-agency-overflow', 'rw-client-reemergence', 'Agency overflow / white-label copy',
   'White-label copywriting capacity for agencies: briefs in, finished copy out, under the agency''s banner.',
   'Lead with the agency''s observed request or visible workload; offer reliable capacity.',
   '["agency-overflow-request","hiring-copy-content-roles"]',
   'service', 1, 130, 1,
   'Marketing, design, and web agencies with copy demand', 'Agency owner or creative director',
   'Established agency with active client work', 'Supports per-project or retainer work',
   '["agency-client-workload","hiring-current"]',
   '["published-request-for-help","hiring-current","agency-client-workload"]',
   '["icp-exclusion","no-supportable-route"]',
   '["official-page","public-job-posting","observed-date-recorded"]',
   '["agency-owner","creative-director","content-lead"]',
   '["Your posting for overflow support matches the work I deliver for agencies"]',
   '["your writers are overloaded","your clients are unhappy"]',
   'Offer a small first white-label brief', 'A capabilities and process call',
   '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z');
