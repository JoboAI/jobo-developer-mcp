import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { JOB_SEARCH_FILTERS } from "@jobo-ai/connector-core";

import { describeSearchFilters } from "./contract.js";
import { REQUEST_PARAMETERS, buildSearchRequest, canonical, nearest, parseTimestamp, shellQuote, toCurl } from "./request.js";

const ID = "b5e6f7a8-1234-5678-9abc-def012345678";

function built(input: Record<string, unknown>) {
  const result = buildSearchRequest(input);
  assert.deepEqual(result.errors, [], "expected a valid request");
  assert.ok(result.request && result.curl !== undefined);
  return result as typeof result & { request: NonNullable<typeof result.request>; curl: string };
}

function errorsOf(input: Record<string, unknown>): Record<string, string> {
  const result = buildSearchRequest(input);
  assert.equal(result.valid, false);
  assert.equal(result.request, undefined, "no request is built when there is an error");
  assert.equal(result.curl, undefined);
  return Object.fromEntries(result.errors.map((error) => [error.field, error.message]));
}

const warningFields = (input: Record<string, unknown>): string[] => built(input).warnings.map((warning) => warning.field);

describe("build_search_request: the request", () => {
  it("maps every kind of filter onto the POST body", () => {
    const { request } = built({
      q: " nurse ",
      search_description: false,
      location: "Berlin, Germany",
      sources: ["greenhouse"],
      companies: [ID, "stripe.com"],
      exclude_companies: ["Acme, Inc."],
      work_model: ["remote", "hybrid"],
      employment_type: "full-time",
      experience_level: ["senior"],
      language: ["en", "DE"],
      skills: ["Python", "Kubernetes"],
      exclude_skills: ["PHP"],
      job_categories: ["Healthcare"],
      occupation_ids: ["jobo:backend-developer"],
      min_salary_usd: 80000,
      max_salary_usd: 200000,
      posted_after: "2026-11-01",
      discovered_after: "2026-11-02T00:00:00Z",
      discovered_before: "2026-11-08T00:00:00Z",
      sort: "discovered_asc",
      description_format: "html",
      page: 2,
      page_size: 30,
      include_fields: [],
      include_facets: ["skills"],
    });

    assert.equal(request.method, "POST");
    assert.equal(request.url, "https://connect.jobo.world/api/jobs/search");
    assert.equal(request.path, "/api/jobs/search");
    assert.deepEqual(request.headers, { "X-Api-Key": "$JOBO_API_KEY", "Content-Type": "application/json" });
    assert.deepEqual(request.body, {
      queries: ["nurse"],
      search_description: false,
      locations: ["Berlin, Germany"],
      sources: ["greenhouse"],
      work_models: ["remote", "hybrid"],
      employment_types: ["full-time"],
      experience_levels: ["senior"],
      languages: ["en", "de"],
      skills: { include: ["Python", "Kubernetes"], exclude: ["PHP"] },
      companies: { include: [ID, "stripe.com"], exclude: ["Acme, Inc."] },
      job_categories: { include: ["Healthcare"] },
      occupation_ids: { include: ["jobo:backend-developer"] },
      salary_usd: { min: 80000, max: 200000 },
      posted_after: "2026-11-01",
      discovered_after: "2026-11-02T00:00:00Z",
      discovered_before: "2026-11-08T00:00:00Z",
      sort: "discovered_asc",
      description_format: "html",
      page: 2,
      page_size: 30,
      include_facets: ["skills"],
      include_fields: [],
    });
  });

  it("sends only what was set", () => {
    assert.deepEqual(built({ q: "rust" }).request.body, { queries: ["rust"] });
    assert.deepEqual(built({ q: "rust", skills: [], location: "  ", page: null, sort: "relevance" }).request.body, {
      queries: ["rust"],
    });
    assert.deepEqual(built({}).request.body, {});
  });

  it("takes several places, which the contract's own mapper cannot", () => {
    const result = built({ location: ["Berlin, Germany", "Munich, Germany"] });
    assert.deepEqual(result.request.body, { locations: ["Berlin, Germany", "Munich, Germany"] });
    assert.equal(result.cli, null);
    assert.ok(result.cli_note?.includes("one --location"));
  });

  it("puts fixed values in their canonical spelling", () => {
    assert.deepEqual(built({ work_model: ["Remote", "On-Site"], employment_type: ["Full Time"], sort: "Discovered_Desc" }).request.body, {
      work_models: ["remote", "onsite"],
      employment_types: ["full-time"],
      sort: "discovered_desc",
    });
  });

  it("never claims to have sent anything, and says what sending would cost", () => {
    const small = built({ q: "nurse", page_size: 5 });
    assert.equal(small.sent, false);
    assert.deepEqual(
      { jobs: small.billing?.max_jobs_billed, credits: small.billing?.max_credits, usd: small.billing?.max_usd },
      { jobs: 5, credits: 15, usd: 0.015 },
    );
    assert.equal(built({ q: "nurse" }).billing?.max_jobs_billed, 25, "the API's default page size");
    assert.equal(buildSearchRequest({ nope: 1 }).sent, false);
  });
});

