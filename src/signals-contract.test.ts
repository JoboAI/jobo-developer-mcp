import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { renderSignalFilterContract } from "./format.js";
import {
  COMPANY_SIGNAL_FILTER_KEYS,
  FOCUS_SIGNAL_FILTER_KEYS,
  HIRING_SIGNAL_FILTERS,
  SIGNAL_DEFAULT_LIMIT,
  SIGNAL_DEFAULT_SORT,
  SIGNAL_MAX_LIMIT,
  SIGNAL_MAX_LIST_VALUES,
  SIGNAL_POLL_SORT,
  SIGNAL_SENIORITY,
  SIGNAL_SORTS,
  SIGNAL_SORT_ORDERS,
  SIGNAL_TYPES,
  SIGNAL_TYPE_LABELS,
  describeSignalFilters,
} from "./signals-contract.js";

const contract = describeSignalFilters();

describe("describe_signal_filters", () => {
  it("describes every filter, in order, with a label, a description and a CLI flag", () => {
    assert.deepEqual(
      contract.filters.map((filter) => filter.name),
      HIRING_SIGNAL_FILTERS.map((filter) => filter.key),
    );
    for (const filter of contract.filters) {
      assert.ok(filter.label.length > 0 && filter.description.length > 0, filter.name);
      assert.equal(filter.cli_flag, `--${filter.name.replace(/_/g, "-")}`);
    }
  });

  it("says which filters the per-company endpoint takes", () => {
    assert.deepEqual(COMPANY_SIGNAL_FILTER_KEYS, ["types", "min_strength", "detected_after", "detected_before", "created_after"]);
    assert.equal(contract.endpoints.company.path, "/api/companies/{id}/signals");
    assert.equal(contract.filters.find((filter) => filter.name === "domains")?.per_company, false);
    assert.equal(contract.filters.find((filter) => filter.name === "types")?.per_company, true);
  });

  it("marks the nine focus filters and states the rule they are read by", () => {
    assert.deepEqual(FOCUS_SIGNAL_FILTER_KEYS, [
      "functions",
      "roles",
      "seniority",
      "technologies",
      "skills",
      "technology_categories",
      "job_countries",
      "job_regions",
      "job_cities",
    ]);
    assert.ok(contract.focus_rule.includes("agrees with every focus filter its type carries"));
    assert.ok(contract.focus_rule.includes("carries at least one of the focus filters you set"));
  });

  it("states paging, the cost and the polling recipe", () => {
    assert.deepEqual(contract.paging.limit, { min: 1, max: 200, default: 50 });
    assert.ok(contract.paging.rule.includes("newest detection day first"));
    assert.ok(contract.billing.includes("ten times the price of a job"));
    assert.ok(contract.billing.includes("A signal read again is billed again"));
    assert.ok(contract.billing.includes("X-Quota-Remaining"));
    assert.ok(!/\$\d|\d credits/.test(contract.billing), `a fixed price is baked in: ${contract.billing}`);
    assert.ok(contract.polling.includes("sort=created_asc&created_after=<that value>&limit=<n>"));
    assert.ok(contract.polling.includes("as the string the API sent"));
    assert.ok(contract.polling.includes("No overlap, no seen-id list"));
    assert.ok(contract.polling.includes("continue now with `cursor` and the same `sort`"));
    assert.ok(contract.polling.includes("Start the first poll from a time"));
    assert.ok(contract.polling.includes("before 2026-11-24"));
    assert.ok(!/five minutes|skip any|overlap is billed/.test(contract.polling), `the old overlap recipe: ${contract.polling}`);
    // The old overlap recipe was 650 characters; an agent reads this in a tool result.
    assert.ok(contract.polling.length <= 760, `the recipe grew to ${contract.polling.length} characters`);
    assert.ok(contract.notes.some((note) => note.includes("account_key_required") && note.includes("not_available_in_sandbox")));
    assert.ok(contract.notes.some((note) => note.includes("unknown `type`")));
  });

  it("describes sort beside limit and cursor: both orders, the default, the one to poll in", () => {
    assert.deepEqual(contract.paging.sort.values, ["detected_desc", "created_asc"]);
    assert.equal(contract.paging.sort.default, "detected_desc");
    assert.equal(contract.paging.sort.poll, "created_asc");
    assert.ok(contract.paging.sort.orders.detected_desc.includes("Newest detection day first"));
    assert.ok(contract.paging.sort.orders.created_asc.includes("oldest first"));
    assert.ok(contract.paging.cursor.includes("belongs to the sort it was issued under"));
    assert.ok(contract.paging.rule.includes("400 naming `sort`"));
    assert.ok(contract.paging.rule.includes("400 naming `cursor`"));
    const text = renderSignalFilterContract(contract);
    assert.ok(text.includes("- sort=detected_desc (default): Newest detection day first"), text);
    assert.ok(text.includes("- sort=created_asc (poll in this): The order signals were stored in"), text);
  });

  it("labels every type", () => {
    assert.deepEqual(contract.types.map((entry) => entry.type), [...SIGNAL_TYPES]);
    for (const entry of contract.types) assert.notEqual(entry.label, entry.type, entry.type);
  });

  it("prints every filter, the per-company list and the cost", () => {
    const text = renderSignalFilterContract(contract);
    for (const filter of contract.filters) assert.ok(text.includes(`### ${filter.name}\n`), filter.name);
    assert.ok(text.includes("# Hiring Signals filters: GET https://connect.jobo.world/api/signals"));
    assert.ok(text.includes("taking only types, min_strength, detected_after, detected_before, created_after"));
    assert.ok(text.includes("- values: junior, mid, senior, director, vp, c_level, executive"));
    assert.ok(text.includes("- range: 1 to 100"));
    assert.ok(text.includes("## Reading only what is new"));
  });
});

