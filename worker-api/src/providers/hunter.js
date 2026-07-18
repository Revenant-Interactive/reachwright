/**
 * Hunter adapter — free-first small-business and decision-maker discovery.
 *
 * Free-plan surface verified 2026-07-16:
 * - Discover: company search, free request, free-plan pagination fixed by Hunter.
 * - Domain Search: up to 10 professional emails/domain, 1 credit when results return.
 * - Email Finder: selected-person professional email, 1 credit when found.
 * - Company Enrichment: firmographics for one domain, 0.2 credit only when
 *   Hunter returns all of its documented core company data points.
 * - Account: free usage/health check.
 *
 * Reachwright never stores Hunter phone numbers or automates sending.
 */

const BASE = "https://api.hunter.io/v2";
const MAX_COMPANIES = 25;
const DECISION_MAKER_TITLE = /\b(owner|co[- ]?founder|founder|chief executive|ceo|president|principal|managing (?:partner|director|member)|general manager|partner)\b/i;
const VICE_PRESIDENT_TITLE = /\b(?:vice[\s-]*president|(?:s|e|a)?vp)\b/i;
const GENERIC_CONTACT_NAME = /^(?:client services?|customer services?|sales team|marketing team|support team|contact team|business development|general office)$/i;

export function createHunterProvider(env) {
  const key = env.HUNTER_API_KEY;
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
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (response.status === 429) return { error: "rate-limited", status: 429 };
      if (response.status === 401) return { error: "auth-failed", status: 401 };
      if (response.status === 403) return { error: "plan-restricted", status: 403 };
      if (response.status === 400) return { error: hunterError(await response.json()), status: 400 };
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
    const domain = normalizeDomain(record.domain);
    if (!domain) return null;
    const name = str(record.organization) || domain;
    return {
      provider: "hunter-discover",
      provider_id: domain,
      name,
      domain,
      website: `https://${domain}`,
      location: "",
      country: "",
      phone: "",
      employee_count: null,
      industry: "",
      keywords: [],
      observed_at: today(),
      source_url: "",
      evidence_claim: `Hunter Discover returned ${name} (${domain}) as a company candidate. Company identity, location, and fit still require first-party verification.`,
    };
  }

  function normalizePerson(record, organizationId = "") {
    if (!record || typeof record !== "object") return null;
    const fullName = [str(record.first_name), str(record.last_name)].filter(Boolean).join(" ");
    const title = str(record.position ?? record.position_raw);
    const email = str(record.value ?? record.email);
    if (!fullName || GENERIC_CONTACT_NAME.test(fullName) || !title || !email || !isDecisionMakerTitle(title)) return null;
    const verification = str(record.verification?.status ?? record.status).toLowerCase();
    return {
      provider: "hunter-domain",
      provider_id: email.toLowerCase(),
      full_name: fullName,
      title,
      seniority: str(record.seniority) || "executive",
      business_email: email,
      email_status: verification === "valid" ? "verified" : (verification || "unknown"),
      business_phone: "",
      public_profile_url: linkedinUrl(record.linkedin),
      organization_provider_id: organizationId,
      observed_at: validDate(record.verification?.date) || today(),
    };
  }

  return {
    name: "hunter",
    maxSearchBatch: MAX_COMPANIES,
    capabilities: {
      organization_search: true,
      people_search: true,
      organization_enrichment: true,
      person_enrichment: true,
    },

    async searchOrganizations(filters = {}) {
      const body = discoverFilters(filters);
      const result = await call("POST", "/discover", { body });
      if (result.error) return { error: result.error };
      const perPage = Math.min(Math.max(1, Number(filters.perPage) || 10), MAX_COMPANIES);
      const records = (result.data?.data ?? []).map(normalizeOrganization).filter(Boolean).slice(0, perPage);
      return {
        records,
        pagination: {
          page: 1,
          per_page: perPage,
          total_entries: records.length,
          total_pages: 1,
        },
      };
    },

    async searchPeople(organization) {
      const domain = normalizeDomain(organization?.domain);
      if (!domain) return { error: "domain-required" };
      const result = await call("GET", "/domain-search", {
        query: { domain, limit: "10", type: "personal", required_field: "full_name,position" },
      });
      if (result.error) return { error: result.error };
      const records = (result.data?.data?.emails ?? [])
        .map((record) => normalizePerson(record, domain)).filter(Boolean)
        .sort((a, b) => decisionMakerRank(a.title) - decisionMakerRank(b.title));
      return { records, pagination: { page: 1, per_page: 10, total_entries: records.length, total_pages: 1 } };
    },

    async enrichOrganization() {
      return { error: "unsupported-capability" };
    },

    async enrichPerson(identifier) {
      const domain = normalizeDomain(identifier?.domain);
      const fullName = str(identifier?.full_name);
      if (!domain || !fullName) return { error: "domain-and-name-required" };
      const result = await call("GET", "/email-finder", { query: { domain, full_name: fullName } });
      if (result.error) return { error: result.error };
      const data = result.data?.data;
      const normalized = normalizePerson({
        ...data,
        value: data?.email,
        position: data?.position || identifier?.title,
        verification: { status: data?.verification?.status || data?.status || "valid", date: data?.verification?.date },
      }, domain);
      return normalized ? { record: normalized } : { error: "no-decision-maker-match" };
    },

    estimateCredits(request) {
      switch (request?.operation) {
        case "searchOrganizations":
          return { operation: request.operation, estimated: 0, basis: "Hunter Discover is free" };
        case "searchPeople":
          return { operation: request.operation, estimated: 1, basis: "1 Hunter credit for 1–10 Domain Search results" };
        case "enrichPerson":
          return { operation: request.operation, estimated: 1, basis: "1 Hunter credit when Email Finder returns an address" };
        default:
          return { operation: String(request?.operation || "unknown"), estimated: 0, basis: "unsupported or free operation" };
      }
    },

    normalizeOrganization,
    normalizePerson,

    async healthCheck() {
      const result = await call("GET", "/account");
      if (result.error) return { ok: false, provider: "hunter", detail: result.error };
      return { ok: true, provider: "hunter", detail: "authenticated", usage: result.data?.data?.requests ?? null };
    },
  };
}

