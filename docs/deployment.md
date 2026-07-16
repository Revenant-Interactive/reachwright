# Reachwright deployment

## Local development (no Cloudflare account required)

```bash
npm install                 # installs wrangler (dev dependency)
npm run db:local            # applies migrations/0001_init.sql to the local D1 (SQLite)
npm run db:seed             # OPTIONAL dev-only sample campaign
echo 'OPERATOR_TOKEN=choose-a-long-random-dev-token' > .dev.vars
npm run api:dev             # operator API on http://localhost:8788 (dev env: fixtures ON)
npm run app:dev             # operator console on http://localhost:8123 → open /app/
npm test                    # full test suite
```

Note: `wrangler dev` reads `.dev.vars` from the directory of the config file — place it at `worker-api/.dev.vars` (git-ignored). Local dev uses the `dev` environment (`--env dev`), where `DEV_FIXTURES=true`; fixture records are prefixed `[FIXTURE]` and are not prospects.

To run the API dev server with the dev environment explicitly:
```bash
npx wrangler dev --config worker-api/wrangler.toml --env dev --local --port 8788
```

## Production (each step is Michael's explicit action)

1. **Cloudflare account** (free) + MFA.
2. **Create resources:** `wrangler d1 create reachwright` and `wrangler kv namespace create CACHE` (+ the Qualify worker's RATE/SESSIONS namespaces) → paste ids into the two `wrangler.toml` files (prod AND dev blocks).
3. **Apply migrations to remote D1:** `wrangler d1 execute reachwright --remote --config worker-api/wrangler.toml --file migrations/0001_init.sql`. **Never apply `dev-seed.sql` remotely.**
4. **Secrets:** `wrangler secret put OPERATOR_TOKEN` (long random), `wrangler secret put APOLLO_API_KEY` (master key). For the Qualify worker: `OPENROUTER_KEY` (prepaid, auto top-up OFF), `TURNSTILE_SECRET`.
5. **Deploy:** `wrangler deploy --config worker-api/wrangler.toml` (and `--config worker/wrangler.toml` when Qualify goes live). Set `APP_ORIGIN` to the real console origin first.
6. **Operator console hosting:** the `app/` folder is static; it can stay on GitHub Pages (it holds no secrets — the token is entered at sign-in) or move behind Cloudflare Access for defense in depth.
7. **Public site:** unchanged — GitHub Pages from `main`; custom-domain cutover per PLAN.md (DNS inventory → GitHub domain verification → Cloudflare-proxied DNS serving real security headers → apex+www tested → HTTPS).
8. **Rollback:** workers — `wrangler rollback` or redeploy the previous commit; site — `git revert` + push.

## Environment flags that matter

| var | prod value | meaning |
|---|---|---|
| `DEV_FIXTURES` | `false` (never true) | fixture provider is test/dev only |
| `EMAIL_GATE_PASSED` | `false` until the CAN-SPAM gate passes | blocks email exports server-side |
| `PROVIDER_CREDIT_CEILING` | set to the monthly budget | blocks searches that would exceed it |
| `APP_ORIGIN` | exact console origin | exact-origin browser check |
