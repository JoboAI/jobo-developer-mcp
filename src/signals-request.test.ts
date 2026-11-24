import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderSignalsBuildResult } from "./format.js";
import { HIRING_SIGNAL_FILTERS } from "./signals-contract.js";
import { SIGNALS_REQUEST_PARAMETERS, buildSignalsRequest } from "./signals-request.js";

const COMPANY = "6c1f0a9e-3b7d-4c55-8e21-5a4d9f0b7c33";

function built(input: Record<string, unknown>) {
  const result = buildSignalsRequest(input);
  assert.deepEqual(result.errors, [], "expected a valid request");
  assert.ok(result.request && result.curl !== undefined);
  return result as typeof result & { request: NonNullable<typeof result.request>; curl: string };
}

function errorsOf(input: Record<string, unknown>): Record<string, string> {
  const result = buildSignalsRequest(input);
  assert.equal(result.valid, false);
  assert.equal(result.request, undefined, "no request is built when there is an error");
  assert.equal(result.curl, undefined);
  return Object.fromEntries(result.errors.map((error) => [error.field, error.message]));
}

describe("build_signals_request: the request", () => {
  it("maps every kind of filter onto the query string, in the contract's order", () => {
    const { request } = built({
      created_after: "2026-11-12T09:30:00.1234567Z",
      types: ["Hiring_Surge", "new country"],
      domains: ["stripe.com", "stripe.com", " shopify.com "],
      company_sizes: ["51-200"],
      countries: ["us"],
      funding_stages: ["Series A"],
      founded_after: 2018,
      exclude_agencies: true,
      reposted_only: false,
      seniority: ["Senior"],
      job_countries: ["de"],
      min_strength: 70,
      detected_after: "2026-11-01",
      detected_before: "2026-11-20",
      limit: 25,
      cursor: "eyJkIjoiMjAyNi0xMS0xMCJ9",
    });

    assert.equal(request.method, "GET");
    assert.equal(request.path, "/api/signals");
    assert.deepEqual(request.query, {
      types: "hiring_surge,new_country",
      domains: "stripe.com,shopify.com",
      countries: "US",
      company_sizes: "51-200",
      funding_stages: "Series A",
      founded_after: 2018,
      exclude_agencies: true,
      seniority: "senior",
      job_countries: "DE",
      min_strength: 70,
      detected_after: "2026-11-01",
      detected_before: "2026-11-20",
      created_after: "2026-11-12T09:30:00.1234567Z",
      limit: 25,
      cursor: "eyJkIjoiMjAyNi0xMS0xMCJ9",
    });
    assert.ok(
      request.url.startsWith(
        "https://connect.jobo.world/api/signals?types=hiring_surge%2Cnew_country&domains=stripe.com%2Cshopify.com&countries=US",
      ),
      request.url,
    );
    assert.ok(request.url.includes("funding_stages=Series%20A"));
    assert.ok(request.url.includes("created_after=2026-11-12T09%3A30%3A00.1234567Z"));
    assert.deepEqual(request.headers, { "X-Api-Key": "<your API key, read from the JOBO_API_KEY environment variable>" });
  });

  it("reads one company from its own endpoint", () => {
    const result = built({ company_id: COMPANY.toUpperCase(), types: ["leadership_hire"], min_strength: 40 });
    assert.equal(result.request.path, `/api/companies/${COMPANY}/signals`);
    assert.equal(result.request.url, `https://connect.jobo.world/api/companies/${COMPANY}/signals?types=leadership_hire&min_strength=40`);
    assert.equal(result.cli, `jobo signals --company-id ${COMPANY} --types leadership_hire --min-strength 40 --max 50 --json`);
    assert.deepEqual(result.warnings, [], "one company is narrow enough");
  });

  it("writes curl, PowerShell and the jobo command, all reading the key from JOBO_API_KEY", () => {
    const result = built({ roles: ["data engineer"], limit: 5 });
    assert.equal(
      result.curl,
      "curl -sS 'https://connect.jobo.world/api/signals?roles=data%20engineer&limit=5' \\\n  -H \"X-Api-Key: $JOBO_API_KEY\"",
    );
    assert.equal(
      result.powershell,
      "Invoke-RestMethod -Method Get -Uri 'https://connect.jobo.world/api/signals?roles=data%20engineer&limit=5' `\n" +
        "  -Headers @{ 'X-Api-Key' = $env:JOBO_API_KEY }",
    );
    assert.equal(result.cli, "jobo signals --roles 'data engineer' --max 5 --json");
  });

  it("says the most it can bill, without a price, and that nothing was sent", () => {
    const small = built({ domains: ["stripe.com"], limit: 5 });
    assert.equal(small.sent, false);
    assert.equal(small.billing?.max_signals_billed, 5);
    assert.ok(small.billing?.note.includes("up to 5 signals"));
    assert.ok(small.billing?.note.includes("ten times the price of a job"));
    assert.ok(small.billing?.note.includes("a signal read again is billed again"));
    assert.ok(!/\$\d|\d credits/.test(small.billing?.note ?? ""));
    assert.equal(built({ domains: ["stripe.com"] }).billing?.max_signals_billed, 50, "the API's default limit");
  });

  it("leaves out what was not set, including false", () => {
    assert.deepEqual(built({ domains: ["stripe.com"], exclude_agencies: false, roles: [], cursor: null }).request.query, {
      domains: "stripe.com",
    });
    assert.equal(built({}).request.url, "https://connect.jobo.world/api/signals");
  });
});

