/**
 * The job-search filter contract, read for a developer.
 *
 * Everything here is derived from `@jobo-ai/connector-core` (pinned exactly in
 * `package.json`): the filters, their fixed vocabularies and, by running the
 * contract's own `toJobSearchBody` on one filter at a time, where each filter
 * lands in the `POST /api/jobs/search` body. A filter added to the contract
 * shows up in `describe_search_filters` and `build_search_request` with no code
 * change here; `contract.test.ts` fails if one cannot be placed in the body.
 *
 * No network and no API key: this is the part of the server that answers
 * without either.
 */

import {
  COMPANY_REVENUES,
  COMPANY_SIZES,
  DEFAULT_BASE_URL,
  INCLUDE_FIELDS,
  JOB_SEARCH_FILTERS,
  LANGUAGES,
  toJobSearchBody,
  type FilterDescriptor,
  type FilterKind,
  type FilterOptionsFacet,
  type JobSearchFilters,
} from "@jobo-ai/connector-core";

/** The public REST API. Not `JOBO_API_URL`: that is where this server calls, which may be an internal address. */
export const PUBLIC_API_URL = DEFAULT_BASE_URL;
export const SEARCH_PATH = "/api/jobs/search";

// Paging limits of POST /api/jobs/search (JobsController: DefaultPageSize, MaxPageSize).
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
/**
 * Search serves results to this depth (page × page_size) and clamps a deeper
 * page to the last one (`SearchModuleConfiguration.MaxOffset`); the feed is the
 * tool beyond it. A server setting, so `build_search_request` only warns.
 */
export const MAX_SEARCH_DEPTH = 100_000;

/**
 * Facet names `include_facets` takes (the JobsController remarks). Not part of
 * the shared contract, so `build_search_request` warns on a name outside this
 * list instead of refusing it.
 */
export const SEARCH_FACETS = [
  "work_model",
  "experience_level",
  "employment_type",
  "sources",
  "industries",
  "skills",
  "countries",
  "company_categories",
  "job_categories",
  "job_subcategories",
  "occupations",
] as const;

// What the billed calls cost, as `jobo-cli` states it. 1,000 credits = $1.00.
export const SEARCH_CREDITS_PER_JOB = 3;
export const CREDITS_PER_DOLLAR = 1000;
export const BILLING_DOCS_URL = "https://jobo.world/docs/billing";

export const BILLING_SUMMARY =
  "Job search (`GET /api/jobs`, `POST /api/jobs/search`) is billed per job returned: $3.00 per 1,000 jobs " +
  "(3 credits each) after the plan's included jobs; an empty page is free. The feed (`POST /api/jobs/feed`) is " +
  "billed at the same rate per job that is new to the account. Geocoding (`GET /api/locations/geocode`) is " +
  `$0.001 per lookup. Lookups by id and the filter, company, location and occupation lookups are free. See ${BILLING_DOCS_URL}.`;

// ─────────────────────────────────────────────────────────────────────────────
//  Lookups
// ─────────────────────────────────────────────────────────────────────────────

const isFacet = (source: FilterDescriptor["dynamicOptions"]): source is FilterOptionsFacet =>
  source !== undefined && source !== "companies";

/** Facets `find_filter_values` serves: every open vocabulary the contract names, bar companies. */
export const FILTER_VALUE_FACETS: readonly FilterOptionsFacet[] = [
  ...new Set(JOB_SEARCH_FILTERS.map((filter) => filter.dynamicOptions).filter(isFacet)),
];

/** The filters a facet's values go into, e.g. `occupations` → `occupation_ids`, `exclude_occupation_ids`. */
export function filtersFedBy(facet: FilterOptionsFacet): string[] {
  return JOB_SEARCH_FILTERS.filter((filter) => filter.dynamicOptions === facet).map((filter) => filter.key);
}

export interface FilterLookup {
  /** The tool on this server that supplies or lists the filter's values. */
  tool: "find_companies" | "find_filter_values" | "find_locations" | "list_filters";
  arguments?: { facet: FilterOptionsFacet };
}

