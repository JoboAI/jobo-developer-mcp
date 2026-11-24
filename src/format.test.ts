import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CompanySuggestion, LocationSuggestion, OccupationTaxonomyResponse } from "@jobo-ai/connector-core";

import { describeSearchFilters, fixedVocabularies } from "./contract.js";
import {
  flattenOccupations,
  matchOccupations,
  renderBuildResult,
  renderCompanies,
  renderFilterContract,
  renderFilterValues,
  renderFixedVocabularies,
  renderLocations,
  renderOccupationMatches,
  resolvePlace,
} from "./format.js";
import { buildSearchRequest } from "./request.js";

function company(overrides: Partial<CompanySuggestion> = {}): CompanySuggestion {
  return {
    id: "aaaaaaaa-0000-0000-0000-000000000001",
    ids: ["aaaaaaaa-0000-0000-0000-000000000001", "aaaaaaaa-0000-0000-0000-000000000002"],
    name: "Stripe",
    domain: "stripe.com",
    logo_url: null,
    country: "US",
    job_count: 1412,
    ...overrides,
  };
}

describe("renderCompanies", () => {
  it("lists every id, and says which filter and body field they go into", () => {
    const text = renderCompanies("stripe", [company()]);
    assert.ok(text.includes("1. Stripe (stripe.com, US) · 1,412 live jobs"));
    assert.ok(text.includes('ids: ["aaaaaaaa-0000-0000-0000-000000000001","aaaaaaaa-0000-0000-0000-000000000002"]'));
    assert.ok(text.includes("`companies` filter"));
    assert.ok(text.includes('{ "companies": { "include": [ids] } }'));
  });

  it("copes with a missing count, domain and id list", () => {
    const text = renderCompanies("ac", [company({ name: "Acme", domain: null, country: null, job_count: null, ids: [] })]);
    assert.ok(text.includes("1. Acme\n   ids: [\"aaaaaaaa-0000-0000-0000-000000000001\"]"));
    assert.ok(renderCompanies("ac", [company({ job_count: 1 })]).includes("1 live job"));
  });

  it("explains the prefix match when nothing is found", () => {
    assert.ok(renderCompanies("zzz", []).includes("prefix match"));
  });
});

describe("renderFilterValues", () => {
  it("names the filters the values go into", () => {
    const text = renderFilterValues("skills", "pyth", [{ key: "Python", count: 120345 }]);
    assert.ok(text.includes('1 skills value starting with "pyth"'));
    assert.ok(text.includes("`skills` / `exclude_skills`"));
    assert.ok(text.includes("- Python: 120,345 jobs"));
  });

  it("shows the display name and parent of the occupation facets", () => {
    const text = renderFilterValues("job_subcategories", undefined, [{ key: "nursing", name: "Nursing", parent: "healthcare", count: 9 }]);
    assert.ok(text.includes("- nursing — Nursing (in healthcare): 9 jobs"));
    assert.ok(text.includes("most live jobs first"));
  });

  it("says what to try when nothing matches", () => {
    assert.ok(renderFilterValues("skills", "zz", []).includes("shorter prefix"));
    assert.ok(renderFilterValues("skills", undefined, []).includes("No skills values"));
  });
});

const taxonomy: OccupationTaxonomyResponse = {
  version: "2026.11",
  categories: [
    {
      name: "Healthcare",
      subcategories: [
        {
          name: "Nursing",
          occupations: [
            { id: "esco:rn", name: "Registered Nurse" },
            { id: "esco:np", name: "Nurse Practitioner" },
            { id: "esco:mw", name: "Midwife" },
          ],
        },
      ],
    },
    {
      name: "Technology",
      subcategories: [{ name: "Software Engineering", occupations: [{ id: "jobo:backend-developer", name: "Backend Developer" }] }],
    },
  ],
};

describe("matchOccupations", () => {
  const rows = flattenOccupations(taxonomy);
  const counts = new Map([
    ["esco:rn", 900],
    ["esco:np", 2000],
  ]);

  it("flattens the taxonomy with each occupation's place in it", () => {
    assert.deepEqual(rows[0], { id: "esco:rn", name: "Registered Nurse", category: "Healthcare", subcategory: "Nursing" });
    assert.equal(rows.length, 4);
  });

  it("matches every word of the query against the name, most live jobs first", () => {
    assert.deepEqual(matchOccupations(rows, "nurse", counts).map((match) => match.key), ["esco:np", "esco:rn"]);
    assert.deepEqual(matchOccupations(rows, "Registered NURSE", counts).map((match) => match.key), ["esco:rn"]);
  });

  it("puts occupations found through their subcategory or category after name matches", () => {
    assert.deepEqual(matchOccupations(rows, "nursing", counts).map((match) => match.key), ["esco:np", "esco:rn", "esco:mw"]);
    assert.deepEqual(matchOccupations(rows, "midwife healthcare", counts).map((match) => match.key), ["esco:mw"]);
  });

  it("matches an id prefix, and carries the count or null", () => {
    assert.deepEqual(matchOccupations(rows, "jobo:backend", counts), [
      { key: "jobo:backend-developer", name: "Backend Developer", parent: "Software Engineering", category: "Technology", count: null },
    ]);
    assert.deepEqual(matchOccupations(rows, "   ", counts), []);
    assert.deepEqual(matchOccupations(rows, "plumber", counts), []);
  });

  it("renders ids with their place in the taxonomy", () => {
    const matches = matchOccupations(rows, "nursing", counts);
    const text = renderOccupationMatches("nursing", matches.slice(0, 2), matches.length);
    assert.ok(text.includes('3 occupations match "nursing". Showing 2 of 3'));
    assert.ok(text.includes("- esco:np — Nurse Practitioner (Healthcare › Nursing): 2,000 jobs"));
    assert.ok(text.includes("`occupation_ids` / `exclude_occupation_ids`"));
    assert.ok(renderOccupationMatches("nursing", matches, matches.length).includes("No job count is shown"));
    assert.ok(renderOccupationMatches("plumber", [], 0).includes("No occupation"));
  });

  it("still answers when the live counts could not be had, by name and saying so", () => {
    const matches = matchOccupations(rows, "nurse", new Map());
    assert.deepEqual(matches.map((match) => [match.key, match.count]), [
      ["esco:np", null],
      ["esco:rn", null],
    ]);
    const text = renderOccupationMatches("nurse", matches, matches.length, false);
    assert.ok(text.includes("- esco:np — Nurse Practitioner (Healthcare › Nursing)\n"));
    assert.ok(text.includes("Live job counts are unavailable right now"));
    assert.ok(!text.includes("250 occupations"));
  });
});

