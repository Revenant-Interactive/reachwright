# Reachwright operator runbook

_The daily loop, in the order the controls expect. The console never sends anything; you do._

## 0. Sign in

Open the console (`/app/`), enter the API base URL and your operator token. The banner tells you the truth about the system state: provider configured or not, fixtures mode, email gate. **If the banner says "Provider not configured," Scout search is off — that's correct behavior, not a bug.**

## 1. Campaign (once per offer/ICP)

Campaigns → New campaign brief. Playbook items 1–5 are mandatory; the API refuses `researching` status on an incomplete brief. Set the batch cap small (5–10) — the pilot protocol is five audited dossiers, not a bulk list.

## 2. Work the prospect feed

Open **Today** first. The seeded **Copywriting opportunity feed** spans twelve
market lanes rather than one roofing niche. In local development, a configured
live Hunter source may replenish the queue automatically once per cooldown;
production automatic discovery remains disabled until its credit and cadence
settings are approved. Every card shows a cited public copy opportunity, an
observable capacity signal, the right person and exact route, a matched service,
the six-dimensional market score, and the next operator action. Fixture and
browser-test records do not appear in this operator view.

Use **Find fresh prospects** to start another bounded search deliberately. No
outreach is sent by discovery or by opening a card.

## 3. Advanced generation controls

Open **Generate** when you need to change the campaign, search terms, geography,
candidate ceiling, or credit budget. The broad default uses a 40-candidate
ceiling and searches up to six distinct market lanes per provider run before a
combined fallback. One click persists the run before work begins, then
cooperates across configured live sources, researches bounded official pages,
resolves an executive and exact contact route, proposes one observable
opportunity and one client service, and prepares three alternative messages.
It never sends.

The run rail is literal: `Discovered → Researching → Contact found → Qualified → Message ready`; rejected/retry is a separate lane. `completed` means the algorithm prepared the requested number of review packets. It does **not** mean those packets are accurate. `partial` means the candidate pool was honestly exhausted before the target. Inspect provider/error events, add or correct permitted evidence/contact data where appropriate, then use the bounded retry path; never upgrade an unknown contact to make the count look complete.

Open **Review** and process every packet:

1. Open every official citation. Accept only what the exact page supports; reject provider provenance unless independently confirmed.
2. Confirm the company/market and current owner, founder, CEO, president, or appropriate executive.
3. Confirm the exact route belongs to that person and business. Email verification does not prove the person's current role.
4. Confirm or reduce each proposed score. Unknown economics/capacity remain zero until supported.
5. Complete all six audit checks, including exceptions and contradictions.
6. Choose exactly one of the three messages. The other two are alternatives, not extra sends.

Confirmation creates one draft only. The normal exact packet-hash approval, suppression, prior-contact, edit-invalidation, one-initial-message, and channel gates still run afterward.

### Manual fallback and enrichment

**Pilot default: Hunter discovery + manual verification.** Hunter's free plan discovers small-company domains and can return owner/founder/CEO-class professional contacts from a selected domain. Use **Discover candidates** for a small batch, inspect each company's first-party site yourself, then use **Find CEO/owner** on promising dossiers. Hunter data remains unverified provider evidence until you complete the normal fact audit. Alternatively, use **Create a sourced dossier in one pass** after inspecting an approved public source.

Hunter currently provides 50 free credits per month and API access. Company Discover is free; Domain Search costs one credit when it returns up to 10 professional emails. Reachwright keeps only owner/founder/CEO-class titles and discards phone fields. Tavily remains a 1,000-credit company-web-only fallback. Apollo remains optional paid acceleration after a client payment funds it.

Campaign page → **Preview provider usage** first → **Discover candidates**. The summary reports stored / merged duplicates / attached-to-this-campaign / suppressed / skipped. Hunter's free company discovery is sliced locally to the requested pilot batch because free accounts cannot alter provider pagination. Apollo's adapter retains stable continuation-token behavior if enabled later.

Then per organization (Research queue → row → dossier):

1. **Find CEO/owner** with Hunter, then verify the returned name, title, and business email against available first-party or authoritative sources. Hunter phone data is discarded. If Hunter finds no decision-maker-class result, enter a verified person and usable public contact path manually.
2. **Add first-party evidence**: visit the business's real site/pages yourself, record the exact claim + URL + date + strength. Contradictions get flagged, not hidden. Unknowns stay unknown.
3. **Accept/reject** each evidence item. Only accepted first-party/authoritative items can enter a draft.
4. **Correct the person before scoring** when a name, title, or channel destination is wrong. A verified correction kills unexported drafts and makes the audit/scores stale.
5. **Score**: your judgment on the six fit factors (0 / 0.5 / 1), any hard disqualifier, and whether the contact path is verified. Fit and evidence store separately with full factor breakdowns. Queue threshold: fit ≥65 AND evidence ≥70. Scores are fingerprinted to the exact campaign evidence and current people/contact records.

**Rule-ready** means all of these are currently true: accepted strong campaign evidence is no more than 60 days old; every evidence item is resolved; the six-check audit is accurate and current; fit is ≥65; evidence is ≥70; and the company is not suppressed. It is a workflow state, not a claim that the person has become a lead or will reply.

## 3. Drafts and approval

