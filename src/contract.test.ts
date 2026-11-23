import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  COMPANY_CATEGORIES,
  DESCRIPTION_FORMATS,
  EMPLOYMENT_TYPES,
  EXPERIENCE_LEVELS,
  JOB_SEARCH_FILTERS,
  SEARCH_SORTS,
  WORK_MODELS,
} from "@jobo-ai/connector-core";

import { FILTER_VALUE_FACETS, describeSearchFilters, filtersFedBy, fixedVocabularies } from "./contract.js";

const contract = describeSearchFilters();
const byName = new Map(contract.filters.map((filter) => [filter.name, filter]));
const get = (name: string) => {
  const filter = byName.get(name);
  assert.ok(filter, `no filter ${name}`);
  return filter;
};

describe("describe_search_filters covers the shared filter contract", () => {
  it("describes every connector-core search filter, in order, and nothing else", () => {
    assert.deepEqual(
      contract.filters.map((filter) => filter.name),
      JOB_SEARCH_FILTERS.map((filter) => filter.key),
    );
  });

  // Drift guard: a filter the contract gains has to be placed in the body by
  // the contract's own mapper, or `build_search_request` would drop it silently.
  it("places every filter in the POST body", () => {
    for (const filter of contract.filters) {
      assert.ok(filter.body_field, `${filter.name} does not reach the request body`);
      assert.ok(filter.body_example && Object.keys(filter.body_example).length === 1, filter.name);
    }
  });

  it("gets the body spellings that differ from the filter names right", () => {
    assert.equal(get("q").body_field, "queries");
    assert.deepEqual(get("q").body_example, { queries: ["data engineer"] });
    assert.equal(get("location").body_field, "locations");
    assert.equal(get("work_model").body_field, "work_models");
    assert.equal(get("employment_type").body_field, "employment_types");
    assert.equal(get("experience_level").body_field, "experience_levels");
    assert.equal(get("language").body_field, "languages");
    assert.equal(get("sources").body_field, "sources");
    assert.equal(get("min_salary_usd").body_field, "salary_usd.min");
    assert.equal(get("max_salary_usd").body_field, "salary_usd.max");
    assert.equal(get("search_description").body_field, "search_description");
    assert.deepEqual(get("search_description").body_example, { search_description: false });
    assert.equal(get("sort").body_field, "sort");
    assert.equal(get("description_format").body_field, "description_format");
  });

  it("nests the include/exclude filters and pairs each with its twin", () => {
    for (const name of ["companies", "skills", "industries", "company_categories", "job_categories", "job_subcategories", "occupation_ids"]) {
      const include = get(name);
      const exclude = get(`exclude_${name}`);
      assert.equal(include.body_field, `${name}.include`);
      assert.equal(exclude.body_field, `${name}.exclude`);
      assert.equal(include.exclude_twin, `exclude_${name}`);
      assert.equal(exclude.excludes, name);
      assert.deepEqual(exclude.lookup, include.lookup, `${name}: both halves take the same values`);
    }
    assert.deepEqual(get("skills").body_example, { skills: { include: ["Python"] } });
    assert.equal(get("work_model").exclude_twin, undefined, "search has no exclude_work_model");
  });

  it("names the lookup tool for every filter that is not free text, a number or a date", () => {
    assert.deepEqual(get("companies").lookup, { tool: "find_companies" });
    assert.deepEqual(get("skills").lookup, { tool: "find_filter_values", arguments: { facet: "skills" } });
    assert.deepEqual(get("occupation_ids").lookup, { tool: "find_filter_values", arguments: { facet: "occupations" } });
    assert.deepEqual(get("location").lookup, { tool: "find_locations" });
    assert.deepEqual(get("work_model").lookup, { tool: "list_filters" });
    assert.equal(get("q").lookup, undefined);
    assert.equal(get("posted_after").lookup, undefined);

    for (const filter of JOB_SEARCH_FILTERS) {
      if (filter.options || filter.dynamicOptions) assert.ok(get(filter.key).lookup, `${filter.key} has values but no lookup`);
    }
  });

  it("says which value lists are closed", () => {
    assert.equal(get("work_model").values_exhaustive, true);
    assert.equal(get("sort").values_exhaustive, true);
    assert.equal(get("language").values_exhaustive, false, "any ISO 639-1 code is accepted");
    assert.equal(get("company_categories").values_exhaustive, false, "also served live");
    assert.equal(get("skills").values, undefined);
  });

  it("gives every filter a CLI flag and describes the request options", () => {
    assert.equal(get("min_salary_usd").cli_flag, "--min-salary-usd");
    assert.deepEqual(
      contract.request_options.map((option) => option.name),
      ["page", "page_size", "include_fields", "include_facets"],
    );
    assert.equal(contract.endpoint.url, "https://connect.jobo.world/api/jobs/search");
    assert.equal(contract.endpoint.auth_header, "X-Api-Key");
  });
});

