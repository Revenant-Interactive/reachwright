/**
 * Reachwright provider registry.
 *
 * Every data provider implements the same capability surface so nothing
 * outside this folder ever touches provider-specific response shapes:
 *
 *   searchOrganizations(filters)   → { records: [normalizedOrg], pagination }
 *   searchPeople(organization, personas) → { records: [normalizedPerson], pagination }
 *   enrichOrganization(identifier) → normalizedOrg | null
 *   enrichPerson(identifier)       → normalizedPerson | null
 *   estimateCredits(request)       → { operation, estimated, basis }
 *   normalizeOrganization(record)  → internal org shape
 *   normalizePerson(record)        → internal person shape
 *   healthCheck()                  → { ok, provider, detail }
 *
 * Selection rules (build spec):
 * - No key configured → production returns null and the UI shows
 *   "Provider not configured". Nothing silently returns sample leads.
 * - The fixture adapter loads ONLY when DEV_FIXTURES === "true", which the
 *   production wrangler config never sets.
 */

import { createApolloProvider } from "./apollo.js";
import { createFixtureProvider } from "./demo-fixtures.js";
import { createHunterProvider } from "./hunter.js";
import { createTavilyProvider } from "./tavily.js";

/**
 * Return every configured provider in a stable, free-first order. Legacy
 * research routes still use getProvider(); generation runs use this pool so
 * discovery, web research, and people resolution can cooperate and fall back
 * by capability. Fixtures are never mixed with live data.
 */
export function getProviders(env) {
  const configured = [];
  if (env.HUNTER_API_KEY) configured.push(createHunterProvider(env));
  if (env.TAVILY_API_KEY) configured.push(createTavilyProvider(env));
  if (env.APOLLO_API_KEY) configured.push(createApolloProvider(env));
  if (configured.length > 0) {
    const requested = String(env.PROSPECT_PROVIDER || "").trim().toLowerCase();
    const alias = requested === "tavily" ? "tavily-web" : requested;
    return configured.sort((a, b) => (a.name === alias ? -1 : b.name === alias ? 1 : 0));
  }
  return env.DEV_FIXTURES === "true" ? [createFixtureProvider(env)] : [];
}

export function generationSourcesStatus(env) {
  const providers = getProviders(env);
  return {
    configured: providers.length > 0,
    mode: providers.some((provider) => provider.name === "local-fixtures")
      ? "test-fixtures-only" : providers.length ? "configured-unverified" : "not-configured",
    providers: providers.map((provider) => ({
      provider: provider.name,
      live_connection_verified: false,
      capabilities: provider.capabilities || {},
      max_search_batch: Number(provider.maxSearchBatch) || 25,
    })),
    capabilities: {
      organization_search: providers.some((provider) => provider.capabilities?.organization_search !== false),
      people_search: providers.some((provider) => provider.capabilities?.people_search === true),
      person_enrichment: providers.some((provider) => provider.capabilities?.person_enrichment === true),
      official_website_research: true,
    },
  };
}

export function getProvider(env) {
  const requested = String(env.PROSPECT_PROVIDER || "").trim().toLowerCase();
  if (requested === "hunter") return env.HUNTER_API_KEY ? createHunterProvider(env) : null;
  if (requested === "tavily") return env.TAVILY_API_KEY ? createTavilyProvider(env) : null;
  if (requested === "apollo") return env.APOLLO_API_KEY ? createApolloProvider(env) : null;
  if (env.HUNTER_API_KEY) return createHunterProvider(env);
  if (env.APOLLO_API_KEY) return createApolloProvider(env);
  if (env.TAVILY_API_KEY) return createTavilyProvider(env);
  if (env.DEV_FIXTURES === "true") return createFixtureProvider(env);
  return null;
}

export function providerStatus(env) {
  const requested = String(env.PROSPECT_PROVIDER || "").trim().toLowerCase();
  if (requested === "hunter") {
    return env.HUNTER_API_KEY
      ? { configured: true, provider: "hunter", mode: "configured-unverified",
        live_connection_verified: false,
        capabilities: { organization_search: true, people_search: true, contact_enrichment: true } }
      : { configured: false, provider: "hunter", mode: "missing-key" };
  }
  if (requested === "tavily") {
    return env.TAVILY_API_KEY
      ? { configured: true, provider: "tavily-web", mode: "configured-unverified",
        live_connection_verified: false, capabilities: { organization_search: true, people_search: false, contact_enrichment: false } }
      : { configured: false, provider: "tavily-web", mode: "missing-key" };
  }
  if (requested === "apollo") {
    return env.APOLLO_API_KEY
      ? { configured: true, provider: "apollo", mode: "configured-unverified", live_connection_verified: false }
      : { configured: false, provider: "apollo", mode: "missing-key" };
  }
  if (env.HUNTER_API_KEY) {
    return { configured: true, provider: "hunter", mode: "configured-unverified",
      live_connection_verified: false,
      capabilities: { organization_search: true, people_search: true, contact_enrichment: true } };
  }
  if (env.APOLLO_API_KEY) {
    return { configured: true, provider: "apollo", mode: "configured-unverified",
      live_connection_verified: false };
  }
  if (env.TAVILY_API_KEY) {
    return { configured: true, provider: "tavily-web", mode: "configured-unverified",
      live_connection_verified: false,
      capabilities: { organization_search: true, people_search: false, contact_enrichment: false } };
  }
  if (env.DEV_FIXTURES === "true") {
    return { configured: true, provider: "local-fixtures", mode: "test-fixtures-only" };
  }
  return { configured: false, provider: null, mode: "not-configured" };
}