describe("build_search_request: errors, which stop the request", () => {
  it("names the contract filter when given the body's spelling", () => {
    const errors = errorsOf({ work_models: ["remote"], queries: ["nurse"], salary_usd: { min: 1 }, locations: ["Berlin"] });
    assert.ok(errors.work_models?.includes("`work_model`"));
    assert.ok(errors.queries?.includes("`q`"));
    assert.ok(errors.salary_usd?.includes("`min_salary_usd` or `max_salary_usd`"));
    assert.ok(errors.locations?.includes("`location`"));
  });

  it("catches the flat include/exclude spelling the API ignores without failing", () => {
    const errors = errorsOf({ skills_exclude: ["PHP"], companies_include: ["stripe.com"] });
    assert.ok(errors.skills_exclude?.includes("`exclude_skills`"));
    assert.ok(errors.companies_include?.includes("`companies`"));
  });

  it("suggests the nearest filter for a typo, and points at the contract otherwise", () => {
    assert.ok(errorsOf({ experiance_level: ["senior"] }).experiance_level?.includes("`experience_level`"));
    assert.ok(errorsOf({ query: "nurse" }).query?.includes("`q`"));
    assert.ok(errorsOf({ zzzzzzzz: 1 }).zzzzzzzz?.includes("describe_search_filters"));
  });

  it("refuses a value outside a closed vocabulary, with the nearest valid one", () => {
    const errors = errorsOf({ work_model: ["remot", "hybrid"], experience_level: ["principal"], sort: "newest" });
    assert.ok(errors.work_model?.includes('Unknown value "remot". Did you mean "remote"?'));
    assert.ok(errors.work_model?.includes("remote, hybrid, onsite"));
    assert.ok(errors.experience_level?.includes("intern, entry, mid, senior, lead, executive"));
    assert.ok(errors.sort?.includes("relevance, discovered_asc, discovered_desc"));
  });

  it("refuses wrong types", () => {
    const errors = errorsOf({
      q: ["nurse", "doctor"],
      skills: [1, 2],
      min_salary_usd: "120000",
      max_salary_usd: 0,
      search_description: "false",
      location: 7,
      include_fields: "description",
    });
    assert.ok(errors.q?.includes("Takes a string"));
    assert.ok(errors.q?.includes("`queries`"));
    assert.ok(errors.skills?.includes("array of strings"));
    assert.equal(errors.min_salary_usd, 'Takes a whole number above zero. Send it as a JSON number: 120000, not "120000".');
    assert.equal(errors.max_salary_usd, "Takes a whole number above zero.");
    assert.ok(errors.search_description?.includes("true or false"));
    assert.ok(errors.location?.includes("string"));
    assert.ok(errors.include_fields?.includes("array of strings"));
  });

  it("says how to send a number that arrived as a string, for paging too", () => {
    const errors = errorsOf({ page: "2", page_size: "10", min_salary_usd: "lots" });
    assert.equal(errors.page, 'Takes a whole number, 1 or more. Send it as a JSON number: 2, not "2".');
    assert.equal(errors.page_size, 'Takes a whole number from 1 to 100. Send it as a JSON number: 10, not "10".');
    assert.equal(errors.min_salary_usd, "Takes a whole number above zero.");
  });

  it("refuses dates the API would not parse, and explains the CLI's shorthand", () => {
    const errors = errorsOf({ posted_after: "7d", posted_before: "yesterday", discovered_after: "11/01/2026", discovered_before: 20261101 });
    assert.ok(errors.posted_after?.includes("ISO 8601"));
    assert.ok(errors.posted_after?.includes("CLI shorthand"));
    assert.ok(errors.posted_before?.includes("ISO 8601"));
    assert.ok(errors.discovered_after?.includes("ISO 8601"));
    assert.ok(errors.discovered_before?.includes("ISO 8601"));
    assert.deepEqual(built({ posted_after: "2026-11-01T08:30:00+02:00" }).request.body, { posted_after: "2026-11-01T08:30:00+02:00" });
  });

  // `Date.parse` rolls these over to a later day instead of refusing them.
  it("refuses a date that is not on the calendar", () => {
    for (const value of ["2026-02-31", "2026-02-29", "2026-04-31", "2026-13-01", "2026-00-10", "2026-11-00", "2026-11-01T24:00:00Z", "2026-11-01T12:60:00Z", "2026-11-01T12:00:00+25:00"]) {
      assert.equal(errorsOf({ posted_after: value }).posted_after, `"${value}" is not a real date or time: check the day of the month, the hour and the zone offset.`, value);
    }
    for (const value of ["2028-02-29", "2026-02-28", "2026-12-31T23:59:59.999Z", "2026-11-01 08:30", "2026-11-01T08:30:00-0800"]) {
      assert.deepEqual(built({ q: "x", posted_after: value }).request.body.posted_after, value, value);
    }
  });

  it("reads a timestamp by hand: no rollover, and no zone means UTC", () => {
    assert.deepEqual(parseTimestamp("2026-11-01"), { ms: Date.UTC(2026, 10, 1) });
    assert.deepEqual(parseTimestamp("2026-11-01T12:00:00"), { ms: Date.UTC(2026, 10, 1, 12) });
    assert.deepEqual(parseTimestamp("2026-11-01T12:00:00Z"), { ms: Date.UTC(2026, 10, 1, 12) });
    assert.deepEqual(parseTimestamp("2026-11-01T12:00:00+02:00"), { ms: Date.UTC(2026, 10, 1, 10) });
    assert.deepEqual(parseTimestamp("2026-11-01T12:00:00-0830"), { ms: Date.UTC(2026, 10, 1, 20, 30) });
    assert.deepEqual(parseTimestamp("2026-11-01T12:00:00.250Z"), { ms: Date.UTC(2026, 10, 1, 12, 0, 0, 250) });
    assert.deepEqual(parseTimestamp("2026-02-31"), { problem: "calendar" });
    assert.deepEqual(parseTimestamp("next week"), { problem: "format" });
  });

  it("refuses ranges that cannot match", () => {
    assert.ok(errorsOf({ min_salary_usd: 200000, max_salary_usd: 100000 }).min_salary_usd?.includes("above max_salary_usd"));
    assert.ok(errorsOf({ discovered_after: "2026-11-08", discovered_before: "2026-11-01" }).discovered_after?.includes("later than"));
    assert.ok(errorsOf({ posted_after: "2026-11-01T12:00:00+00:00", posted_before: "2026-11-01T13:00:00+02:00" }).posted_after?.includes("later than"));
  });

  // The same pair of values must give the same answer on every machine, so a
  // value with no zone is UTC, not the local time of wherever this runs.
  it("compares a value with no zone as UTC", () => {
    assert.deepEqual(built({ q: "x", discovered_after: "2026-11-01T12:00:00", discovered_before: "2026-11-01T12:30:00Z" }).errors, []);
    assert.ok(
      errorsOf({ discovered_after: "2026-11-01T12:30:00", discovered_before: "2026-11-01T12:00:00Z" }).discovered_after?.includes("later than"),
    );
  });

  it("refuses paging the API would reject", () => {
    assert.ok(errorsOf({ page_size: 101 }).page_size?.includes("1 to 100"));
    assert.ok(errorsOf({ page_size: 0 }).page_size);
    assert.ok(errorsOf({ page: 0 }).page);
    assert.ok(errorsOf({ include_fields: ["everything"] }).include_fields?.includes("description, summary"));
  });

  it("reports every problem at once", () => {
    assert.equal(buildSearchRequest({ work_models: ["remote"], sort: "newest", page_size: 500 }).errors.length, 3);
  });
});

