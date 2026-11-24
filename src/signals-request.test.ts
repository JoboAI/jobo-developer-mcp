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

  it("puts sort=created_asc in the URL and leaves the default out, on both endpoints", () => {
    const at = "2026-11-24T13:53:55.837281Z";
    const poll = built({ domains: ["stripe.com"], sort: "created_asc", created_after: at, limit: 20 });
    assert.equal(
      poll.request.url,
      "https://connect.jobo.world/api/signals?domains=stripe.com&created_after=2026-11-24T13%3A53%3A55.837281Z&sort=created_asc&limit=20",
    );
    assert.equal(poll.request.query.created_after, at, "created_after is sent as given, every digit");
    assert.equal(built({ domains: ["stripe.com"], sort: "Created_Asc" }).request.query.sort, "created_asc");

    const company = built({ company_id: COMPANY, sort: "created_asc", created_after: at });
    assert.equal(
      company.request.url,
      `https://connect.jobo.world/api/companies/${COMPANY}/signals?created_after=2026-11-24T13%3A53%3A55.837281Z&sort=created_asc`,
    );

    const browse = built({ domains: ["stripe.com"], sort: "detected_desc" });
    assert.equal(browse.request.url, "https://connect.jobo.world/api/signals?domains=stripe.com");
    assert.equal(browse.request.query.sort, undefined);
    assert.equal(built({ company_id: COMPANY, sort: "detected_desc" }).request.url, `https://connect.jobo.world/api/companies/${COMPANY}/signals`);
  });

  it("writes the jobo command with --sort for the stored order, and without it for the default", () => {
    const poll = built({ domains: ["stripe.com"], sort: "created_asc", created_after: "2026-11-24T13:53:55.837281Z", limit: 20 });
    // The value goes into the command as given, every digit: the CLI sends an instant as typed.
    assert.equal(
      poll.cli,
      "jobo signals --domains stripe.com --created-after 2026-11-24T13:53:55.837281Z --sort created_asc --max 20 --json",
    );
    assert.ok(renderSignalsBuildResult(poll).includes("--sort created_asc --max 20 --json"));

    const company = built({ company_id: COMPANY, sort: "created_asc", created_after: "2026-11-24T13:53:55.837281Z" });
    assert.ok(company.cli?.includes(`--company-id ${COMPANY}`));
    assert.ok(company.cli?.includes("--sort created_asc"));

    assert.equal(built({ domains: ["stripe.com"], sort: "detected_desc" }).cli, "jobo signals --domains stripe.com --max 50 --json");
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

  it("refuses a sort that is neither order, with the nearest one", () => {
    const errors = errorsOf({ domains: ["stripe.com"], sort: "created_ascending" });
    assert.ok(errors.sort?.includes('Unknown value "created_ascending".'), errors.sort);
    assert.ok(errors.sort?.includes("Valid values: detected_desc, created_asc."), errors.sort);
    assert.ok(errorsOf({ sort: "creatd_asc" }).sort?.includes('Did you mean "created_asc"?'));
    assert.ok(errorsOf({ sort: "newest" }).sort?.includes("400 naming `sort`"));
    assert.ok(errorsOf({ sort: 1 }).sort?.includes("Takes a string."));
    assert.ok(errorsOf({ company_id: COMPANY, sort: "oldest" }).sort, "the per-company endpoint checks it too");
    assert.ok(errorsOf({ order: "created_asc" }).order?.includes("`sort`"));
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
    assert.ok(focused.some((note) => note.includes("sort=created_asc&created_after=<that value>&limit=<n>")));
    assert.ok(focused.some((note) => note.includes("Do not retry")));
    assert.ok(!(built({ domains: ["stripe.com"] }).notes ?? []).some((note) => note.includes("Focus filters set")));
  });

  it("never gives the old overlap advice", () => {
    for (const input of [
      { domains: ["stripe.com"] },
      { domains: ["stripe.com"], created_after: "2026-11-24T13:53:55.837281Z" },
      { domains: ["stripe.com"], sort: "created_asc", created_after: "2026-11-24T13:53:55.837281Z" },
      { domains: ["stripe.com"], sort: "created_asc" },
    ]) {
      const text = renderSignalsBuildResult(buildSignalsRequest(input));
      assert.ok(!/five minutes|skip ids|skip any|overlap is billed/.test(text), `${JSON.stringify(input)}: ${text}`);
    }
    assert.ok(!/five minutes/.test(errorsOf({ created_after: "yesterday" }).created_after ?? ""));
  });

  it("warns on created_after without the stored order, and names the fix", () => {
    const result = built({ domains: ["stripe.com"], created_after: "2026-11-24T13:53:55.837281Z" });
    const warning = result.warnings.find((entry) => entry.field === "created_after");
    assert.ok(warning?.message.includes("cannot be resumed from a timestamp"), warning?.message);
    assert.ok(warning?.message.includes('add `sort: "created_asc"`'), warning?.message);
    assert.ok(
      built({ domains: ["stripe.com"], sort: "detected_desc", created_after: "2026-11-24T13:53:55Z" }).warnings.some(
        (entry) => entry.field === "created_after",
      ),
      "an explicit default order is warned on too",
    );
    assert.ok(built({ company_id: COMPANY, created_after: "2026-11-24T13:53:55Z" }).warnings.some((entry) => entry.field === "created_after"));
  });

  it("warns on the stored order with neither created_after nor cursor: it starts at the oldest signal", () => {
    const result = built({ domains: ["stripe.com"], sort: "created_asc" });
    assert.deepEqual(result.warnings.map((entry) => entry.field), ["sort"]);
    assert.ok(result.warnings[0]?.message.includes("starts at the oldest signal"));
    assert.ok(result.warnings[0]?.message.includes("bills each one"));
    assert.deepEqual(built({ domains: ["stripe.com"], sort: "created_asc", cursor: "abc" }).warnings, [], "a cursor carries the position");
  });

  it("gives no ordering warning to a correct poll, and tells it how to continue", () => {
    const result = built({ domains: ["stripe.com"], sort: "created_asc", created_after: "2026-11-24T13:53:55.837281Z" });
    assert.deepEqual(result.warnings, []);
    const notes = result.notes ?? [];
    assert.ok(notes.some((note) => note.includes("as the string the API sent") && note.includes("`cursor` = `next_cursor`")));
    assert.ok(notes.some((note) => note.includes("2026-11-24")));
    // Precision of created_after cannot be told from the value: a value with no fraction is not warned on.
    assert.deepEqual(built({ domains: ["stripe.com"], sort: "created_asc", created_after: "2026-11-24T13:53:55Z" }).warnings, []);
  });

  it("says a cursor belongs to its sort", () => {
    const notes = built({ domains: ["stripe.com"], sort: "created_asc", created_after: "2026-11-24T13:53:55Z", cursor: "abc" }).notes ?? [];
    assert.ok(notes.some((note) => note.includes("Keep `sort` and every filter the same") && note.includes("400 naming `cursor`")));
  });
});

describe("the parameters build_signals_request takes", () => {
  it("are the contract's filters, then company_id, sort, limit and cursor", () => {
    assert.deepEqual(SIGNALS_REQUEST_PARAMETERS, [
      ...HIRING_SIGNAL_FILTERS.map((filter) => filter.key),
      "company_id",
      "sort",
      "limit",
      "cursor",
    ]);
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