describe("find_locations rendering", () => {
  const berlin: LocationSuggestion = {
    city: "Berlin",
    region: "Berlin",
    country: "Germany",
    latitude: 52.52,
    longitude: 13.405,
    display_name: "Berlin, Germany",
    country_code: "DE",
  };

  it("gives the search string and the feed object for a place", () => {
    assert.deepEqual(resolvePlace(berlin), {
      ...berlin,
      search_location: "Berlin, Germany",
      feed_location: { country: "Germany", region: "Berlin", city: "Berlin" },
    });
  });

  it("builds the name from the parts when there is no display name, and no feed value without a country", () => {
    const texas = resolvePlace({ ...berlin, city: null, region: "Texas", country: "United States", display_name: null });
    assert.equal(texas.search_location, "Texas, United States");
    assert.deepEqual(texas.feed_location, { country: "United States", region: "Texas" });
    assert.equal(resolvePlace({ ...berlin, country: null }).feed_location, null);
  });

  it("prints both values, ready to paste", () => {
    const text = renderLocations("berl", [resolvePlace(berlin)]);
    assert.ok(text.includes("1. Berlin, Germany (DE) · 52.52, 13.405"));
    assert.ok(text.includes('location: "Berlin, Germany"'));
    assert.ok(text.includes('feed: {"country":"Germany","region":"Berlin","city":"Berlin"}'));
    assert.ok(renderLocations("zz", []).includes("No place name starts with"));
  });
});

describe("the contract tools' text", () => {
  it("list_filters prints each vocabulary and where open ones are looked up", () => {
    const text = renderFixedVocabularies(fixedVocabularies());
    assert.ok(text.includes("**work_model** (body: `work_models`): remote, hybrid, onsite"));
    assert.ok(text.includes("de (German)"));
    assert.ok(text.includes("**company_sizes**: 1-10"));
    assert.ok(text.includes("- companies: `find_companies`"));
    assert.ok(text.includes("`find_filter_values` (facet skills)"));
    assert.ok(text.includes("not valid filter input"));
  });

  it("describe_search_filters prints every filter with its body field", () => {
    const contract = describeSearchFilters();
    const text = renderFilterContract(contract);
    for (const filter of contract.filters) assert.ok(text.includes(`### ${filter.name}\n`), filter.name);
    assert.ok(text.includes('- body: `skills.exclude`, e.g. {"skills":{"exclude":["Python"]}}'));
    assert.ok(text.includes("- exclude twin: `exclude_skills`"));
    assert.ok(text.includes("- look values up with: `find_companies`"));
    assert.ok(text.includes("- CLI: `--work-model`"));
    assert.ok(text.includes("`page_size`"));
    assert.ok(text.includes("POST https://connect.jobo.world/api/jobs/search"));
  });

  it("build_search_request prints the request, both commands and the cost, and says nothing was sent", () => {
    const text = renderBuildResult(buildSearchRequest({ q: "nurse", skills: ["Triage"], page_size: 5 }));
    assert.ok(text.includes("Nothing was sent."));
    assert.ok(text.includes("POST https://connect.jobo.world/api/jobs/search"));
    assert.ok(text.includes('"queries": [\n    "nurse"\n  ]'));
    assert.ok(text.includes("curl -sS -X POST"));
    assert.ok(text.includes("```powershell\nInvoke-RestMethod -Method Post"));
    assert.ok(text.includes("process.env.JOBO_API_KEY"));
    assert.ok(text.includes("jobo search nurse --skills Triage --page-size 5 --json"));
    assert.ok(text.includes("- skills: Not checked"));
    assert.ok(text.includes("up to 5 jobs"));
  });

  it("build_search_request prints the problems, and no request, when there are any", () => {
    const text = renderBuildResult(buildSearchRequest({ work_models: ["remote"], sort: "newest" }));
    assert.ok(text.startsWith("No request was built: 2 problems to fix first."));
    assert.ok(text.includes("- work_models:"));
    assert.ok(!text.includes("curl"));
    assert.ok(!text.includes("Invoke-RestMethod"));
  });
});