Before drafting, record the campaign-bound whole-dossier audit as `accurate`, `partly-accurate`, or `reject`. An accurate audit requires a meaningful note, all six checks (identity, offer/need signal, geography, decision-maker, allowed contact path, contradictions), accepted first-party/authoritative evidence, no unreviewed or unresolved contradictions, and one same named/titled/non-suppressed person with a usable allowed-channel contact. The server fingerprints the audit to the exact campaign evidence and current people. Any later evidence or person change requires a new audit **and** new scores.

Choose `initial` for the first message or `follow-up` for the single permitted follow-up; the server enforces one initial and seven full silent days before that follow-up. The exact person and channel destination are part of the approval packet. Email requires a business email, phone requires a business phone, and LinkedIn/DM requires a usable public contact profile.

For generation packets, **Review → Confirm packet** creates the single selected draft. For a manual dossier, use Dossier → Generate draft (choose person, channel, campaign). "Insufficient evidence for personalized outreach" means go verify more facts — it is never a failure to work around.

If you already contacted the business outside Reachwright, open its dossier and use **Prior contact outside Reachwright** before drafting or approving. Record the campaign, person when known, channel, date, and a useful note. This records history without sending, kills any draft or approved packet for that business, blocks another initial message, and lets you track the eventual outcome.

Approvals → Open packet. Read the EXACT person, exact channel contact, exact message, evidence behind every claim, suppression result, and prior-contact count. Answer the contacted-elsewhere question honestly (a "yes" blocks until you record the prior contact). Approve or kill. **Any edit returns the draft to unapproved.** Export recomputes the entire packet and refuses it if evidence, scores, audit, person, contact, policy, or suppression changed after approval.

## 4. Export and send (you, by hand)

Use the dossier outcome controls immediately after manual sending and when a reply, positive reply, opt-out, bounce, or close occurs. Add a short note so future-you knows what happened. The Dashboard's **Today's work** table shows one concrete next action per dossier rather than a pile of overlapping reminders.

Export each approved draft individually (CSV downloads; email rows are blocked until the CAN-SPAM gate passes). Send each message yourself on its channel — LinkedIn always manually. Immediately record `sent`, then later `replied` / `positive-reply` / `opted-out` / `bounced` / `closed`. The server rejects outcomes without a prior recorded send. **Record opt-outs the moment they happen** — the system expands them across every channel automatically.

Follow-up policy: one manual follow-up after 7+ full days of silence. The current server permanently prevents a second initial once any initial send has been recorded; the company is not automatically reopened after 30 days.

## 5. Qualify

Qualify → author a flow (questions, deterministic rules, verdict copy, routes), preview verdicts against test answers, activate. The public worker picks up the active flow (60s cache) and the verdict is always computed server-side. Sessions and outcomes land in Reports.

## 6. Sales calls

Use **Sales Calls** for a real booked conversation, including a warm LinkedIn reply. Do not force that person through Scout's cold-prospect dossier gates. Add the prospect, title, company, optional HTTPS company site, LinkedIn member/Sales Navigator profile, scheduled time, timezone, and a short sourcing note. Never paste the private message thread.

During the call, follow the five-step rail: frame the conversation, understand the business, diagnose the constraint, reflect it back for agreement, then recommend one right-sized next step. Save only factual discovery notes. A booked call remains `booked` until it actually happens; then record `held` or `no-show`.

Offer ladder: free 30-minute fit consultation; $500 Diagnostic; private qualified-only $1,200 Proof Sprint; $1,500/month Retainer; separately scoped custom work. The private Proof Sprint is a contained fallback, not a public advertised offer.

For paid work, use this exact sequence:

1. Recommend one offer; the server stores an immutable offer snapshot.
2. Record the agreement as sent, then signed. Direct jumps to signed are rejected.
3. Retrieve the protected Stripe link only after signature. Retrieval/copy does **not** mean it was shared.
4. After you manually share the link, record `link-shared` with a useful note. Custom work uses `invoice-sent` instead.
5. Confirm `operator-confirmed-paid` only after checking cleared payment and recording a reference. Begin work only then.

Call status, agreement status, and payment status are independent. The console never sends a LinkedIn message, posts publicly, signs an agreement, or verifies Stripe payment for you.

## 7. Bookings

Record bookings as `booked` (with timezone + attribution); after the call actually happens, transition to `held` (or `no-show`). The report will never count a booking as a held call — that's deliberate.

## 8. Weekly review

Results → client or campaign starts with generation yield: candidates considered → official sites researched → contactable → message-ready, candidate-to-ready yield, recorded research failures, and estimated provider credits. Then read prepared options → one selected message → manually recorded sends → replies → booked → held → operator-confirmed sales. Cohorts by market, opportunity signal, focused service, and selected message strategy are directional; rows under five sends are explicitly low-sample. Booked, held, and paid remain separate facts. Use legacy dossier/provider detail only when auditing operations. Log the weekly numbers to the vault project file.

## When things break

- **API unreachable banner:** is `wrangler dev`/the worker up? Token rotated?
- **provider failure:** open the run events for the exact provider/error. Retry only the bounded recoverable candidates after the network/credit/data issue is fixed. A missing executive, missing site, or conflicting fact stays rejected until new evidence exists.
- **credit-ceiling error:** intentional. Raise `PROVIDER_CREDIT_CEILING` only with budget in hand.
- **packet-stale on approve:** the record changed since you opened it — reopen the packet and re-read.
- **Everything Qualify:** any provider failure degrades to scripted copy by design; the visitor never sees an error.
