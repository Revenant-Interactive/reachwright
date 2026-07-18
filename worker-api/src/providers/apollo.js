/**
 * Apollo.io adapter — first licensed data provider behind the Reachwright
 * provider interface. Endpoints verified against https://docs.apollo.io/
 * on 2026-07-15; see docs/providers/apollo.md for the evidence trail.
 *
 * Verified surface used here:
 *   POST https://api.apollo.io/api/v1/mixed_companies/search   (org search; credits per page)
 *   POST https://api.apollo.io/api/v1/mixed_people/api_search  (people search; MASTER key; no credits; no emails/phones)
 *   GET  https://api.apollo.io/api/v1/organizations/enrich     (org enrichment; credits per record)
 *   POST https://api.apollo.io/api/v1/people/match             (person enrichment; credits per record)
 * Auth: x-api-key header. Pagination: page + per_page (max 100/page, 500 pages).
 * Rate limits: fixed-window per-minute, plan-dependent; 429 on exceed; 403 = plan restriction.
 *
 * Reachwright self-caps regardless of plan: per_page ≤ 25, pages ≤ 4 per run,
 * and every call is metered against PROVIDER_CREDIT_CEILING before it happens.
 */

const BASE = "https://api.apollo.io/api/v1";
const MAX_PER_PAGE = 25;   // server-owned batch cap, below Apollo's 100
const MAX_PAGE_NUMBER = 500;

