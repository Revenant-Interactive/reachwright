# Reachwright security model

## Surfaces

1. **Public marketing site** (GitHub Pages, static) — no secrets, no state, meta-CSP; real headers arrive with the Cloudflare-proxied custom domain (mandatory at domain launch).
2. **Public Qualify worker** (`worker/`) — anonymous visitors; hardened conversation contract.
3. **Operator API** (`worker-api/`) — single operator; everything authenticated.
4. **Operator console** (`app/`) — static JS; holds the bearer token in sessionStorage for the tab's lifetime; no secrets in source.

## Operator API controls

- **Authentication:** `Authorization: Bearer <OPERATOR_TOKEN>` on every `/api/*` route; SHA-256 constant-time comparison; a worker with a missing/short token refuses all requests rather than running open. Recommended production hardening: Cloudflare Access in front of the route (defense in depth), MFA on the Cloudflare account.
- **Origin:** browser requests must present the exact configured `APP_ORIGIN`; requests without an Origin header (curl, tests) rely on the token alone.
- **CSRF:** not applicable — no cookies; auth is a header only JS can attach.
- **Input:** JSON-only, `BODY_MAX_BYTES` cap, closed schemas (unknown keys rejected, strings length-limited, enums exact, arrays bounded).
- **Output:** `Cache-Control: no-store` + `nosniff` on every response; errors are short stable tokens, never stacks; the console renders all API data via `textContent` (no HTML injection from provider/model data).
- **SSRF:** the API fetches exactly one fixed external host (`api.apollo.io`); no user-supplied URL is ever fetched. Evidence `source_url` is stored/displayed, never retrieved server-side.
- **Batch/spend:** server-owned pagination caps (25/page, 4 pages), campaign batch caps, and a monthly provider credit ceiling checked before every search.
- **Audit:** every mutation writes `audit_events` (redacted detail).

## Qualify worker controls (unchanged safety model, v0.2)

Exact-origin validation → one-time Turnstile at `POST /session` → random 48-hex server session in KV (15-min TTL, IP-bound, server-owned turn count) → closed answer schema (unknown keys/values rejected) → deterministic verdicts (operator flow from D1 or built-in; the model NEVER chooses) → model output restricted to one screened ≤160-char sentence → every failure path returns `{fallback:true}` and the browser continues its scripted track. IP+prefix+global daily rate gates run most-specific-first. Spend ceiling is provider-enforced (prepaid key, auto top-up off).

## Secrets

| secret | store | notes |
|---|---|---|
| `OPERATOR_TOKEN` | worker-api secrets / `.dev.vars` locally | ≥16 chars enforced; rotate by `wrangler secret put` |
| `APOLLO_API_KEY` | worker-api secrets | master key; never client-side, never logged |
| `OPENROUTER_KEY` | qualify worker secrets | prepaid, auto top-up disabled |
| `TURNSTILE_SECRET` | qualify worker secrets | widget locked to the site host |

`.dev.vars`, `node_modules`, `.wrangler` are git-ignored. No secret value ever appears in logs, audit detail, or error responses.

## Known accepted risks

- KV rate counters are eventually consistent (Cloudflare-documented); the hard ceilings are provider-side prepaid limits and D1-recorded credit metering.
- A single bearer token is the operator gate; compromise = console access until rotation. Mitigations: HTTPS-only, sessionStorage (not persistent), short token lifetime by rotation policy, optional Cloudflare Access.
- GitHub Pages cannot set response headers; the public site's meta-CSP is defense-in-depth until the Cloudflare-proxied domain serves real headers.