function discoverFilters(filters) {
  const body = {
    headcount: mapHeadcounts(filters.employeeRanges),
    company_type: { include: ["privately held", "self employed", "self owned", "sole proprietorship"] },
  };
  const keywords = cleanList(filters.keywords);
  if (keywords.length) body.keywords = { match: "any", include: keywords };
  const locations = cleanList(filters.locations).map(parseUsLocation).filter(Boolean);
  if (locations.length) body.headquarters_location = { include: locations };
  if (str(filters.name)) body.organization = { name: [str(filters.name)] };
  return body;
}

function mapHeadcounts(ranges) {
  const input = cleanList(ranges).join(" ");
  if (!input) return ["1-10", "11-50", "51-200"];
  const buckets = [
    ["1-10", 10], ["11-50", 50], ["51-200", 200], ["201-500", 500],
    ["501-1000", 1000], ["1001-5000", 5000], ["5001-10000", 10000], ["10001+", Infinity],
  ];
  const numbers = [...input.matchAll(/\d+/g)].map((match) => Number(match[0]));
  if (!numbers.length) return ["1-10", "11-50", "51-200"];
  const max = Math.max(...numbers);
  return buckets.filter(([, upper]) => upper <= max || upper === buckets.find(([, upperBound]) => upperBound >= max)?.[1])
    .map(([label]) => label);
}

function parseUsLocation(value) {
  const parts = String(value).split(",").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return null;
  const state = stateCode(parts.at(-1));
  if (state) return { country: "US", state, ...(parts.length > 1 ? { city: parts[0] } : {}) };
  if (/^(united states|usa|us)$/i.test(parts.at(-1))) return { country: "US", ...(parts.length > 1 ? { city: parts[0] } : {}) };
  return null;
}

function stateCode(value) {
  const key = String(value).trim().toLowerCase();
  if (/^[a-z]{2}$/i.test(key)) return key.toUpperCase();
  return US_STATES[key] || "";
}

const US_STATES = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID",
  illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "district of columbia": "DC",
};

function hunterError(body) {
  const code = body?.errors?.[0]?.id || body?.errors?.[0]?.code;
  return code ? `invalid-request:${code}` : "invalid-request";
}

function isDecisionMakerTitle(title) {
  const value = str(title);
  if (!value) return false;
  // "Vice President …" would otherwise satisfy the \bpresident\b branch below.
  if (VICE_PRESIDENT_TITLE.test(value)) return false;
  return DECISION_MAKER_TITLE.test(value);
}

function decisionMakerRank(title) {
  const value = str(title).toLowerCase();
  if (/\b(owner|founder|co-founder)\b/.test(value)) return 0;
  if (/\b(ceo|chief executive|president)\b/.test(value)) return 1;
  return 2;
}

function linkedinUrl(value) {
  const raw = str(value);
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://www.linkedin.com/in/${raw.replace(/^@/, "")}`;
}

function normalizeDomain(value) {
  const raw = str(value).toLowerCase();
  if (!raw) return "";
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function cleanList(values) {
  return Array.isArray(values) ? values.map((value) => str(value)).filter(Boolean) : [];
}

function validDate(value) {
  const raw = str(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function str(value) {
  return typeof value === "string" ? value.trim() : "";
}
