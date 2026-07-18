# Reachwright

**Find the right opportunity. Fix what blocks the sale.** Reachwright is Michael Taylor's evidence-led operating system for delivering growth-systems advisory and hands-on implementation. It is not a DIY lead-list product:

**Reemergence Holdings is the client-facing and contracting business. Reachwright is the authenticated operating system Michael uses inside that service.**

- **Scout** produces evidence-backed prospect dossiers and human-approved outreach drafts.
- **Qualify** applies client-approved fit rules to inbound conversations and routes the next step.

This repository contains the public GitHub Pages product site, a zero-network deterministic preview of both workflows, and an undeployed Cloudflare Worker prototype for a later live-AI Qualify mode. The governing plan lives at `projects/ad-to-call-engine/PLAN.md` in the private ReeMergence vault.

## Structure

| path | purpose |
|---|---|
| `index.html` | product positioning, standards, dual workflow preview, and pilot CTA |
| `styles.css` | self-contained design system using local system fonts |
| `demo.js` | scripted Scout and Qualify preview; no network, storage, or personal-data collection |
| `privacy.html` | current-state website privacy notice plus future-service boundary |
| `worker/` | undeployed live-AI Qualify conversation worker (Turnstile sessions, deterministic verdicts, operator-flow loading) + contract tests |
| `worker-api/` | undeployed operator/Scout API worker: campaigns, evidence ledger, deterministic scoring, suppression, approval-gated drafts, exports, flow builder, reporting (Cloudflare Worker + D1 + KV) |
| `app/` | operator console (static, no secrets in source; bearer-token sign-in) |
| `migrations/` | ordered D1 schema migrations + dev-only seed |
| `docs/` | data map, security model, compliance boundaries, deployment, operator runbook, verified provider docs |
| `tests/` | Scout logic, Qualify flow, and end-to-end API tests (node:test; real schema via node:sqlite shim) |

## Run it locally

`npm install && npm run dev` — one command applies migrations, starts the API
and console, and prints the operator URL and token. Full instructions,
persistence behavior, and production blockers: `RUN-TONIGHT.md`.

## What exists today

The five-dossier pilot is **generation-first and human-confirmed**. A single command overfetches candidates from every configured provider, researches bounded pages on official company sites, resolves owner/CEO-class contacts, proposes one cited opportunity and one matching service, and prepares three alternative evidence-only messages. Approved public research from Google Maps, Meta Ad Library, business directories, and other permitted manual sources can enter the same campaign before a run. Apollo remains an optional later accelerator, not a pilot prerequisite.

- A static public product site (live on GitHub Pages).
- A deterministic browser-only preview of Scout and Qualify.
- **Copywriting market model (Phase 1, local):** an editable 14-service
  copywriting catalog (targeting, buying triggers, disqualifiers, required
  evidence, contact roles, permitted/prohibited claims per service), a
  five-dimension signal taxonomy (ICP fit, copy opportunity, buying
  trigger/capacity, evidence quality, reachability), and a deterministic
  multi-dimension scoring model with hard non-compensation gates — all
  editable in the operator console (Market and Clients screens) and persisted
  in D1. Campaign briefs now carry buying triggers and score thresholds.
- **Built and locally verified, NOT deployed:** the full operator layer — cooperative Hunter/Tavily/optional Apollo discovery, bounded official-site research with SSRF controls, 5–50 candidate overfetching, decision-maker and exact-route verification states, observable opportunity detection, client-specific service matching, proposed scoring and six-check audits, three evidence-bound message options, durable generation stages/retries, finished prospect packets, client/campaign separation, yield/cost/outcome reporting, feedback cohorts, and the original suppression, packet-hash approval, edit invalidation, one-message, email, and booked ≠ held controls. Local setup: `docs/deployment.md`.
- **Revenue command center (local):** the authenticated Revenue screen records the owner's recurring-revenue target, average retained-client value, funnel assumptions, operator-confirmed MRR, current bottleneck, and reverse-planned activity. Its defaults reflect the actual $1,500/month offer: seven retained clients produce $10,500 MRR. Assumptions are editable targets, never claimed benchmarks. See `docs/revenue-operating-plan.md`.
- **Signal precision policy:** a prospect is message-ready only when Reachwright finds a supportable current copy opportunity, observable capacity, current evidence, and a permitted verified contact route. Missing HTML headings and generic navigation/service copy do not qualify outreach by themselves. Current hiring messages name the actual role when the source page exposes it and offer project or overflow capacity without pretending the prospect requested help.
- An undeployed Qualify conversation worker for a future live-AI mode.

**Nothing in this repository is deployed beyond the static site.** The operator API and generation console remain local until Michael explicitly deploys them. A configured key is not proof of a live connection; only a successful provider-call event in a real run proves that call. Missing-key mode displays "Provider not configured" and never fabricates data. Local development can deliberately use records marked `[FIXTURE]`, which are fake and must never be treated as prospects.

## Generate 5 workflow