describe("build_search_request: warnings, which do not", () => {
  it("lists open-vocabulary values it could not check, with the tool that can", () => {
    const result = built({ q: "x", skills: ["Pyhton"], industries: ["Software"], sources: ["greenhouse"] });
    const skills = result.warnings.find((warning) => warning.field === "skills");
    assert.ok(skills?.message.includes('"Pyhton"'));
    assert.ok(skills?.message.includes("Confirm \"Pyhton\" with `find_filter_values` (facet skills)."));
    assert.ok(result.warnings.some((warning) => warning.field === "industries"));
    assert.ok(result.warnings.some((warning) => warning.field === "sources"));
  });

  it("flags a company name and an occupation name, not ids", () => {
    assert.deepEqual(warningFields({ companies: [ID, "stripe.com"] }), []);
    const byName = built({ companies: ["Stripe"] }).warnings[0];
    assert.equal(byName?.field, "companies");
    assert.ok(byName?.message.includes("`find_companies`"));

    assert.deepEqual(warningFields({ occupation_ids: ["esco:8d3e8aaa-791b-4c75-a465-f3f827028f50", "jobo:backend-developer"] }), []);
    assert.ok(built({ occupation_ids: ["Registered Nurse"] }).warnings[0]?.message.includes("ids, not names"));
  });

  it("accepts any ISO 639-1 language code and flags a name", () => {
    assert.deepEqual(warningFields({ q: "x", language: ["sw", "en"] }), [], "sw is not in the picker list but is a valid code");
    assert.deepEqual(warningFields({ q: "x", language: ["German"] }), ["language"]);
  });

  it("flags an unknown company category without refusing it: the set is also served live", () => {
    const result = built({ q: "x", company_categories: ["SaaS", "fintech"] });
    assert.deepEqual(result.request.body.company_categories, { include: ["saas", "fintech"] });
    assert.ok(result.warnings[0]?.message.includes('"fintech"'));
  });

  it("flags a comma-joined string, which is one value here", () => {
    const result = built({ q: "x", skills: "Python, Kubernetes" });
    assert.deepEqual(result.request.body.skills, { include: ["Python, Kubernetes"] });
    assert.ok(result.warnings.some((warning) => warning.message.includes("does not split on commas")));
  });

  it("flags a request that matches the whole index, deep relevance paging, and salary filters", () => {
    assert.deepEqual(warningFields({ work_model: ["remote"] }), ["(request)"]);
    assert.deepEqual(warningFields({ q: "x", page: 3 }), ["sort"]);
    assert.deepEqual(warningFields({ q: "x", page: 3, sort: "discovered_asc" }), []);
    assert.deepEqual(warningFields({ q: "x", min_salary_usd: 100000 }), ["min_salary_usd"]);
  });

  it("flags a page past the depth search serves, which the API clamps rather than refuses", () => {
    const result = built({ q: "x", sort: "discovered_asc", page: 1001, page_size: 100 });
    assert.deepEqual(result.warnings.map((warning) => warning.field), ["page"]);
    assert.ok(result.warnings[0]?.message.includes("100,000"));
    assert.deepEqual(warningFields({ q: "x", sort: "discovered_asc", page: 1000, page_size: 100 }), []);
  });

  it("is quiet for a request with nothing to question", () => {
    assert.deepEqual(warningFields({ q: "data engineer", work_model: ["remote"], experience_level: ["senior", "lead"] }), []);
  });

  it("warns on an unknown facet name instead of refusing: that list is not in the contract", () => {
    const result = built({ q: "x", include_facets: ["skills", "salaries"] });
    assert.deepEqual(result.request.body.include_facets, ["skills", "salaries"]);
    assert.deepEqual(result.warnings.map((warning) => warning.field), ["include_facets"]);
  });
});