export function createApolloProvider(env) {
  const key = env.APOLLO_API_KEY;
  const timeoutMs = Number.parseInt(env.PROVIDER_TIMEOUT_MS || "15000", 10);

  async function call(method, path, { query, body } = {}) {
    const url = new URL(`${BASE}${path}`);
    for (const [name, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(name, value);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        signal: controller.signal,
        headers: {
          "x-api-key": key,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (response.status === 429) return { error: "rate-limited", status: 429 };
      if (response.status === 403) return { error: "plan-restricted", status: 403 };
      if (response.status === 401) return { error: "auth-failed", status: 401 };
      if (!response.ok) return { error: `provider-${response.status}`, status: response.status };
      return { data: await response.json() };
    } catch (cause) {
      return { error: cause?.name === "AbortError" ? "provider-timeout" : "provider-network" };
    } finally {
      clearTimeout(timer);
    }
  }

  function normalizeOrganization(record) {
    if (!record || typeof record !== "object") return null;
    return {
      provider: "apollo",
      provider_id: String(record.id ?? record.organization_id ?? ""),
      name: str(record.name),
      domain: str(record.primary_domain ?? record.domain),
      website: str(record.website_url),
      location: [str(record.city), str(record.state), str(record.country)].filter(Boolean).join(", "),
      country: str(record.country),
      phone: str(record.phone ?? record.primary_phone?.number),
      employee_count: num(record.estimated_num_employees),
      industry: str(record.industry),
      keywords: Array.isArray(record.keywords) ? record.keywords.slice(0, 25).map(String) : [],
      observed_at: new Date().toISOString().slice(0, 10),
      source_url: record.id ? `https://app.apollo.io/#/organizations/${record.id}` : "",
    };
  }

  function normalizePerson(record) {
    if (!record || typeof record !== "object") return null;
    return {
      provider: "apollo",
      provider_id: str(record.id),
      full_name: str(record.name) || [str(record.first_name), str(record.last_name)].filter(Boolean).join(" "),
      title: str(record.title),
      seniority: str(record.seniority),
      business_email: str(record.email),           // present only after enrichment
      email_status: str(record.email_status) || "unknown",
      business_phone: "",                          // phone reveal requires webhook flow; not used in MVP
      public_profile_url: str(record.linkedin_url),
      organization_provider_id: str(record.organization_id ?? record.organization?.id),
      observed_at: new Date().toISOString().slice(0, 10),
    };
  }

  return {
    name: "apollo",
    capabilities: {
      organization_search: true,
      people_search: true,
      organization_enrichment: true,
      person_enrichment: true,
    },

    async searchOrganizations(filters = {}) {
      const perPage = Math.min(Number(filters.perPage) || MAX_PER_PAGE, MAX_PER_PAGE);
      const page = Math.min(Math.max(1, Number(filters.page) || 1), MAX_PAGE_NUMBER);
      const body = {
        page,
        per_page: perPage,
        ...(filters.locations?.length ? { organization_locations: filters.locations } : {}),
        ...(filters.keywords?.length ? { q_organization_keyword_tags: filters.keywords } : {}),
        ...(filters.employeeRanges?.length ? { organization_num_employees_ranges: filters.employeeRanges } : {}),
        ...(filters.name ? { q_organization_name: filters.name } : {}),
        ...(filters.domains?.length ? { q_organization_domains_list: filters.domains } : {}),
      };
      const result = await call("POST", "/mixed_companies/search", { body });
      if (result.error) return { error: result.error };
      const records = (result.data?.organizations ?? result.data?.accounts ?? [])
        .map(normalizeOrganization).filter(Boolean);
      return {
        records,
        pagination: {
          page,
          per_page: perPage,
          total_entries: num(result.data?.pagination?.total_entries),
          total_pages: num(result.data?.pagination?.total_pages),
        },
      };
    },

    async searchPeople(organization, personas = {}) {
      const body = {
        page: 1,
        per_page: Math.min(Number(personas.perPage) || 10, MAX_PER_PAGE),
        ...(organization?.provider_id ? { organization_ids: [organization.provider_id] } : {}),
        ...(organization?.domain ? { q_organization_domains_list: [organization.domain] } : {}),
        ...(personas.titles?.length ? { person_titles: personas.titles } : {}),
        ...(personas.seniorities?.length ? { person_seniorities: personas.seniorities } : {}),
      };
      const result = await call("POST", "/mixed_people/api_search", { body });
      if (result.error) return { error: result.error };
      const records = (result.data?.people ?? result.data?.contacts ?? [])
        .map(normalizePerson).filter(Boolean);
      return { records, pagination: { page: 1, per_page: body.per_page } };
    },

    async enrichOrganization(identifier) {
      const query = identifier?.domain ? { domain: identifier.domain }
        : identifier?.name ? { name: identifier.name } : null;
      if (!query) return { error: "identifier-required" };
      const result = await call("GET", "/organizations/enrich", { query });
      if (result.error) return { error: result.error };
      const normalized = normalizeOrganization(result.data?.organization);
      return normalized ? { record: normalized } : { error: "no-match" };
    },

    async enrichPerson(identifier) {
      const body = {};
      if (identifier?.provider_id) body.id = identifier.provider_id;
      if (identifier?.full_name) body.name = identifier.full_name;
      if (identifier?.domain) body.domain = identifier.domain;
      if (identifier?.organization_name) body.organization_name = identifier.organization_name;
      if (Object.keys(body).length === 0) return { error: "identifier-required" };
      // Business-contact policy: no personal email or mobile reveals in MVP.
      body.reveal_personal_emails = false;
      const result = await call("POST", "/people/match", { body });
      if (result.error) return { error: result.error };
      const normalized = normalizePerson(result.data?.person);
      return normalized ? { record: normalized } : { error: "no-match" };
    },

    /**
     * Conservative credit estimate. Apollo bills org search per page of
     * returned data and enrichment per record; people api_search is free.
     */
    estimateCredits(request) {
      switch (request?.operation) {
        case "searchOrganizations": {
          const pages = Math.min(Math.max(1, Number(request.pages) || 1), 4);
          const perPage = Math.min(Number(request.perPage) || MAX_PER_PAGE, MAX_PER_PAGE);
          return { operation: request.operation, estimated: pages * perPage, basis: "≤1 credit per returned record per page (conservative)" };
        }
        case "searchPeople":
          return { operation: request.operation, estimated: 0, basis: "people api_search consumes no credits (no emails/phones returned)" };
        case "enrichOrganization":
          return { operation: request.operation, estimated: 1, basis: "1 credit per enriched org record" };
        case "enrichPerson":
          return { operation: request.operation, estimated: 1, basis: "≥1 credit per enriched person; more if reveals enabled (they are not)" };
        default:
          return { operation: String(request?.operation || "unknown"), estimated: 0, basis: "unknown operation" };
      }
    },

    normalizeOrganization,
    normalizePerson,

    async healthCheck() {
      // Cheapest authenticated call: an enrichment probe on a known domain
      // costs ≤1 credit, so instead use an org search with per_page=1.
      const result = await call("POST", "/mixed_companies/search", { body: { page: 1, per_page: 1, q_organization_name: "apollo" } });
      if (result.error) return { ok: false, provider: "apollo", detail: result.error };
      return { ok: true, provider: "apollo", detail: "authenticated" };
    },
  };
}

function str(value) {
  return typeof value === "string" ? value.trim() : "";
}
function num(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}
