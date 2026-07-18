/**
 * LOCAL DEMO/TEST FIXTURE ADAPTER — NOT A DATA SOURCE.
 *
 * Loads ONLY when DEV_FIXTURES === "true" (dev/test configs). Production
 * configuration never sets that flag, so a missing Apollo key yields
 * "Provider not configured" — never sample data dressed as leads.
 * Every record carries provider "local-fixtures" and an unmistakable
 * "[FIXTURE]" name prefix so a fixture can never pass as a real prospect.
 */

const FIXTURE_ORGS = [
  { id: "fx-1", name: "[FIXTURE] Harbor Roofing Co", domain: "fixture-harbor-roofing.example",
    city: "Champaign", state: "Illinois", country: "United States", phone: "+1 217 555 0101",
    employees: 18, industry: "construction", keywords: ["roofing", "commercial"] },
  { id: "fx-2", name: "[FIXTURE] Lakeside Med Spa", domain: "fixture-lakeside-medspa.example",
    city: "Naperville", state: "Illinois", country: "United States", phone: "+1 331 555 0155",
    employees: 9, industry: "wellness", keywords: ["medspa", "aesthetics"] },
  { id: "fx-3", name: "[FIXTURE] Harbor Roofing Company", domain: "fixture-harbor-roofing.example",
    city: "Champaign", state: "Illinois", country: "United States", phone: "+1 217 555 0101",
    employees: 18, industry: "construction", keywords: ["roofing"] }, // deliberate duplicate of fx-1
];

const FIXTURE_PEOPLE = [
  { id: "fxp-1", org: "fx-1", name: "[FIXTURE] Dana Example", title: "Owner", seniority: "owner",
    email: "owner@fixture-harbor-roofing.example", email_status: "verified",
    profile: "https://linkedin.com/in/fixture-dana-example" },
  { id: "fxp-2", org: "fx-2", name: "[FIXTURE] Riley Sample", title: "Director of Operations", seniority: "director",
    email: "", email_status: "unavailable" },
];

export function createFixtureProvider() {
  const observed = new Date().toISOString().slice(0, 10);

  const normalizeOrganization = (record) => ({
    provider: "local-fixtures",
    provider_id: record.id,
    name: record.name,
    domain: record.domain,
    website: `https://${record.domain}`,
    location: `${record.city}, ${record.state}, ${record.country}`,
    country: record.country,
    phone: record.phone,
    employee_count: record.employees,
    industry: record.industry,
    keywords: record.keywords,
    observed_at: observed,
    source_url: `https://example.invalid/fixtures/${record.id}`,
  });

  const normalizePerson = (record) => ({
    provider: "local-fixtures",
    provider_id: record.id,
    full_name: record.name,
    title: record.title,
    seniority: record.seniority,
    business_email: record.email,
    email_status: record.email_status,
    business_phone: "",
    public_profile_url: record.profile || "",
    organization_provider_id: record.org,
    observed_at: observed,
  });

  return {
    name: "local-fixtures",
    maxSearchBatch: 25,
    capabilities: {
      organization_search: true,
      people_search: true,
      organization_enrichment: true,
      person_enrichment: true,
    },
    async searchOrganizations(filters = {}) {
      const perPage = Math.min(Number(filters.perPage) || 25, 25);
      return {
        records: FIXTURE_ORGS.slice(0, perPage).map(normalizeOrganization),
        pagination: { page: 1, per_page: perPage, total_entries: FIXTURE_ORGS.length, total_pages: 1 },
      };
    },
    async searchPeople(organization) {
      const records = FIXTURE_PEOPLE
        .filter((p) => p.org === organization?.provider_id)
        .map(normalizePerson);
      return { records, pagination: { page: 1, per_page: records.length } };
    },
    async enrichOrganization(identifier) {
      const hit = FIXTURE_ORGS.find((o) => o.domain === identifier?.domain);
      return hit ? { record: normalizeOrganization(hit) } : { error: "no-match" };
    },
    async enrichPerson(identifier) {
      const hit = FIXTURE_PEOPLE.find((p) => p.id === identifier?.provider_id);
      return hit ? { record: normalizePerson(hit) } : { error: "no-match" };
    },
    estimateCredits(request) {
      return { operation: String(request?.operation || "unknown"), estimated: 0, basis: "fixtures are free and fake" };
    },
    normalizeOrganization,
    normalizePerson,
    async healthCheck() {
      return { ok: true, provider: "local-fixtures", detail: "fixtures only — not real data" };
    },
  };
}
