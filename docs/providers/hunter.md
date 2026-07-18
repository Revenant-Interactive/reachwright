# Hunter — free-first small-business and decision-maker data

_Verified against Hunter's official API documentation, Free Plan guide, and pricing FAQ on **2026-07-16**. Re-verify before production deployment._

## Free-plan capacity

Hunter currently includes 50 credits per month and API access on its Free plan. Company Discover requests are free. Domain Search costs one credit when it returns 1–10 professional emails for a domain. Email Finder costs one credit when it finds a selected person's professional email. This is enough for the five-dossier manual pilot without buying Apollo.

## Reachwright usage

- `POST /v2/discover` finds small businesses using geography, keywords, 1–200 employee bands, and privately held/self-owned/sole-proprietor company types. Reachwright does not send premium-only pagination fields.
- `GET /v2/domain-search` requests up to the Free plan's 10-result limit, then retains only owner, founder, CEO, president, principal, managing partner/director/member, general manager, or partner titles.
- `GET /v2/email-finder` is reserved for a selected named decision-maker.
- `GET /v2/account` performs a free authentication/usage check.

Provider geography and fit filters are not promoted into verified facts. Every company and person still requires first-party/authoritative evidence and the six-check dossier audit. Phone numbers returned by Hunter are discarded; no send automation exists.

## Setup

1. Create a free Hunter account and API key.
2. Add `HUNTER_API_KEY=...` to `worker-api/.dev.vars`.
3. Keep production `PROSPECT_PROVIDER="hunter"` to prioritize Hunter. Generation still uses other configured live providers cooperatively.
4. Restart the API and confirm Hunter appears under **Settings → Generation sources**. Configuration is not a live check; a successful `provider-call` run event proves the request worked.