// The embedded copy against the contract generated from connector-core. Skipped
// when the file is absent: a Docker build carries only this directory.
describe("the embedded signals contract against the repo contract", () => {
  it("matches contracts/signals.json", (t) => {
    const contractPath = join(import.meta.dirname, "..", "..", "contracts", "signals.json");
    if (!existsSync(contractPath)) {
      t.skip("contracts/signals.json not present (Docker build)");
      return;
    }
    const repo = JSON.parse(readFileSync(contractPath, "utf8")) as {
      enums: Record<string, string[]>;
      type_labels: Record<string, string>;
      limits: { default_limit: number; max_limit: number; max_list_values: number };
      sort: { values: string[]; default: string; poll: string };
      filters: Array<{ key: string; kind: string; options?: string[]; narrowing?: boolean; company?: boolean; min?: number; max?: number }>;
      company_filter_keys: string[];
    };
    const drift = "the embedded copy in src/signals-contract.ts differs from contracts/signals.json — update it from connector-core";

    assert.deepEqual([...SIGNAL_TYPES], repo.enums.signal_types, drift);
    assert.deepEqual([...SIGNAL_SENIORITY], repo.enums.seniority, drift);
    assert.deepEqual({ ...SIGNAL_TYPE_LABELS }, repo.type_labels, drift);
    assert.deepEqual(
      { default_limit: SIGNAL_DEFAULT_LIMIT, max_limit: SIGNAL_MAX_LIMIT, max_list_values: SIGNAL_MAX_LIST_VALUES },
      repo.limits,
      drift,
    );
    assert.deepEqual(
      { values: [...SIGNAL_SORTS], default: SIGNAL_DEFAULT_SORT, poll: SIGNAL_POLL_SORT },
      repo.sort,
      drift,
    );
    assert.deepEqual(Object.keys(SIGNAL_SORT_ORDERS), repo.sort.values, drift);
    assert.deepEqual([...COMPANY_SIGNAL_FILTER_KEYS], repo.company_filter_keys, drift);
    assert.deepEqual(
      HIRING_SIGNAL_FILTERS.map((filter) => ({
        key: filter.key,
        kind: filter.kind,
        ...(filter.options ? { options: [...filter.options] } : {}),
        ...(filter.narrowing ? { narrowing: true } : {}),
        ...(filter.company ? { company: true } : {}),
        ...(filter.min !== undefined ? { min: filter.min } : {}),
        ...(filter.max !== undefined ? { max: filter.max } : {}),
      })),
      repo.filters,
      drift,
    );
  });
});
