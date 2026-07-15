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
| `worker/` | undeployed live-AI Qualify prototype and contract tests |

## What exists today

- A static public product site.
- A deterministic browser-only preview of Scout and Qualify.
- Written product controls: source provenance, unknown-state handling, suppression, human approval, deterministic qualification, and scripted fallback.
- An undeployed Worker prototype for a future live-AI Qualify conversation layer.

The site does **not** currently search for prospects, send outreach, connect to a CRM, book appointments, or call an AI provider. Public copy must continue to distinguish the designed service from deployed software.

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
