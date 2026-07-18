# Reachwright deployment

## Local development (no Cloudflare account required)

```bash
npm install                 # installs wrangler (dev dependency)
npm run db:local            # safely adopts old local state, then applies every pending migration
npm run db:seed             # OPTIONAL dev-only sample campaign
npm run api:dev             # operator API on http://localhost:8788 (dev env: fixtures ON)
npm run app:dev             # operator console on http://localhost:8123 → open /app/
npm test                    # full test suite
```

Before `api:dev`, create the git-ignored secret file at the **config directory**, not the repository root. `HUNTER_API_KEY` is optional until you create the free key; manual intake works without it:

```bash
printf 'OPERATOR_TOKEN=choose-a-long-random-dev-token\nHUNTER_API_KEY=your-free-hunter-key\nTAVILY_API_KEY=your-optional-free-tavily-key\nREEMERGENCE_DIAGNOSTIC_PAYMENT_LINK=https://buy.stripe.com/your-link\nREEMERGENCE_PROOF_SPRINT_PAYMENT_LINK=https://buy.stripe.com/your-private-link\nREEMERGENCE_RETAINER_PAYMENT_LINK=https://buy.stripe.com/your-link\n' > worker-api/.dev.vars
```

PowerShell equivalent:

```powershell
Set-Content -LiteralPath worker-api/.dev.vars -Value @(
  'OPERATOR_TOKEN=choose-a-long-random-dev-token',
  'HUNTER_API_KEY=your-free-hunter-key',
  'TAVILY_API_KEY=your-optional-free-tavily-key',
  'REEMERGENCE_DIAGNOSTIC_PAYMENT_LINK=https://buy.stripe.com/your-link',
  'REEMERGENCE_PROOF_SPRINT_PAYMENT_LINK=https://buy.stripe.com/your-private-link',
  'REEMERGENCE_RETAINER_PAYMENT_LINK=https://buy.stripe.com/your-link'
)
```

The npm scripts explicitly use the `dev` environment, where `PROSPECT_PROVIDER=auto` and `DEV_FIXTURES=true`. Generation uses **every configured live source cooperatively** in free-first order: Hunter for company plus owner/CEO discovery, Tavily for additional company-web discovery, optional Apollo only when funded, then bounded research of each official site. `PROSPECT_PROVIDER` only prioritizes one source; it does not disable the other configured sources for a generation run. Fixtures load only when no live key exists, are prefixed `[FIXTURE]`, and are never mixed with live data. Fixtures are not prospects. `db:local` is safe to rerun and uses Wrangler's migration ledger after adopting schemas created by the older raw-SQL setup.

The three Reemergence payment-link values are bearer-like operational configuration: keep them only in `.dev.vars` locally and Worker secrets in production. The authenticated Sales Call Console reveals a configured link only after the offer's agreement is recorded as signed. It never calls Stripe, stores card data, receives webhooks, or treats retrieval as sharing/payment.

## Isolated live-five proof (no sending)

This acceptance run consumes real Hunter Domain Search credits. The default harness uses a fresh in-memory D1-compatible database loaded from the real migration SQL, so fixtures and old manual records cannot contaminate the proof. It calls the exact API handlers directly; no proof server is required:

```powershell
npm.cmd run proof:live-five -- --candidate-cap=25 --credit-budget=15 --location="United States" --keywords="roofing,remodeling,landscaping,hvac,plumbing"
```

The harness reads secrets without printing them, requires Hunter, requests Hunter-only discovery plus live official-site research, advances one bounded candidate at a time, refuses fixture/test domains, verifies five fresh packet structures, and verifies that zero messages were selected or sent. Private raw and masked artifacts are written under ignored `.wrangler/proof-five/`. Pass `--mode=http --base=http://localhost:8788` only when intentionally testing an already-running isolated API.

`AUTOMATED GATE PASSED — MANUAL REVIEW PENDING` is **not** proof. Open `manual-review.json` and complete every current-role, contact-route, market-fit, citation, opportunity, service-match, and message-traceability check for all five. If one fails, reject it for the true reason and replenish the run. Only five packets passing every manual check earn `PASS — LIVE FIVE-PROSPECT PROOF`.

## Production (each step is Michael's explicit action)

1. **Cloudflare account** (free) + MFA.
2. **Create resources:** `wrangler d1 create reachwright` and `wrangler kv namespace create CACHE` (+ the Qualify worker's RATE/SESSIONS namespaces) → paste ids into the two `wrangler.toml` files (prod AND dev blocks).
3. **Apply all pending migrations to remote D1:** `wrangler d1 migrations apply reachwright --remote --config worker-api/wrangler.toml`. **Never apply `dev-seed.sql` or `scripts/adopt-local-migrations.sql` remotely.**
4. **Secrets:** `wrangler secret put OPERATOR_TOKEN` (long random), `wrangler secret put HUNTER_API_KEY` (free-first small-business + decision-maker data), and the three `REEMERGENCE_*_PAYMENT_LINK` values. Tavily is an optional company-web fallback; Apollo is optional later. For the Qualify worker: `OPENROUTER_KEY` (prepaid, auto top-up OFF), `TURNSTILE_SECRET`.
5. **Deploy:** `wrangler deploy --config worker-api/wrangler.toml` (and `--config worker/wrangler.toml` when Qualify goes live). Set `APP_ORIGIN` to the real console origin first.
6. **Operator console hosting:** the `app/` folder is static; it can stay on GitHub Pages (it holds no secrets — the token is entered at sign-in) or move behind Cloudflare Access for defense in depth.
7. **Public site:** unchanged — GitHub Pages from `main`; custom-domain cutover per PLAN.md (DNS inventory → GitHub domain verification → Cloudflare-proxied DNS serving real security headers → apex+www tested → HTTPS).
8. **Rollback:** workers — `wrangler rollback` or redeploy the previous commit; site — `git revert` + push.

## Environment flags that matter

| var | prod value | meaning |
|---|---|---|
| `DEV_FIXTURES` | `false` (never true) | fixture provider is test/dev only |
| `PROSPECT_PROVIDER` | `hunter` initially | prioritizes the named source; generation still cooperates across every configured live provider |
| `EMAIL_GATE_PASSED` | `false` until the CAN-SPAM gate passes | blocks email exports server-side |
| `PROVIDER_CREDIT_CEILING` | set to the monthly budget | blocks searches that would exceed it |
| `WEBSITE_RESEARCH_TIMEOUT_MS` | `12000` initially | per-request timeout for bounded official-site research |
| `WEBSITE_RESEARCH_MAX_BYTES` | `300000` | maximum HTML bytes retained in memory per page; raw HTML is never stored |
| `WEBSITE_RESEARCH_MAX_PAGES` | `4` | same-site page ceiling per candidate |
| `APP_ORIGIN` | exact console origin | exact-origin browser check |
| `REEMERGENCE_DIAGNOSTIC_PAYMENT_LINK` | secret `https://buy.stripe.com/...` URL | protected $500 Diagnostic checkout |
| `REEMERGENCE_PROOF_SPRINT_PAYMENT_LINK` | secret `https://buy.stripe.com/...` URL | protected private qualified-only Proof Sprint checkout |
| `REEMERGENCE_RETAINER_PAYMENT_LINK` | secret `https://buy.stripe.com/...` URL | protected $1,500/month Retainer checkout |