`Generate` is the primary operator surface. One command creates a durable run with the visible stages `Discovered → Researching → Contact found → Qualified → Message ready`, plus a separate rejected/retry lane. It searches beyond the requested five up to the operator-set 50-candidate ceiling and stops only when the ready target is reached or the honest candidate pool is exhausted.

Every ready packet contains the company and official site, current decision-maker candidate, exact contact route and verification state, cited facts, one observable opportunity, one matched client service, qualification rationale, proposed fit/evidence scores, a prefilled six-check audit, confidence/exceptions, and three alternative messages. These are proposals. The operator must open every source, accept or reject every fact, correct the scores, complete all six checks, and choose exactly one message before one draft is created. That draft still passes the existing exact packet-hash approval gate; no send endpoint exists.

Client work is logically separated by client-owned offers, service-matching catalogs, campaign briefs, runs, packets, and reports. Canonical business identities and suppression remain global on purpose so an opt-out or prior contact cannot be bypassed by switching clients. This is a single-operator system, not a client portal or multi-tenant authorization boundary.

## Client offer boundary

Reemergence recommends the smallest responsible engagement after a free 30-minute fit consultation. The operator ladder is: **$500 Growth Systems Diagnostic**, a **private qualified-only $1,200 Proof Sprint**, the **$1,500/month Growth Systems Retainer**, and separately scoped/invoiced custom work. The private Proof Sprint is a fallback for a qualified buyer who needs a contained working proof; it is not publicly advertised.

Every paid engagement follows the same sequence: written scope or agreement, signature, cleared initial payment, then work begins. The retainer provides prioritized access to Michael's complete service stack within an agreed monthly plan; it is not unlimited simultaneous production. Paid media, hosting, data, software, and other third-party fees are client-paid, and unusually large custom builds require a separately approved scope. No outcome is guaranteed.

## Sales Call Console

The authenticated console now records a booked LinkedIn call, structured discovery, an exact server-owned offer snapshot, and three independent facts: call status, agreement status, and payment status. It rejects direct signed/paid transitions. Stripe links are returned only for a signed client through a protected route; retrieving a link does not mark it shared, and both manual sharing and cleared payment require explicit operator confirmation notes.

The operator offer ladder is a free 30-minute fit consultation, a $500 diagnostic, a private qualified-only $1,200 proof sprint, a $1,500/month retainer, and separately invoiced custom work. These are right-sized recommendations, not a public checkout menu. The private proof sprint does not appear on the public site.

The current automated count is reported by `npm test`; the suite runs the real migration SQL against an in-memory SQLite/D1-compatible test database.

## $10k operating path

Reachwright is in the **owner-operated proof and revenue-validation stage**, not the client-workspace or autonomous-sending stage. The immediate job is to put Michael in front of companies with a current, cited reason to need copy capacity, then record the real funnel from manual message through retained revenue.

The built-in plan defaults to $10,000 target MRR, $1,500 average retained-client MRR, and seven required clients. It also exposes the close, show, booking, and reply assumptions so the operator can replace planning estimates with observed results. Software does not create the revenue on its own: sources still require human verification, sends are manual, and calls, agreements, payment, retention, and churn must be recorded honestly.

The staged commercial plan, capability gap, stop/build rules, and 30-day operating cadence are in `docs/revenue-operating-plan.md`.

## Product boundaries

The public marketing site remains self-contained. Calendly and Cloudflare Turnstile are the only planned browser-side third parties.

A production client service is different: it may require client-authorized research, CRM, ad, scheduling, and messaging providers. Each engagement needs a provider/data map, retention policy, access controls, suppression process, and client approval before activation. LinkedIn login scraping or prohibited automated activity is out of scope.

## Launch gates

- [ ] Complete and sign off the isolated live-five proof: five distinct, current, decision-maker-level packets passing every manual accuracy check, with zero drafts or sends.
- [ ] Select lawful, contract-compatible business data sources and document allowed uses.
- [ ] Establish commercial-email identity, valid postal address, unsubscribe handling, and suppression controls before email is enabled.
- [x] Build the operator approval queue; no message may leave from generated output alone. Pilot-test it on five real dossiers before production use.
- [x] Create and test the Cal.com fit-call event, Central timezone, intake question, organizer calendar, and public booking flow.
- [ ] Test cancellation/reschedule notifications with a real external attendee before a paid-client launch.
- [ ] Red-team Qualify rules across strong, uncertain, no-fit, prompt-injection, timeout, and provider-failure cases.
- [ ] Complete browser and assistive-technology QA; achieve Lighthouse accessibility of at least 90.
- [ ] Move to the custom domain and deliver CSP, frame-ancestors, referrer policy, permissions policy, and related controls as real HTTP headers.
- [ ] Document every production provider, field, retention period, and deletion/suppression path in the client data map.
- [ ] Obtain explicit owner approval before representing either engine as live.

## Deployment

GitHub Pages serves the static site from `main`. The Worker is a separate, deliberately blocked deployment. Publishing the site does not authorize or activate production outreach.

Public fit-call booking: <https://cal.com/michael-taylor-reemergence/copy-growth-fit-call>

---

&copy; 2026 ReeMergence Holdings.