describe("build_signals_request: errors, which stop the request", () => {
  it("names an unknown filter, with the one meant", () => {
    const errors = errorsOf({ type: ["hiring_surge"], domain: ["stripe.com"], q: "nurse", location: "Berlin", page_size: 10 });
    assert.ok(errors.type?.includes("`types`"));
    assert.ok(errors.domain?.includes("`domains`"));
    assert.ok(errors.q?.includes("`roles`"));
    assert.ok(errors.location?.includes("`job_regions`"));
    assert.ok(errors.page_size?.includes("`limit`"));
    assert.ok(errorsOf({ zzzzzzzz: 1 }).zzzzzzzz?.includes("describe_signal_filters"));
  });

  it("refuses a value outside a fixed vocabulary, with the nearest one", () => {
    const errors = errorsOf({ types: ["hiring_surg"], seniority: ["boss"], company_sizes: ["50-200"] });
    assert.ok(errors.types?.includes('Did you mean "hiring_surge"?'), errors.types);
    assert.ok(errors.seniority?.includes("Valid values: junior, mid"), errors.seniority);
    assert.ok(errors.company_sizes?.includes("51-200"), errors.company_sizes);
  });

  it("refuses a list value with a comma, and shows it split", () => {
    const errors = errorsOf({ funding_stages: "Seed,Series A", industries: ["Health, Wellness"] });
    assert.ok(errors.funding_stages?.includes('["Seed","Series A"]'), errors.funding_stages);
    assert.ok(errors.industries?.includes("cannot hold one"), errors.industries);
  });

  it("refuses more than 100 values", () => {
    const domains = Array.from({ length: 101 }, (_, index) => `company${index}.com`);
    assert.ok(errorsOf({ domains }).domains?.includes("at most 100 values; 101 were given"));
    built({ domains: domains.slice(0, 100) });
  });

  it("refuses numbers out of range or of the wrong type", () => {
    const errors = errorsOf({ min_strength: 0, founded_after: 1700, min_days_open: 400, min_new_jobs: "10", limit: 201 });
    assert.equal(errors.min_strength, "Takes a whole number from 1 to 100.");
    assert.equal(errors.founded_after, "Takes a whole number from 1800 to 2100.");
    assert.equal(errors.min_days_open, "Takes a whole number from 1 to 365.");
    assert.ok(errors.min_new_jobs?.includes('Send it as a JSON number: 10, not "10".'));
    assert.equal(errors.limit, "Takes a whole number from 1 to 200.");
    assert.ok(errorsOf({ limit: 0 }).limit);
    assert.ok(errorsOf({ exclude_agencies: "yes" }).exclude_agencies?.includes("true or false"));
  });

  it("refuses dates in the wrong shape, and days that are not on the calendar", () => {
    const errors = errorsOf({
      detected_after: "2026-11-01T00:00:00Z",
      detected_before: "2026-02-31",
      created_after: "2026-11-12",
    });
    assert.ok(errors.detected_after?.includes("yyyy-MM-dd"), errors.detected_after);
    assert.ok(errors.detected_before?.includes("not a real date"), errors.detected_before);
    assert.ok(errors.created_after?.includes("A date alone is refused"), errors.created_after);
    assert.ok(errorsOf({ created_after: "2026-11-12T25:00:00Z" }).created_after?.includes("not a real date or time"));
    assert.ok(errorsOf({ created_after: "2026-11-12T09:30:00.12345678Z" }).created_after, "eight decimal places");
    built({ created_after: "2026-11-12T09:30:00+02:00" });
    built({ created_after: "2026-11-12T09:30:00" });
  });

  it("refuses a detection window that ends before it starts", () => {
    assert.ok(errorsOf({ detected_after: "2026-11-10", detected_before: "2026-11-01" }).detected_after?.includes("later than"));
  });

  it("applies the API's own rules: ids are GUIDs, job countries are two letters, roles are two characters", () => {
    const errors = errorsOf({ company_ids: ["stripe.com"], job_countries: ["Germany"], roles: ["x"] });
    assert.ok(errors.company_ids?.includes("is not a company id"));
    assert.ok(errors.job_countries?.includes("two-letter"));
    assert.ok(errors.roles?.includes("at least 2 characters"));
  });

  it("refuses a company id that is not a GUID, before anything else", () => {
    assert.ok(errorsOf({ company_id: "stripe" }).company_id?.includes("GUID"));
    assert.ok(errorsOf({ company_id: 42 }).company_id?.includes("GUID"));
  });

  it("refuses every filter the per-company endpoint does not take, naming each", () => {
    const errors = errorsOf({ company_id: COMPANY, domains: ["stripe.com"], functions: ["Technology"], types: ["hiring_surge"] });
    assert.deepEqual(Object.keys(errors).sort(), ["domains", "functions"]);
    assert.ok(errors.domains?.includes("does not take `domains`; it takes only types, min_strength, detected_after, detected_before, created_after"));
    assert.ok(errors.functions?.includes("`company_ids`"));
  });
});

