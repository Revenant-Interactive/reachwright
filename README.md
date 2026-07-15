# Reachwright

**Qualified sales calls, booked straight from the ad.** The flagship of ReeMergence Holdings.

This repo is the public demo website (GitHub Pages) plus the not-yet-deployed Cloudflare Worker that will power live-AI demo mode. The governing plan — grilled with the owner, then approved through 4 rounds of adversarial cross-model review — lives in the ReeMergence vault at `projects/ad-to-call-engine/PLAN.md`.

## Structure

| path | what |
|---|---|
| `index.html` | single-page site: hero, how-it-works, cited proof, live demo, offer, booking CTA |
| `styles.css` | self-contained design system (system fonts only, no external assets) |
| `demo.js` | scripted qualification demo — runs 100% in-browser, sends nothing anywhere |
| `privacy.html` | plain-English privacy notice |
| `worker/` | Cloudflare Worker for live-AI mode — **written, not deployed** (see `worker/wrangler.toml` header for the deploy checklist) |

## Current mode: scripted

The demo is the deterministic scripted track (which is also the permanent fallback once live mode ships). Flipping to live AI requires, in order: Cloudflare account → Turnstile widget → KV namespace → prepaid OpenRouter key (auto top-up **disabled**) → deploy dev, smoke-test, deploy prod → set `LIVE_ENDPOINT` in `demo.js` → add the Worker origin to `connect-src` and the Turnstile script/frame hosts to the page CSP.

## Launch checklist (gates from PLAN.md — all must pass before the URL is shared)

- [ ] Calendly event created; mailto CTA in `#book` replaced with the inline embed (+ CSP already allowlists Calendly)
- [ ] Demo completes on desktop Chrome/Firefox, iOS Safari, Android Chrome, FB/IG in-app browsers (incl. blocked-cookies pass)
- [ ] Scripted fallback verified by forcing each trigger (live mode only)
- [ ] Controlled TEST booking on the production event: correct timezone + attribution, then canceled
- [ ] Lighthouse accessibility ≥ 90
- [ ] Custom domain: DNS inventoried → domain verified in GitHub → Cloudflare-proxied DNS with security headers (CSP, frame-ancestors, referrer/permissions policies) via Transform Rules → apex + www tested → HTTPS enforced
- [ ] Owner reviews the deployed site and explicitly approves

## Deploy

Pushed to `main` → GitHub Pages serves it. Rollback: `git revert` + push.

---

© 2026 ReeMergence Holdings · Built as part of the [ad-to-call engine] project.
