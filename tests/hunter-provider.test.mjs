import test from "node:test";
import assert from "node:assert/strict";
import { createHunterProvider } from "../worker-api/src/providers/hunter.js";
import { getProvider, providerStatus } from "../worker-api/src/providers/registry.js";

test("registry selects Hunter as the free people-capable provider", () => {
  const selected = getProvider({ PROSPECT_PROVIDER: "hunter", HUNTER_API_KEY: "hunter-test" });
  assert.equal(selected.name, "hunter");
  assert.equal(selected.capabilities.organization_search, true);
  assert.equal(selected.capabilities.people_search, true);
  assert.equal(selected.capabilities.person_enrichment, true);
  assert.equal(providerStatus({ PROSPECT_PROVIDER: "hunter" }).mode, "missing-key");
});

test("Hunter Discover targets small businesses without using premium pagination", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      data: [
        { domain: "acme-roofing.example", organization: "Acme Roofing", emails_count: { personal: 2, total: 3 } },
        { domain: "beta-roofing.example", organization: "Beta Roofing", emails_count: { personal: 1, total: 1 } },
      ],
      meta: { results: 2, limit: 100, offset: 0 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const provider = createHunterProvider({ HUNTER_API_KEY: "hunter-test", PROVIDER_TIMEOUT_MS: "1000" });
    const result = await provider.searchOrganizations({
      locations: ["Champaign, Illinois"], keywords: ["roofing"], employeeRanges: ["1,50"], perPage: 1,
    });
    assert.equal(captured.url, "https://api.hunter.io/v2/discover");
    assert.equal(captured.options.headers["x-api-key"], "hunter-test");
    assert.equal("limit" in captured.body, false, "free Discover cannot change pagination");
    assert.deepEqual(captured.body.headquarters_location.include, [{ country: "US", state: "IL", city: "Champaign" }]);
    assert.deepEqual(captured.body.headcount, ["1-10", "11-50"]);
    assert.ok(captured.body.company_type.include.includes("sole proprietorship"));
    assert.deepEqual(captured.body.keywords, { match: "any", include: ["roofing"] });
    assert.equal(result.records.length, 1, "Reachwright slices the free response to its requested pilot batch");
    assert.equal(result.records[0].domain, "acme-roofing.example");
    assert.equal(result.records[0].location, "", "provider filters are not promoted to verified facts");
    assert.match(result.records[0].evidence_claim, /require first-party verification/);
    assert.equal(provider.estimateCredits({ operation: "searchOrganizations" }).estimated, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Hunter Domain Search keeps only CEO/owner-class professional contacts and no phone", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl;
  globalThis.fetch = async (url) => {
    capturedUrl = new URL(String(url));
    return new Response(JSON.stringify({
      data: {
        domain: "acme-roofing.example",
        organization: "Acme Roofing",
        emails: [
          { value: "owner@acme-roofing.example", first_name: "Avery", last_name: "Owner", position: "Founder & CEO", seniority: "executive", linkedin: "avery-owner", phone_number: "+1 555 000 0000", verification: { status: "valid", date: "2026-07-15" } },
          { value: "clients@acme-roofing.example", first_name: "Client", last_name: "Services", position: "President", seniority: "executive", verification: { status: "valid" } },
          { value: "marketing@acme-roofing.example", first_name: "Morgan", last_name: "Marketer", position: "Marketing Specialist", seniority: "senior", verification: { status: "valid" } },
        ],
      },
      meta: { results: 2, limit: 10, offset: 0 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const provider = createHunterProvider({ HUNTER_API_KEY: "hunter-test", PROVIDER_TIMEOUT_MS: "1000" });
    const result = await provider.searchPeople({ domain: "acme-roofing.example" });
    assert.equal(capturedUrl.pathname, "/v2/domain-search");
    assert.equal(capturedUrl.searchParams.get("limit"), "10");
    assert.equal(capturedUrl.searchParams.get("type"), "personal");
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].full_name, "Avery Owner");
    assert.equal(result.records[0].title, "Founder & CEO");
    assert.equal(result.records[0].business_email, "owner@acme-roofing.example");
    assert.equal(result.records[0].email_status, "verified");
    assert.equal(result.records[0].business_phone, "", "Hunter phone fields remain outside Reachwright policy");
    assert.equal(result.records[0].public_profile_url, "https://www.linkedin.com/in/avery-owner");
    assert.equal(provider.estimateCredits({ operation: "searchPeople" }).estimated, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