describe("build_signals_request: warnings and notes", () => {
  it("warns when nothing narrows the read", () => {
    assert.deepEqual(built({ min_strength: 90 }).warnings.map((warning) => warning.field), ["(request)"]);
    assert.ok(built({}).warnings[0]?.message.includes("every signal Jobo detects"));
    assert.deepEqual(built({ functions: ["Technology"] }).warnings, []);
  });

  it("warns on a domain or headquarters country it cannot read", () => {
    const warnings = built({ domains: ["https://stripe.com/"], countries: ["Germany"] }).warnings.map((warning) => warning.field);
    assert.deepEqual(warnings.sort(), ["countries", "domains"]);
  });

  it("explains the focus rule when a focus filter is set, and how to poll", () => {
    const focused = built({ functions: ["Technology"], job_regions: ["Texas"] }).notes ?? [];
    assert.ok(focused.some((note) => note.includes("Focus filters set (functions, job_regions)")));
    assert.ok(focused.some((note) => note.includes("minus five minutes")));
    assert.ok(focused.some((note) => note.includes("Do not retry")));
    assert.ok(!(built({ domains: ["stripe.com"] }).notes ?? []).some((note) => note.includes("Focus filters set")));
  });
});

describe("the parameters build_signals_request takes", () => {
  it("are the contract's filters, then company_id, limit and cursor", () => {
    assert.deepEqual(SIGNALS_REQUEST_PARAMETERS, [...HIRING_SIGNAL_FILTERS.map((filter) => filter.key), "company_id", "limit", "cursor"]);
  });
});

describe("build_signals_request's text", () => {
  it("prints the request, the commands, the cost and the notes, and says nothing was sent", () => {
    const text = renderSignalsBuildResult(buildSignalsRequest({ domains: ["stripe.com"], limit: 5 }));
    assert.ok(text.includes("Nothing was sent."));
    assert.ok(text.includes("GET https://connect.jobo.world/api/signals?domains=stripe.com&limit=5"));
    assert.ok(text.includes("curl -sS"));
    assert.ok(text.includes("```powershell\nInvoke-RestMethod -Method Get"));
    assert.ok(text.includes("jobo signals --domains stripe.com --max 5 --json"));
    assert.ok(text.includes("up to 5 signals"));
    assert.ok(text.includes("Notes:"));
  });

  it("prints the problems, and no request, when there are any", () => {
    const text = renderSignalsBuildResult(buildSignalsRequest({ types: ["nope"], limit: 500 }));
    assert.ok(text.startsWith("No request was built: 2 problems to fix first."));
    assert.ok(!text.includes("curl"));
    assert.ok(text.includes("`describe_signal_filters`"));
  });
});
