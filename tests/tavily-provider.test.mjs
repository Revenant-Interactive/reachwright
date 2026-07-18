import test from "node:test";
import assert from "node:assert/strict";
import { createTavilyProvider } from "../worker-api/src/providers/tavily.js";
import { getProvider, providerStatus } from "../worker-api/src/providers/registry.js";

test("registry selects Tavily explicitly and fails closed when its key is missing", () => {
  const selected = getProvider({ PROSPECT_PROVIDER: "tavily", TAVILY_API_KEY: "tvly-test" });
  assert.equal(selected.name, "tavily-web");
  assert.equal(selected.maxSearchBatch, 20);
  assert.equal(selected.capabilities.people_search, false);
  assert.deepEqual(providerStatus({ PROSPECT_PROVIDER: "tavily" }), {
    configured: false,
    provider: "tavily-web",
    mode: "missing-key",
  });
});

test("Tavily discovery uses one-credit basic search and stores only candidate company websites", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      results: [
        { title: "Acme Roofing | Official Website", url: "https://www.acmeroofing.example/services", content: "Roofing" },
        { title: "Acme Roofing reviews", url: "https://m.yelp.com/biz/acme-roofing", content: "Reviews" },
        { title: "Unsafe", url: "javascript:alert(1)", content: "" },
      ],
      usage: { credits: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const provider = createTavilyProvider({ TAVILY_API_KEY: "tvly-test", PROVIDER_TIMEOUT_MS: "1000" });
    const result = await provider.searchOrganizations({
      locations: ["Champaign, Illinois"], keywords: ["roofing"], perPage: 25,
    });

    assert.equal(captured.url, "https://api.tavily.com/search");
    assert.equal(captured.options.headers.authorization, "Bearer tvly-test");
    assert.equal(captured.body.search_depth, "basic");
    assert.equal(captured.body.max_results, 20);
    assert.equal(captured.body.include_answer, false);
    assert.equal(captured.body.include_raw_content, false);
    assert.match(captured.body.query, /roofing/);
    assert.match(captured.body.query, /Champaign/);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].name, "Acme Roofing");
    assert.equal(result.records[0].domain, "acmeroofing.example");
    assert.equal(result.records[0].location, "", "query geography is not promoted into an asserted fact");
    assert.match(result.records[0].evidence_claim, /discovery candidate, not a verified business fact/);
    assert.deepEqual(provider.estimateCredits({ operation: "searchOrganizations", pages: 1 }), {
      operation: "searchOrganizations",
      estimated: 1,
      basis: "1 Tavily credit per basic web search",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Tavily people and enrichment capabilities remain explicitly unavailable", async () => {
  const provider = createTavilyProvider({ TAVILY_API_KEY: "tvly-test" });
  assert.deepEqual(await provider.searchPeople(), {
    records: [], pagination: { page: 1, per_page: 0, total_entries: 0, total_pages: 1 },
  });
  assert.deepEqual(await provider.enrichPerson({}), { error: "unsupported-capability" });
  assert.equal(provider.estimateCredits({ operation: "enrichPerson" }).estimated, 0);
});