/** Where a filter's values come from, when they are not free text, a number or a date. */
export function lookupFor(filter: FilterDescriptor): FilterLookup | undefined {
  if (filter.dynamicOptions === "companies") return { tool: "find_companies" };
  if (isFacet(filter.dynamicOptions)) return { tool: "find_filter_values", arguments: { facet: filter.dynamicOptions } };
  if (filter.key === "location") return { tool: "find_locations" };
  if (filter.options) return { tool: "list_filters" };
  return undefined;
}

/**
 * Whether a filter's `options` are every value it takes. They are not when the
 * values are also served live (`dynamicOptions`: the set churns) or for
 * `language`, where the list is a picker and any ISO 639-1 code is accepted.
 */
export function hasClosedVocabulary(filter: FilterDescriptor): boolean {
  return filter.options !== undefined && filter.dynamicOptions === undefined && filter.key !== "language";
}

// ─────────────────────────────────────────────────────────────────────────────
//  Where a filter goes in the request body
// ─────────────────────────────────────────────────────────────────────────────

const EXAMPLE_TEXT: Readonly<Record<string, string>> = {
  q: "data engineer",
  location: "Berlin, Germany",
};

/** One realistic value per open vocabulary, taken from the contract's own descriptions. */
const EXAMPLE_OPEN_VALUE: Readonly<Record<string, string>> = {
  sources: "greenhouse",
  companies: "stripe.com",
  skills: "Python",
  industries: "Software Development",
  job_categories: "Healthcare",
  job_subcategories: "Nursing",
  occupations: "jobo:backend-developer",
};

/** Values to try for a filter, most representative first. */
function exampleCandidates(filter: FilterDescriptor): unknown[] {
  switch (filter.kind) {
    case "string":
      return [EXAMPLE_TEXT[filter.key] ?? "text"];
    case "number":
      return [100000];
    case "boolean":
      return [false, true];
    case "dateTime":
      return ["2026-01-01T00:00:00Z"];
    case "enum":
      // Last first: the first option is usually the default, which is not sent.
      return [...(filter.options ?? [])].reverse();
    case "stringList":
    case "enumList":
      return [[filter.options?.[0] ?? EXAMPLE_OPEN_VALUE[filter.dynamicOptions ?? ""] ?? "value"]];
    default: {
      // A kind added to the contract has to be handled here before it can ship.
      const unhandled: never = filter.kind;
      throw new Error(`Unhandled filter kind: ${String(unhandled)}`);
    }
  }
}

/** `skills.exclude` for `{ skills: { exclude: [...] } }`, `queries` for `{ queries: [...] }`. */
function bodyPath(fragment: Record<string, unknown>): string | undefined {
  const top = Object.keys(fragment)[0];
  if (top === undefined) return undefined;
  const value = fragment[top];
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const inner = Object.keys(value)[0];
    return inner === undefined ? top : `${top}.${inner}`;
  }
  return top;
}

/**
 * The body a single filter produces, found by handing the contract's own
 * mapper one filter. Null when no value of the filter reaches the body, which
 * means the installed contract and its mapper disagree.
 */
