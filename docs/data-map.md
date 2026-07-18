# Reachwright data map

_What data enters the system, from where, why, where it lives, and how it leaves. Update this file in the same change as any behavior change._

## Sources and fields

Manual-first pilot records include organization identity, location, domain/phone, official source URL/date, exact personalization claim, and decision-maker business identity/contact path. They are stored in D1 `organizations`, `people`, and `evidence_items` and are operator-only. Campaign freshness comes only from accepted first-party or authoritative evidence and becomes stale after 60 days. Campaign-bound audit verdicts, notes, six verification checks, and dossier fingerprints are stored in `dossier_audits`; fit/evidence score rows retain the same fingerprint. A change to campaign evidence or a person/contact record makes both the audit and scores stale without erasing history.

| source | fields received | purpose | storage | retention | access |
|---|---|---|---|---|---|
| Hunter (free-first default, when configured) | Discover: company name/domain + email-count metadata · Domain Search: professional name, title, seniority, business email, verification state, public LinkedIn handle/URL · Email Finder: selected person's professional email | find small-business candidates and owner/founder/CEO-class professional contacts | D1 `organizations`, `people`, and secondary unreviewed provider provenance | until verified, rejected/deleted, superseded, or suppressed; normal 60-day dossier freshness applies | operator only (bearer token) |
| Tavily Search (free-first, when configured) | public result title, URL, relevance snippet, request id/usage metadata | discover candidate company websites for manual verification; never treated as a verified company fact or contact source | D1 `organizations` + a secondary, unreviewed `evidence_items` provenance row | until verified, rejected/deleted, superseded, or suppressed; normal 60-day dossier freshness rule still applies | operator only (bearer token) |
| Apollo.io (licensed, when configured) | company search: name, domain, location, industry, employee count, provider id · people search: name, title, seniority, public profile URL, provider id (no email/phone) · explicit person enrichment: business email + status only; personal-email and phone reveals disabled | prospect research against an approved campaign brief | D1 `organizations`, `people` | until superseded, suppressed, or deleted; campaign dossiers >60 days without accepted strong evidence are flagged re-verify-or-delete | operator only (bearer token) |
| Operator (manual evidence) | claim text, source URL, observed date, strength | evidence ledger backing every outreach claim | D1 `evidence_items` | with the dossier | operator only |
| Public Qualify conversation | closed-enum answers ONLY (no name, email, phone — the schema physically has no such fields) + turn count | deterministic fit verdict | KV session (15-min TTL) + D1 `qualification_sessions/outcomes` | KV auto-expires; D1 outcomes kept for reporting | operator only |
| Cal.com public fit-call event (configured; no API import yet) | attendee submits name, business email, business problem, optional notes, and chosen time directly to Cal.com; the operator manually records only the commercial booking fields needed below | schedule the external call; preserve booked/held/canceled truth without pretending a webhook exists | Cal.com and the connected organizer calendar; selected outcome fields enter D1 only through operator entry | Cal.com/calendar account policy; D1 record retained with campaign history | attendee, operator, and configured booking/calendar providers |
| Operator-entered booked sales call | prospect business identity, title, company/site, LinkedIn member or Sales Navigator URL, short source context, scheduled time/timezone, closed-schema discovery notes, call outcome, server-owned offer snapshot, agreement/payment state and concise confirmation notes | run a real consultation and preserve separate booked/held, signed, and paid truth | D1 `bookings` (migration `0006_sales_call_console.sql`) | active until operator archives it; archived rows and audit events remain for commercial history | operator only (bearer token) |
| Operator-recorded external contact and prospect outcomes | campaign, business/person, channel, contact date, status, note | prevent duplicate initial messages, track outcomes, expand opt-outs into suppression | D1 `contact_attempts`, `suppression_entries` | attempts with campaign; **suppression entries permanent by default** | operator only |
| Generation run | client/campaign/query snapshot, source plan, target/candidate/credit caps, durable stage events, provider errors and estimated credits | overfetch and resume safely until the ready target or honest exhaustion | D1 `generation_runs`, `generation_candidates`, `generation_events` | with campaign; failures/rejections retained for yield truth | operator only |
| Official company website | bounded same-site HTML observations: title/meta/H1, viewport, form/CTA/booking/contact paths, copyright year, page URL/status/hash; conservative decision-maker/contact text when present | evidence-backed dossier facts and observable opportunity proposals | D1 `website_research`, normalized `evidence_items`, `opportunity_signals`; **raw HTML is not stored** | normal 60-day evidence freshness; research events retained with run | operator only |
| Generation contact resolution | current executive business identity plus exact professional route, source, observed date, verification state, confidence | choose one contactable owner/founder/CEO-class person without upgrading unknown data | D1 `people`, `contact_routes` | with canonical organization; rejected/conflicted routes retained for audit | operator only |
| Prospect packet and message alternatives | cited facts, opportunity, one matched service, proposed scores/audit, exceptions/confidence, three evidence-bound alternatives and immutable hashes | fast human confirmation before one draft | D1 `prospect_packets`, `strategic_message_options`; selected option links to one `outreach_draft` | with campaign/run and approval history | operator only |
| Client workspace configuration | client-owned market offers/proof, service-matching catalog, targeting campaign, immutable offer snapshot | keep managed-client campaigns, matching rules, data, and reports logically separated | D1 `clients`, `client_offers`, `client_services`, scoped `campaigns` | until archived; historical campaign snapshots remain | operator only |
| Generation outcome attribution | generated candidate/message strategy on the draft and optional generated-candidate link on a booked sales call; operator-confirmed payment state | measure yield, replies, held calls, and sales by market/signal/service/message without guessing from names | D1 `outreach_drafts`, `contact_attempts`, `bookings` | with audit/commercial history | operator only |

## What is deliberately NOT collected

- No personal (non-business) emails or mobile numbers — Apollo reveal flags are hard-off, and Hunter phone fields are discarded.
- No sensitive personal traits, ever (playbook rule).
- No raw Qualify chat transcripts by default; the model's bounded `reply_text` is not logged.
- No private LinkedIn thread transcripts; Sales Calls stores only a short operator-written source context and structured discovery notes.
- No analytics/tracking cookies on the public site; the operator console sets none either.
- No secrets anywhere in D1, logs, or Git — provider keys live in Worker secret stores only.

## Paths

- **Export:** approved outreach only, via `/api/exports` (CSV, formula-injection-escaped). Email rows blocked until the CAN-SPAM gate passes.
- **Correction:** evidence can be accepted, rejected, contradiction-flagged, or superseded by a new item; claim/source content is not silently rewritten. People can be corrected through the operator API/UI, which invalidates unexported drafts and makes fingerprints stale. Organization identity corrections still require a controlled merge or direct operator procedure. Every mutation is audited.
- **Deletion:** D1 rows are deletable by the operator (SQL or future UI); provider-sourced records must honor licensed-use limits (`docs/providers/apollo.md`).
- **Suppression:** `/api/suppression` + automatic opt-out expansion across email/domain/phone/handle/org/alias keys; checked before research expands, before approval, and again at export.

## Trust boundaries

Server-observed events (D1/KV writes, audit trail) are authoritative. Anything client-reported is directional only. Fixture records (`local-fixtures` provider, `[FIXTURE]` prefix) exist only when `DEV_FIXTURES=true` and must never be treated as prospects.

Client separation is a logical single-operator boundary. Canonical `organizations`/`people` and `suppression_entries` are intentionally shared so duplicates, prior contact, and opt-outs cannot be bypassed across client workspaces. Reachwright does not claim row-level tenant authorization or a client portal.