describe("find_filter_values facets", () => {
  it("are the contract's open vocabularies, bar companies", () => {
    assert.deepEqual([...FILTER_VALUE_FACETS].sort(), [
      "company_categories",
      "industries",
      "job_categories",
      "job_subcategories",
      "occupations",
      "skills",
      "sources",
    ]);
  });

  it("each feeds at least one filter", () => {
    for (const facet of FILTER_VALUE_FACETS) assert.ok(filtersFedBy(facet).length > 0, facet);
    assert.deepEqual(filtersFedBy("occupations"), ["occupation_ids", "exclude_occupation_ids"]);
    assert.deepEqual(filtersFedBy("sources"), ["sources"]);
  });
});

describe("list_filters", () => {
  const vocabularies = fixedVocabularies();
  const values = (name: string) => vocabularies.search.find((vocabulary) => vocabulary.filter === name)?.values;

  it("lists the fixed vocabularies with the contract's values", () => {
    assert.deepEqual(values("work_model"), [...WORK_MODELS]);
    assert.deepEqual(values("employment_type"), [...EMPLOYMENT_TYPES]);
    assert.deepEqual(values("experience_level"), [...EXPERIENCE_LEVELS]);
    assert.deepEqual(values("company_categories"), [...COMPANY_CATEGORIES]);
    assert.deepEqual(values("sort"), [...SEARCH_SORTS]);
    assert.deepEqual(values("description_format"), [...DESCRIPTION_FORMATS]);
    assert.ok(values("language")?.includes("de"));
    assert.equal(vocabularies.search.find((vocabulary) => vocabulary.filter === "language")?.names?.de, "German");
    assert.ok(values("include_fields")?.includes("description"));
  });

  it("lists each vocabulary once: an exclude_ filter shares its twin's", () => {
    const names = vocabularies.search.map((vocabulary) => vocabulary.filter);
    assert.equal(new Set(names).size, names.length);
    assert.ok(!names.some((name) => name.startsWith("exclude_")));
  });

  it("carries the feed's size and revenue bands", () => {
    assert.deepEqual(
      vocabularies.feed_only.map((vocabulary) => vocabulary.filter),
      ["company_sizes", "company_revenues"],
    );
    assert.ok(vocabularies.feed_only[0]?.values.includes("10001+"));
  });

  it("points open vocabularies at their lookup tool", () => {
    const open = new Map(vocabularies.open.map((entry) => [entry.filter, entry.lookup.tool]));
    assert.equal(open.get("companies"), "find_companies");
    assert.equal(open.get("skills"), "find_filter_values");
    assert.equal(open.get("location"), "find_locations");
    assert.equal(open.has("work_model"), false);
  });
});

// Skipped when the generated contract is absent — a Docker build carries only this directory.
describe("the installed connector-core against the repo contract", () => {
  it("matches contracts/filters.json", (t) => {
    const contractPath = join(import.meta.dirname, "..", "..", "contracts", "filters.json");
    if (!existsSync(contractPath)) {
      t.skip("contracts/filters.json not present (Docker build)");
      return;
    }
    const repo = JSON.parse(readFileSync(contractPath, "utf8")) as {
      enums: Record<string, string[]>;
      search_filters: Array<{ key: string }>;
    };
    assert.deepEqual(
      repo.search_filters.map((filter) => filter.key),
      JOB_SEARCH_FILTERS.map((filter) => filter.key),
      "the installed connector-core differs from the repo contract — bump the pinned version",
    );
    assert.deepEqual([...WORK_MODELS], repo.enums.work_models);
    assert.deepEqual([...EMPLOYMENT_TYPES], repo.enums.employment_types);
    assert.deepEqual([...EXPERIENCE_LEVELS], repo.enums.experience_levels);
    assert.deepEqual([...COMPANY_CATEGORIES], repo.enums.company_categories);
    assert.deepEqual([...SEARCH_SORTS], repo.enums.search_sorts);
    assert.deepEqual([...DESCRIPTION_FORMATS], repo.enums.description_formats);
  });
});