describe("build_search_request: curl", () => {
  it("is a POST with the key from the environment and the body as one quoted argument", () => {
    const { curl, request } = built({ q: "o'neill engineer", work_model: ["remote"] });
    const lines = curl.split(" \\\n");
    assert.equal(lines[0], "curl -sS -X POST https://connect.jobo.world/api/jobs/search");
    assert.equal(lines[1], '  -H "X-Api-Key: $JOBO_API_KEY"');
    assert.equal(lines[2], "  -H 'Content-Type: application/json'");
    assert.equal(lines[3], `  -d '{"queries":["o'\\''neill engineer"],"work_models":["remote"]}'`);
    // Undo the shell quoting: what the shell hands curl is the body, byte for byte.
    const argument = lines[3]!.slice("  -d ".length);
    assert.equal(argument.slice(1, -1).replace(/'\\''/g, "'"), JSON.stringify(request.body));
  });

  it("carries no key", () => {
    const { curl, request } = built({ q: "nurse" });
    assert.ok(!/jbe_(live|test)_/.test(curl + JSON.stringify(request)));
  });

  it("quotes for a POSIX shell", () => {
    assert.equal(shellQuote("remote,hybrid"), "remote,hybrid");
    assert.equal(shellQuote("data engineer"), "'data engineer'");
    assert.equal(shellQuote("$HOME `id` !x"), "'$HOME `id` !x'");
    assert.equal(shellQuote("it's"), "'it'\\''s'");
    assert.ok(toCurl("https://example.test/a b", {}).startsWith("curl -sS -X POST 'https://example.test/a b'"));
  });
});

describe("build_search_request: the jobo CLI command", () => {
  it("writes the same search as `jobo search` flags", () => {
    const { cli } = built({
      q: "data engineer",
      location: "Berlin, Germany",
      work_model: ["remote", "hybrid"],
      skills: ["Python"],
      exclude_skills: ["PHP"],
      min_salary_usd: 120000,
      posted_after: "2026-11-01",
      search_description: false,
      sort: "discovered_desc",
      page: 2,
      page_size: 5,
      include_fields: [],
      include_facets: ["skills", "sources"],
    });
    assert.equal(
      cli,
      "jobo search 'data engineer' --location 'Berlin, Germany' --work-model remote,hybrid --skills Python " +
        "--exclude-skills PHP --min-salary-usd 120000 --posted-after 2026-11-01 --search-description false " +
        "--sort discovered_desc --page 2 --page-size 5 --include-fields none --facets skills,sources --json",
    );
  });

  it("repeats the flag for values that may hold a comma, as the CLI does not split them", () => {
    const { cli } = built({ companies: [ID, "Acme, Inc."], industries: ["Software Development", "Banking"] });
    assert.equal(
      cli,
      `jobo search --companies ${ID} --companies 'Acme, Inc.' --industries 'Software Development' --industries Banking --page-size 25 --json`,
    );
  });

  it("always states the page size, because the CLI's default differs from the API's", () => {
    assert.equal(built({ q: "nurse" }).cli, "jobo search nurse --page-size 25 --json");
  });

  it("keeps a query or value that starts with a dash from being read as a flag", () => {
    assert.equal(built({ q: "-senior engineer" }).cli, "jobo search --q='-senior engineer' --page-size 25 --json");
  });

  it("says so when the CLI cannot express a value", () => {
    const result = built({ q: "x", skills: ["C, C++"] });
    assert.equal(result.cli, null);
    assert.ok(result.cli_note?.includes("splits --skills on commas"));
  });
});

describe("the parameters build_search_request takes", () => {
  it("are the contract's filters plus the request options", () => {
    assert.deepEqual(REQUEST_PARAMETERS, [
      ...JOB_SEARCH_FILTERS.map((filter) => filter.key),
      "page",
      "page_size",
      "include_fields",
      "include_facets",
    ]);
  });

  // Every example `describe_search_filters` prints must survive `build_search_request`.
  it("accept every example the contract description gives", () => {
    for (const filter of describeSearchFilters().filters) {
      const sample = JOB_SEARCH_FILTERS.find((entry) => entry.key === filter.name);
      assert.ok(sample && filter.body_example);
      const value =
        filter.type === "boolean"
          ? false
          : filter.type === "number"
            ? 100000
            : filter.type === "dateTime"
              ? "2026-01-01T00:00:00Z"
              : filter.type === "enum"
                ? sample.options?.[sample.options.length - 1]
                : filter.type === "string"
                  ? "text"
                  : [sample.options?.[0] ?? "jobo:value"];
      const result = buildSearchRequest({ [filter.name]: value });
      assert.deepEqual(result.errors, [], filter.name);
      assert.deepEqual(Object.keys(result.request?.body ?? {}), [filter.body_field?.split(".")[0]], filter.name);
    }
  });
});

describe("suggestions", () => {
  it("canonical forgives case and separators only", () => {
    assert.equal(canonical("Full Time", ["full-time", "part-time"]), "full-time");
    assert.equal(canonical("REMOTE", ["remote"]), "remote");
    assert.equal(canonical("remot", ["remote"]), undefined);
  });

  it("nearest guesses only when close", () => {
    assert.equal(nearest("remot", ["remote", "hybrid", "onsite"]), "remote");
    assert.equal(nearest("serach_description", ["search_description", "sort"]), "search_description");
    assert.equal(nearest("principal", ["intern", "entry", "mid", "senior", "lead", "executive"]), undefined);
  });
});
