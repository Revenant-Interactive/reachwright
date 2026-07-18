# Tavily Search — company-web fallback

_Verified against Tavily's official API reference and credit documentation on **2026-07-16**. Re-verify before production deployment._

## Why it remains available

Tavily's Researcher tier currently provides 1,000 API credits per month with no credit card required. Reachwright uses it alongside Hunter to broaden company-web discovery, or as a company-only fallback when Hunter is unavailable. It cannot satisfy the owner/CEO contact requirement by itself, so a Tavily-only run will reject candidates unless a permitted existing/manual decision-maker route is already present.

## Honest capability boundary

Tavily is a public-web search source, not a licensed people/contact database. The adapter:

- builds a company-discovery query from campaign keywords and geography;
- stores the result title, canonical URL/domain, observed date, and provider provenance;
- filters common directory, social, employment, and data-broker domains;
- leaves location, industry, employee count, phone, and people/contact fields unknown;
- labels every provider evidence row as an unverified discovery candidate;
- provides no people search or email/phone enrichment.

Every candidate must still be checked against first-party or authoritative evidence. The normal suppression, dedupe, six-check dossier audit, score fingerprint, packet approval, edit invalidation, and one-message policy remain unchanged.

## Authentication and errors

The key is sent server-side as `Authorization: Bearer <TAVILY_API_KEY>` and lives only in `.dev.vars` locally or the Worker secret store in production. The adapter maps 401, 429, 432, 433, timeout, and network failures to explicit provider errors and never substitutes fixtures or invented records.

## Setup

1. Create a free key at `https://app.tavily.com`.
2. Add `TAVILY_API_KEY=tvly-...` to `worker-api/.dev.vars`.
3. Leave `PROSPECT_PROVIDER="hunter"` or `auto` when Hunter is also configured; set `tavily` only to prioritize its company results.
4. Restart `npm run api:dev` and confirm Tavily appears under **Settings → Generation sources**. A successful run event, not the presence of a key, proves the live connection.
