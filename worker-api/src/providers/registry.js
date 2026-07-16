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

export function getProvider(env) {
  if (env.APOLLO_API_KEY) return createApolloProvider(env);
  if (env.DEV_FIXTURES === "true") return createFixtureProvider(env);
  return null;
}

export function providerStatus(env) {
  if (env.APOLLO_API_KEY) return { configured: true, provider: "apollo", mode: "live" };
  if (env.DEV_FIXTURES === "true") {
    return { configured: true, provider: "local-fixtures", mode: "test-fixtures-only" };
  }
  return { configured: false, provider: null, mode: "not-configured" };
}
