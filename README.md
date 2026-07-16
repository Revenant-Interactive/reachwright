# Reachwright

**Find the right prospects. Convert the right ones.** Reachwright is a two-engine managed growth system from ReeMergence Holdings:

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
| `migrations/` | D1 schema (`0001_init.sql`) + dev-only seed |
| `docs/` | data map, security model, compliance boundaries, deployment, operator runbook, verified provider docs |
| `tests/` | Scout logic, Qualify flow, and end-to-end API tests (node:test; real schema via node:sqlite shim) |

## What exists today

- A static public product site (live on GitHub Pages).
- A deterministic browser-only preview of Scout and Qualify.
- **Built and locally verified, NOT deployed:** the full operator layer — campaign briefs, provider-adapter interface with a documentation-verified Apollo adapter, evidence ledger with provenance, playbook-rubric scoring, cross-channel suppression, approval-gated outreach drafts with content hashing and edit-invalidation, CSV export (email gated behind CAN-SPAM controls), qualification flow builder with versioning, bookings (booked ≠ held), reporting, and audit trail. 44 automated tests pass. Local setup: `docs/deployment.md`.
- An undeployed Qualify conversation worker for a future live-AI mode.

**Nothing in this repository is deployed beyond the static site.** No prospect has been searched, no outreach sent, no AI provider called. Scout search requires an Apollo key that has never been configured; without one the console displays "Provider not configured" — it never fabricates data. Public copy must continue to distinguish the designed service from deployed software.

## Product boundaries

The public marketing site remains self-contained. Calendly and Cloudflare Turnstile are the only planned browser-side third parties.

A production client service is different: it may require client-authorized research, CRM, ad, scheduling, and messaging providers. Each engagement needs a provider/data map, retention policy, access controls, suppression process, and client approval before activation. LinkedIn login scraping or prohibited automated activity is out of scope.

## Launch gates

- [ ] Approve the Scout ICP schema, evidence ledger, scoring rubric, suppression model, and five manually verified sample dossiers.
- [ ] Select lawful, contract-compatible business data sources and document allowed uses.
- [ ] Establish commercial-email identity, valid postal address, unsubscribe handling, and suppression controls before email is enabled.
- [ ] Build the operator approval queue; no message may leave from generated output alone.
- [ ] Create and test the booking event, timezone, attribution, routing, and cancellation behavior.
- [ ] Red-team Qualify rules across strong, uncertain, no-fit, prompt-injection, timeout, and provider-failure cases.
- [ ] Complete browser and assistive-technology QA; achieve Lighthouse accessibility of at least 90.
- [ ] Move to the custom domain and deliver CSP, frame-ancestors, referrer policy, permissions policy, and related controls as real HTTP headers.
- [ ] Document every production provider, field, retention period, and deletion/suppression path in the client data map.
- [ ] Obtain explicit owner approval before representing either engine as live.

## Deployment

GitHub Pages serves the static site from `main`. The Worker is a separate, deliberately blocked deployment. Publishing the site does not authorize or activate production outreach.

---

&copy; 2026 ReeMergence Holdings.
