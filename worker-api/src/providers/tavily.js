/**
 * Tavily Search adapter — free-first public-web discovery for the manual pilot.
 *
 * Tavily is NOT a people/contact database. It discovers candidate company
 * websites from public search results. Every returned record remains secondary,
 * unverified evidence and must pass Reachwright's normal fact-audit gates.
 *
 * Verified against https://docs.tavily.com/documentation/api-reference/endpoint/search
 * and /documentation/api-credits on 2026-07-16.
 */

const BASE = "https://api.tavily.com";
const MAX_RESULTS = 20;
const BLOCKED_DISCOVERY_HOSTS = new Set([
  "bbb.org", "chamberofcommerce.com", "crunchbase.com", "facebook.com",
  "glassdoor.com", "indeed.com", "instagram.com", "linkedin.com",
  "mapquest.com", "wikipedia.org", "yellowpages.com", "yelp.com",
  "youtube.com", "zoominfo.com",
]);

export function createTavilyProvider(env) {
  const key = env.TAVILY_API_KEY;
  const timeoutMs = Number.parseInt(env.PROVIDER_TIMEOUT_MS || "15000", 10);

  async function call(path, { method = "GET", body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${BASE}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${key}`,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (response.status === 429) return { error: "rate-limited", status: 429 };
      if (response.status === 401) return { error: "auth-failed", status: 401 };
      if (response.status === 432) return { error: "credit-limit", status: 432 };
      if (response.status === 433) return { error: "request-limit", status: 433 };
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
    const sourceUrl = safeHttpUrl(record.url);
    if (!sourceUrl) return null;
    const host = new URL(sourceUrl).hostname.toLowerCase().replace(/^www\./, "");
    if (!host || [...BLOCKED_DISCOVERY_HOSTS].some((blocked) => host === blocked || host.endsWith(`.${blocked}`))) return null;
    const title = cleanTitle(record.title) || host;
    return {
      provider: "tavily-web",
      provider_id: sourceUrl,
      name: title,
      domain: host,
      website: new URL(sourceUrl).origin,
      location: "",
      country: "",
      phone: "",
      employee_count: null,
      industry: "",
      keywords: [],
      observed_at: new Date().toISOString().slice(0, 10),
      source_url: sourceUrl,
      evidence_claim: `Tavily returned a public-web result titled “${title}”. This is a discovery candidate, not a verified business fact.`,
    };
  }

  function normalizePerson() {
    return null;
  }

  return {
    name: "tavily-web",
    maxSearchBatch: MAX_RESULTS,
    capabilities: {
      organization_search: true,
      people_search: false,
      organization_enrichment: false,
      person_enrichment: false,
    },

    async searchOrganizations(filters = {}) {
      const maxResults = Math.min(Math.max(1, Number(filters.perPage) || 5), MAX_RESULTS);
      const query = buildQuery(filters);
      const result = await call("/search", {
        method: "POST",
        body: {
          query,
          topic: "general",
          search_depth: "basic",
          max_results: maxResults,
          include_answer: false,
          include_raw_content: false,
          include_images: false,
        },
      });
      if (result.error) return { error: result.error };
      const records = (result.data?.results ?? []).map(normalizeOrganization).filter(Boolean);
      return {
        records,
        pagination: {
          page: 1,
          per_page: maxResults,
          total_entries: records.length,
          total_pages: 1,
        },
      };
    },

    async searchPeople() {
      return { records: [], pagination: { page: 1, per_page: 0, total_entries: 0, total_pages: 1 } };
    },

    async enrichOrganization() {
      return { error: "unsupported-capability" };
    },

    async enrichPerson() {
      return { error: "unsupported-capability" };
    },

    estimateCredits(request) {
      if (request?.operation === "searchOrganizations") {
        const requests = Math.max(1, Number(request.pages) || 1);
        return { operation: request.operation, estimated: requests, basis: "1 Tavily credit per basic web search" };
      }
      return {
        operation: String(request?.operation || "unknown"),
        estimated: 0,
        basis: "Tavily web discovery does not provide people search or contact enrichment",
      };
    },

    normalizeOrganization,
    normalizePerson,

    async healthCheck() {
      const result = await call("/usage");
      if (result.error) return { ok: false, provider: "tavily-web", detail: result.error };
      return { ok: true, provider: "tavily-web", detail: "authenticated", usage: result.data?.key ?? null };
    },
  };
}

function buildQuery(filters) {
  const locations = cleanList(filters.locations);
  const keywords = cleanList(filters.keywords);
  const name = typeof filters.name === "string" ? filters.name.trim() : "";
  const subject = name ? `“${name}”` : (keywords.join(" ") || "local business");
  const geography = locations.length ? ` in ${locations.join(" or ")}` : "";
  return `${subject}${geography} official company website -directory -marketplace`;
}

function cleanList(values) {
  return Array.isArray(values) ? values.map((value) => String(value).trim()).filter(Boolean) : [];
}

function cleanTitle(value) {
  if (typeof value !== "string") return "";
  return value.trim()
    .replace(/\s+[|–—-]\s+(home|official site|official website)$/i, "")
    .replace(/\s+[|–—]\s+.+$/, "")
    .slice(0, 200)
    .trim();
}

function safeHttpUrl(value) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value.trim());
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}