function placeInBody(filter: FilterDescriptor): { field: string; example: Record<string, unknown> } | null {
  for (const candidate of exampleCandidates(filter)) {
    const fragment = toJobSearchBody({ [filter.key]: candidate } as JobSearchFilters) as Record<string, unknown>;
    const field = bodyPath(fragment);
    if (field !== undefined) return { field, example: fragment };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  describe_search_filters
// ─────────────────────────────────────────────────────────────────────────────

/** How a value of each kind is written when passed to `build_search_request`. */
const VALUE_SHAPE: Readonly<Record<FilterKind, string>> = {
  string: "string",
  number: "integer",
  boolean: "boolean",
  dateTime: "ISO 8601 date or date-time string",
  stringList: "array of strings",
  enumList: "array of strings",
  enum: "string",
};

export const flagName = (key: string): string => key.replace(/_/g, "-");

export interface FilterDescription {
  /** The filter's name in the contract: the parameter `build_search_request` takes. */
  name: string;
  label: string;
  type: FilterKind;
  /** How to write the value. */
  value: string;
  description: string;
  /** The values it accepts, when the contract lists them. */
  values?: readonly string[];
  /** False when `values` is a picker list and other values are accepted too. */
  values_exhaustive?: boolean;
  /** The tool that supplies or lists valid values. */
  lookup?: FilterLookup;
  /** The filter that excludes the same values (on an include filter). */
  exclude_twin?: string;
  /** The filter this one is the exclude half of (on an `exclude_` filter). */
  excludes?: string;
  /** True when the filter meaningfully narrows the result set. */
  narrowing: boolean;
  /** Where the value goes in the `POST /api/jobs/search` JSON body. */
  body_field: string | null;
  /** A body holding just this filter. */
  body_example: Record<string, unknown> | null;
  /** The matching `jobo search` flag. */
  cli_flag: string;
}

/** A request field that is not a filter: paging and what comes back. */
export interface RequestOptionDescription {
  name: string;
  value: string;
  description: string;
  values?: readonly string[];
  body_field: string;
  cli_flag: string;
}

export const REQUEST_OPTIONS: readonly RequestOptionDescription[] = [
  {
    name: "page",
    value: "integer",
    description: "1-based page number. Default 1.",
    body_field: "page",
    cli_flag: "--page",
  },
  {
    name: "page_size",
    value: "integer",
    description:
      `Jobs per page, 1–${MAX_PAGE_SIZE}. API default ${DEFAULT_PAGE_SIZE}. Every job returned is billed, so this ` +
      "is the most one request can cost; keep it small while testing.",
    body_field: "page_size",
    cli_flag: "--page-size",
  },
  {
    name: "include_fields",
    value: "array of strings",
    description:
      "Heavy job fields to return. Omitted: all of them. An empty array: the core fields only, which keeps " +
      "responses small. The price is the same either way.",
    values: INCLUDE_FIELDS,
    body_field: "include_fields",
    cli_flag: "--include-fields",
  },
  {
    name: "include_facets",
    value: "array of strings",
    description:
      "Facet counts to return alongside the jobs. Omitted: the API's default set (work_model, experience_level, " +
      "employment_type, sources). An empty array: none. It is a list of facet names, not a boolean.",
    values: SEARCH_FACETS,
    body_field: "include_facets",
    cli_flag: "--facets",
  },
];

const FILTER_KEYS: ReadonlySet<string> = new Set(JOB_SEARCH_FILTERS.map((filter) => filter.key));

export function describeFilter(filter: FilterDescriptor): FilterDescription {
  const placed = placeInBody(filter);
  const lookup = lookupFor(filter);
  const twin = `exclude_${filter.key}`;
  const included = filter.key.startsWith("exclude_") ? filter.key.slice("exclude_".length) : undefined;
  return {
    name: filter.key,
    label: filter.label,
    type: filter.kind,
    value: filter.key === "location" ? "string (or an array of strings for several places)" : VALUE_SHAPE[filter.kind],
    description: filter.description,
    ...(filter.options ? { values: filter.options, values_exhaustive: hasClosedVocabulary(filter) } : {}),
    ...(lookup ? { lookup } : {}),
    ...(FILTER_KEYS.has(twin) ? { exclude_twin: twin } : {}),
    ...(included !== undefined && FILTER_KEYS.has(included) ? { excludes: included } : {}),
    narrowing: filter.narrowing === true,
    body_field: placed?.field ?? null,
    body_example: placed?.example ?? null,
    cli_flag: `--${flagName(filter.key)}`,
  };
}

export interface FilterContract {
  endpoint: { method: "POST"; url: string; path: string; auth_header: "X-Api-Key"; billed: string };
  filters: FilterDescription[];
  request_options: readonly RequestOptionDescription[];
  notes: string[];
}

/** The whole contract, as `describe_search_filters` returns it. */
export function describeSearchFilters(): FilterContract {
  return {
    endpoint: {
      method: "POST",
      url: `${PUBLIC_API_URL}${SEARCH_PATH}`,
      path: SEARCH_PATH,
      auth_header: "X-Api-Key",
      billed: "per job returned",
    },
    filters: JOB_SEARCH_FILTERS.map(describeFilter),
    request_options: REQUEST_OPTIONS,
    notes: [
      "Filter names are the shared connector contract's. In the POST body several are spelled differently: the " +
        "body field given for each filter is the truth, and `build_search_request` does the mapping.",
      "Include/exclude filters are nested objects in the body ({ \"skills\": { \"include\": [...], \"exclude\": [...] } }). " +
        "The API ignores a flat key such as `skills_exclude` without failing.",
      "Values are matched exactly: a value the index does not hold returns zero jobs, not an error. Look values " +
        "up with the tool named for the filter.",
      "Fixed values are lowercase on the way in (`remote`, `full-time`). A job comes back with display-cased " +
        "values (`Remote`, `Full-time`), which are not valid filter input.",
      "List filters match any of their values; different filters are combined with AND.",
      "The body's `queries` and `locations` are arrays: several queries are OR'd (prefix one with - to exclude " +
        "it), and a job in any of the locations matches.",
      "`GET /api/jobs` takes the same include filters as query parameters, but not `companies` and none of the " +
        "`exclude_` filters. Use POST for those.",
      "Salary filters only match jobs whose employer published a range, a minority of listings.",
      "For incremental sync, page a fixed `discovered_after`/`discovered_before` window with " +
        "`sort: discovered_asc`: that order is stable while jobs are updated. Relevance order can shift between pages.",
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  list_filters
// ─────────────────────────────────────────────────────────────────────────────

export interface Vocabulary {
  /** The filter (or request option) the values go into. */
  filter: string;
  /** Where they go in the `POST /api/jobs/search` body. */
  body_field: string | null;
  values: readonly string[];
  /** False when other values are accepted too. */
  exhaustive: boolean;
  /** English names, for `language` only. */
  names?: Record<string, string>;
  note?: string;
}

export interface FixedVocabularies {
  search: Vocabulary[];
  /** Vocabularies only `POST /api/jobs/feed` takes. */
  feed_only: Vocabulary[];
  /** Filters whose values are looked up live instead. */
  open: { filter: string; lookup: FilterLookup }[];
  notes: string[];
}

const VOCABULARY_NOTES: Readonly<Record<string, string>> = {
  language:
    "ISO 639-1 codes. The list holds the languages the index has in volume; any ISO 639-1 code is accepted, " +
    "and names or locales (\"German\", \"en-US\") are mapped server-side.",
  company_categories:
    "`find_filter_values` with facet company_categories returns the same values with live job counts.",
  sort: "`relevance` is the default. The `discovered_*` orders key on the first-indexed time and keep pages stable.",
  description_format: "`markdown` is the default. `enhanced` and `enhanced_html` are beta.",
};

/** The fixed vocabularies, as `list_filters` returns them. */
export function fixedVocabularies(): FixedVocabularies {
  const search: Vocabulary[] = [];
  for (const filter of JOB_SEARCH_FILTERS) {
    // An exclude_ filter takes its twin's values; listing them twice adds nothing.
    if (!filter.options || filter.key.startsWith("exclude_")) continue;
    const note = VOCABULARY_NOTES[filter.key];
    search.push({
      filter: filter.key,
      body_field: placeInBody(filter)?.field ?? null,
      values: filter.options,
      exhaustive: hasClosedVocabulary(filter),
      ...(filter.key === "language"
        ? { names: Object.fromEntries(LANGUAGES.map((language) => [language.code, language.name])) }
        : {}),
      ...(note ? { note } : {}),
    });
  }
  search.push({
    filter: "include_fields",
    body_field: "include_fields",
    values: INCLUDE_FIELDS,
    exhaustive: true,
    note: "A request option, not a filter: the heavy job fields to return.",
  });

  return {
    search,
    feed_only: [
      { filter: "company_sizes", body_field: "company_sizes", values: COMPANY_SIZES, exhaustive: true, note: "Headcount bands." },
      {
        filter: "company_revenues",
        body_field: "company_revenues",
        values: COMPANY_REVENUES,
        exhaustive: true,
        note: "Annual revenue bands, in US dollars.",
      },
    ],
    open: JOB_SEARCH_FILTERS.flatMap((filter) => {
      const lookup = lookupFor(filter);
      return lookup && lookup.tool !== "list_filters" && !filter.key.startsWith("exclude_")
        ? [{ filter: filter.key, lookup }]
        : [];
    }),
    notes: [
      "Send these values exactly as written: lowercase, with the hyphens. Jobs come back with display-cased " +
        "values (`Remote`, `Full-time`), which are not valid filter input.",
      "An `exclude_` filter takes the same values as the filter it excludes.",
      "The feed (`POST /api/jobs/feed`) spells the enum filters in the plural (`work_models`, `employment_types`, " +
        "`experience_levels`, `languages`) with the same values.",
    ],
  };
}
