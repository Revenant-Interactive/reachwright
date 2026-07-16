# Reachwright data map

_What data enters the system, from where, why, where it lives, and how it leaves. Update this file in the same change as any behavior change._

## Sources and fields

| source | fields received | purpose | storage | retention | access |
|---|---|---|---|---|---|
| Apollo.io (licensed, when configured) | company: name, domain, location, industry, employee count, provider id · person: name, title, seniority, business email + status, public profile URL, provider id | prospect research against an approved campaign brief | D1 `organizations`, `people` | until superseded, suppressed, or deleted; dossiers >60 days unverified are flagged re-verify-or-delete | operator only (bearer token) |
| Operator (manual evidence) | claim text, source URL, observed date, strength | evidence ledger backing every outreach claim | D1 `evidence_items` | with the dossier | operator only |
| Public Qualify conversation | closed-enum answers ONLY (no name, email, phone — the schema physically has no such fields) + turn count | deterministic fit verdict | KV session (15-min TTL) + D1 `qualification_sessions/outcomes` | KV auto-expires; D1 outcomes kept for reporting | operator only |
| Booking provider (when configured: Calendly) | event id, status, scheduled time, timezone, attribution tags | booked/held/canceled truth | D1 `bookings` | with the campaign record | operator only |
| Prospect replies/opt-outs (recorded manually by operator) | channel, status, note | contact history + suppression | D1 `contact_attempts`, `suppression_entries` | attempts with campaign; **suppression entries permanent by default** | operator only |

## What is deliberately NOT collected

- No personal (non-business) emails or mobile numbers — Apollo reveal flags are hard-off.
- No sensitive personal traits, ever (playbook rule).
- No raw Qualify chat transcripts by default; the model's bounded `reply_text` is not logged.
- No analytics/tracking cookies on the public site; the operator console sets none either.
- No secrets anywhere in D1, logs, or Git — provider keys live in Worker secret stores only.

## Paths

- **Export:** approved outreach only, via `/api/exports` (CSV, formula-injection-escaped). Email rows blocked until the CAN-SPAM gate passes.
- **Correction:** dossier evidence is editable/reviewable; identity fields via merge; every mutation audited.
- **Deletion:** D1 rows are deletable by the operator (SQL or future UI); provider-sourced records must honor licensed-use limits (`docs/providers/apollo.md`).
- **Suppression:** `/api/suppression` + automatic opt-out expansion across email/domain/phone/handle/org/alias keys; checked before research expands, before approval, and again at export.

## Trust boundaries

Server-observed events (D1/KV writes, audit trail) are authoritative. Anything client-reported is directional only. Fixture records (`local-fixtures` provider, `[FIXTURE]` prefix) exist only when `DEV_FIXTURES=true` and must never be treated as prospects.
