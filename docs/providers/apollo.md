# Apollo.io — verified provider surface

_Verified against https://docs.apollo.io/ on **2026-07-15**. Re-verify before any deployment; Apollo revises endpoints and plan gating._

## Endpoints Reachwright uses

| capability | verified endpoint | doc | notes |
|---|---|---|---|
| searchOrganizations | `POST https://api.apollo.io/api/v1/mixed_companies/search` | [Organization Search](https://docs.apollo.io/reference/organization-search) | **Consumes credits per page when data returns.** 100/page max, 500-page display limit. Filters used: `organization_locations[]`, `q_organization_keyword_tags[]`, `organization_num_employees_ranges[]`, `q_organization_name`, `q_organization_domains_list[]`. |
| searchPeople | `POST https://api.apollo.io/api/v1/mixed_people/api_search` | [People API Search](https://docs.apollo.io/reference/people-api-search) | **Requires a MASTER API key.** Consumes **no credits**; returns **no emails or phone numbers**. Filters used: `organization_ids[]`, `q_organization_domains_list[]`, `person_titles[]`, `person_seniorities[]`. Note the path is `api_search`, not the older `search`. |
| enrichOrganization | `GET https://api.apollo.io/api/v1/organizations/enrich` | [Organization Enrichment](https://docs.apollo.io/reference/organization-enrichment) | Query params `domain` / `name`. Credits per enriched record. Bulk variant exists (≤10/call), unused in MVP. |
| enrichPerson | `POST https://api.apollo.io/api/v1/people/match` | [People Enrichment](https://docs.apollo.io/reference/people-enrichment) | Credits per enriched record. `reveal_personal_emails` is **hard-set false** (business-contact policy; GDPR-respecting). `reveal_phone_number` requires an async webhook — **not used** in MVP. Bulk variant exists (≤10/call). |

## Authentication

- Header: **`x-api-key: <key>`** on every request ([Authentication](https://docs.apollo.io/reference/authentication)). Keys are created in the Apollo developer dashboard.
- Standard keys are endpoint-scoped; **people search requires a master key** — create the key as master.
- The key lives ONLY in the Worker secret store (`wrangler secret put APOLLO_API_KEY`). Never in code, never in the browser, never in Git.

## Rate limits, errors, plan gates

- Fixed-window per-minute limits, plan-dependent ([Rate Limits](https://docs.apollo.io/reference/rate-limits)); a "View API Usage Stats" endpoint reports live limits.
- `429` = rate limited; `403` = plan restriction; `401` = bad key. The adapter maps these to `rate-limited` / `plan-restricted` / `auth-failed` and every route degrades to an explicit provider-failure response — never silent sample data.

## Reachwright self-caps (below any plan limit)

- `per_page ≤ 25`, `pages ≤ 4` per run, campaign `max_batch_size ≤ 100` enforced server-side.
- Every call is metered into `provider_usage` with a **conservative** credit estimate before it happens; a monthly `PROVIDER_CREDIT_CEILING` blocks searches that would exceed it.
- Credit estimates deliberately assume worst case (org search ≤1 credit per returned record per page). Reconcile against the Apollo dashboard and record actuals in `credits_reported`.

## Permitted use / storage posture

Apollo's terms govern how exported records may be stored and used; the docs pages verified above do not spell out storage restrictions, so **treat Apollo data as licensed, not owned**: store only what the workflow needs (name, domain, location, title, business email, provider id), record provenance and observed dates, honor deletion/suppression requests, and re-verify terms before production use. Personal-email reveals stay off.
