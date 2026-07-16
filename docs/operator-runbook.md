# Reachwright operator runbook

_The daily loop, in the order the controls expect. The console never sends anything; you do._

## 0. Sign in

Open the console (`/app/`), enter the API base URL and your operator token. The banner tells you the truth about the system state: provider configured or not, fixtures mode, email gate. **If the banner says "Provider not configured," Scout search is off — that's correct behavior, not a bug.**

## 1. Campaign (once per offer/ICP)

Campaigns → New campaign brief. Playbook items 1–5 are mandatory; the API refuses `researching` status on an incomplete brief. Set the batch cap small (5–10) — the pilot protocol is five audited dossiers, not a bulk list.

## 2. Research

Campaign page → **Preview credits** first (shows the conservative estimate and remaining monthly ceiling) → **Run search**. The summary reports stored / merged duplicates / suppressed / skipped. Then per organization (Research queue → row → dossier):

1. **Find decision-makers** (people search — no credits, no emails; enrich later only if needed).
2. **Add first-party evidence**: visit the business's real site/pages yourself, record the exact claim + URL + date + strength. Contradictions get flagged, not hidden. Unknowns stay unknown.
3. **Accept/reject** each evidence item. Only accepted first-party/authoritative items can enter a draft.
4. **Score**: your judgment on the six fit factors (0 / 0.5 / 1), any hard disqualifier, and whether the contact path is verified. Fit and evidence store separately with full factor breakdowns. Queue threshold: fit ≥65 AND evidence ≥70.

## 3. Drafts and approval

Dossier → Generate draft (choose person, channel, campaign). "Insufficient evidence for personalized outreach" means go verify more facts — it is never a failure to work around.

Approvals → Open packet. Read the EXACT message, the evidence behind every claim, suppression result, prior-contact count. Answer the contacted-elsewhere question honestly (a "yes" blocks until you record the prior contact). Approve or kill. **Any edit returns the draft to unapproved.**

## 4. Export and send (you, by hand)

Select approved drafts → Export (CSV downloads; email rows are blocked until the CAN-SPAM gate passes). Send each message yourself on its channel — LinkedIn always manually. Immediately record the outcome: Attempts (`sent`), then later `replied` / `positive-reply` / `opted-out`. **Record opt-outs the moment they happen** — the system expands them across every channel automatically.

Follow-up policy: one manual follow-up after 7+ full days of silence, then the company closes for ≥30 days.

## 5. Qualify

Qualify → author a flow (questions, deterministic rules, verdict copy, routes), preview verdicts against test answers, activate. The public worker picks up the active flow (60s cache) and the verdict is always computed server-side. Sessions and outcomes land in Reports.

## 6. Bookings

Record bookings as `booked` (with timezone + attribution); after the call actually happens, transition to `held` (or `no-show`). The report will never count a booking as a held call — that's deliberate.

## 7. Weekly review

Reports → campaign: candidates → dossiers → approved → sent → replies → booked → held, plus disqualification reasons and provider credit usage. Log the weekly numbers to the vault project file. Stale dossiers (>60 days unverified) show in the queue — re-verify or delete.

## When things break

- **API unreachable banner:** is `wrangler dev`/the worker up? Token rotated?
- **provider-failure on search:** Apollo 429 (wait a minute), 403 (plan restriction), auth-failed (key). Check `docs/providers/apollo.md`.
- **credit-ceiling error:** intentional. Raise `PROVIDER_CREDIT_CEILING` only with budget in hand.
- **packet-stale on approve:** the record changed since you opened it — reopen the packet and re-read.
- **Everything Qualify:** any provider failure degrades to scripted copy by design; the visitor never sees an error.
