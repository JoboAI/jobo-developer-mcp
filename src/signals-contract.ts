/**
 * The Hiring Signals filter contract, read for a developer.
 *
 * The search contract (`contract.ts`) is imported from `@jobo-ai/connector-core`.
 * The signals one cannot be yet: the pinned core (0.5.0) has no signals, and
 * they arrive in core 0.7.0. Until that is on npm this module holds a copy of
 * `HIRING_SIGNAL_FILTERS` and `SIGNAL_TYPE_LABELS` (core's `signals.ts` and
 * `signal-summary.ts`), with the same labels and descriptions, and can become an
 * import once the pin moves. `signals-contract.test.ts` holds the copy to
 * `contracts/signals.json`, the file generated from core, and fails when the
 * two drift apart.
 *
 * No network and no API key: `describe_signal_filters` and
 * `build_signals_request` answer from this alone. Nothing on this server calls
 * a signals endpoint: every signal returned is billed.
 */

import { COMPANY_SIZES } from "@jobo-ai/connector-core";

import { BILLING_DOCS_URL, PUBLIC_API_URL } from "./contract.js";

export const SIGNALS_PATH = "/api/signals";
/** The per-company endpoint; `{id}` is a Jobo company id (a GUID). */
export const COMPANY_SIGNALS_PATH = "/api/companies/{id}/signals";

/** The public guide: the focus table per type, alerts, pricing. */
export const SIGNALS_GUIDE_URL = "https://jobo.world/docs/guides/hiring-signals";

/** `type` values, in the API's own order. More may be added: ignore one you do not know. */
export const SIGNAL_TYPES = [
  "hiring_surge",
  "new_function",
  "new_country",
  "leadership_hire",
  "new_skill",
  "hiring_slowdown",
  "first_role",
  "new_technology",
  "function_surge",
  "new_city",
  "hard_to_fill",
  "leadership_role_closed",
  "hiring_freeze",
  "hiring_resumed",
] as const;

/** `seniority` values, lowest first. */
export const SIGNAL_SENIORITY = ["junior", "mid", "senior", "director", "vp", "c_level", "executive"] as const;

/** Signals per page: `limit` runs from 1 to this, and defaults to 50. */
export const SIGNAL_MAX_LIMIT = 200;
export const SIGNAL_DEFAULT_LIMIT = 50;

/** The most values one comma-separated filter takes. */
export const SIGNAL_MAX_LIST_VALUES = 100;

/** A short name for each signal type, as Jobo's dashboard shows it. */
export const SIGNAL_TYPE_LABELS: Readonly<Record<string, string>> = {
  hiring_surge: "Hiring surge",
  new_function: "New function",
  new_country: "New country",
  leadership_hire: "Leadership hire",
  new_skill: "New skill",
  hiring_slowdown: "Hiring slowdown",
  first_role: "First role",
  new_technology: "New technology",
  function_surge: "Function surge",
  new_city: "New city",
  hard_to_fill: "Hard to fill",
  leadership_role_closed: "Leadership role closed",
  hiring_freeze: "Hiring freeze",
  hiring_resumed: "Hiring resumed",
};

/** `date` is a calendar day (`yyyy-MM-dd`); `dateTime` is an instant. */
export type SignalFilterKind = "stringList" | "enumList" | "number" | "boolean" | "date" | "dateTime";

export interface SignalFilterDescriptor {
  /** The query parameter name on `GET /api/signals`. */
  key: string;
  label: string;
  kind: SignalFilterKind;
  description: string;
  /** Present for `enumList`. */
  options?: readonly string[];
  /** True when the filter says which companies or which subjects are wanted. */
  narrowing?: boolean;
  /** True when `GET /api/companies/{id}/signals` takes it too. */
  company?: boolean;
  /** True for the filters that say what a signal must be about (see `FOCUS_RULE`). */
  focus?: boolean;
  /** Lowest and highest value the API accepts, for `number`. */
  min?: number;
  max?: number;
}

export const HIRING_SIGNAL_FILTERS: readonly SignalFilterDescriptor[] = [
  {
    key: "types",
    label: "Signal Types",
    kind: "enumList",
    description: "Only these kinds of signal, e.g. hiring_surge, new_country, leadership_hire. Leave empty for every kind.",
    options: SIGNAL_TYPES,
    narrowing: true,
    company: true,
  },
  {
    key: "domains",
    label: "Company Domains",
    kind: "stringList",
    description: 'Only signals at these companies, by website domain, e.g. "stripe.com". At most 100.',
    narrowing: true,
  },
  {
    key: "company_ids",
    label: "Company IDs",
    kind: "stringList",
    description: "Only signals at these companies, by Jobo company id (a GUID). At most 100.",
    narrowing: true,
  },
  {
    key: "exclude_domains",
    label: "Exclude Company Domains",
    kind: "stringList",
    description: "Leave out these companies, by website domain, e.g. your existing customers. At most 100.",
  },
  {
    key: "countries",
    label: "Company Countries",
    kind: "stringList",
    description: 'Countries the companies are headquartered in, as two-letter codes, e.g. "US", "DE".',
    narrowing: true,
  },
  {
    key: "company_sizes",
    label: "Company Sizes",
    kind: "enumList",
    description: "Headcount bands of the companies.",
    options: COMPANY_SIZES,
    narrowing: true,
  },
  {
    key: "industries",
    label: "Industries",
    kind: "stringList",
    description:
      "Industries of the companies, matched against the primary industry and the industry list. A value cannot contain a comma.",
    narrowing: true,
  },
  {
    key: "categories",
    label: "Company Categories",
    kind: "stringList",
    description: "Company categories, as returned in company.categories, e.g. SaaS.",
    narrowing: true,
  },
  {
    key: "funding_stages",
    label: "Funding Stages",
    kind: "stringList",
    description: 'Latest funding round of the companies, as returned in company.funding_stage, e.g. "Seed", "Series A".',
    narrowing: true,
  },
  {
    key: "founded_after",
    label: "Founded In or After",
    kind: "number",
    description: "Only companies founded in this year or later.",
    min: 1800,
    max: 2100,
  },
  {
    key: "exclude_agencies",
    label: "Exclude Staffing Agencies",
    kind: "boolean",
    description: "Leave out staffing agencies, whose postings are their clients' hiring.",
  },
  {
    key: "functions",
    label: "Functions",
    kind: "stringList",
    description: 'Job categories the signal must be about, e.g. "Technology", "Sales". A focus filter.',
    narrowing: true,
    focus: true,
  },
  {
    key: "roles",
    label: "Roles",
    kind: "stringList",
    description:
      'Words or phrases to look for in the job title or occupation behind the signal, e.g. "data engineer". At least 2 characters each. A focus filter.',
    narrowing: true,
    focus: true,
  },
  {
    key: "seniority",
    label: "Seniority",
    kind: "enumList",
    description: "Seniority of the role behind the signal. A focus filter.",
    options: SIGNAL_SENIORITY,
    narrowing: true,
    focus: true,
  },
  {
    key: "technologies",
    label: "Technologies",
    kind: "stringList",
    description: 'Named tools the signal must be about, e.g. "Snowflake". A focus filter, combined with skills and technology categories.',
    narrowing: true,
    focus: true,
  },
  {
    key: "skills",
    label: "Skills",
    kind: "stringList",
    description: "Named skills the signal must be about. A focus filter, combined with technologies.",
    narrowing: true,
    focus: true,
  },
  {
    key: "technology_categories",
    label: "Technology Categories",
    kind: "stringList",
    description: 'Every tool in a category, as returned in details.technology_category, e.g. "CRM". A focus filter.',
    narrowing: true,
    focus: true,
  },
  {
    key: "job_countries",
    label: "Job Countries",
    kind: "stringList",
    description: "Countries the jobs are in (not the company's headquarters), as two-letter codes. A focus filter.",
    narrowing: true,
    focus: true,
  },
  {
    key: "job_regions",
    label: "Job Regions",
    kind: "stringList",
    description: 'States, provinces or regions the jobs are in, e.g. "Texas". A focus filter.',
    narrowing: true,
    focus: true,
  },
  {
    key: "job_cities",
    label: "Job Cities",
    kind: "stringList",
    description: 'Cities the jobs are in, e.g. "Austin". A focus filter; only new_city and hard_to_fill record a city.',
    narrowing: true,
    focus: true,
  },
  {
    key: "min_strength",
    label: "Minimum Strength",
    kind: "number",
    description: "Only signals at least this strong. Strength runs from 1 to 100 and compares signals of the same type.",
    min: 1,
    max: 100,
    company: true,
  },
  {
    key: "min_new_jobs",
    label: "Minimum New Jobs",
    kind: "number",
    description: "Only hiring_surge and function_surge signals of at least this many new jobs. Other types are not affected.",
    min: 1,
    max: 10_000,
  },
  {
    key: "min_days_open",
    label: "Minimum Days Open",
    kind: "number",
    description: "Only hard_to_fill signals for jobs open at least this many days. Other types are not affected.",
    min: 1,
    max: 365,
  },
  {
    key: "reposted_only",
    label: "Reposted Jobs Only",
    kind: "boolean",
    description: "Only hard_to_fill signals for jobs posted again after closing. Other types are not affected.",
  },
  {
    key: "detected_after",
    label: "Detected On or After",
    kind: "date",
    description: "Earliest detection day, inclusive, as yyyy-MM-dd.",
    company: true,
  },
  {
    key: "detected_before",
    label: "Detected On or Before",
    kind: "date",
    description: "Latest detection day, inclusive, as yyyy-MM-dd.",
    company: true,
  },
  {
    key: "created_after",
    label: "Created After",
    kind: "dateTime",
    description:
      "Only signals first stored after this instant, exclusive. To read what is new, pass the newest created_at already received.",
    company: true,
  },
];

/** Keys `GET /api/companies/{id}/signals` takes; the company is in the path. */
export const COMPANY_SIGNAL_FILTER_KEYS: readonly string[] = HIRING_SIGNAL_FILTERS.filter((filter) => filter.company).map(
  (filter) => filter.key,
);

/** Keys that count as narrowing: at least one belongs on anything that polls. */
export const NARROWING_SIGNAL_FILTER_KEYS: readonly string[] = HIRING_SIGNAL_FILTERS.filter((filter) => filter.narrowing).map(
  (filter) => filter.key,
);

/** The focus filters: what a signal must be about. */
export const FOCUS_SIGNAL_FILTER_KEYS: readonly string[] = HIRING_SIGNAL_FILTERS.filter((filter) => filter.focus).map(
  (filter) => filter.key,
);

// ─────────────────────────────────────────────────────────────────────────────
//  The rules a request is read by, in words
// ─────────────────────────────────────────────────────────────────────────────

/** The focus rule (HiringSignalsController remarks; the guide has the table per type). */
export const FOCUS_RULE =
  `The focus filters (${FOCUS_SIGNAL_FILTER_KEYS.join(", ")}) say what a signal must be about. Not every type says ` +
  "everything: a surge names functions but no city, a new city names a place, a slowdown names nothing. A signal is " +
  "returned when it agrees with every focus filter its type carries, and its type carries at least one of the focus " +
  "filters you set. So a request with a focus filter never returns a type that carries none of them (hiring_slowdown " +
  "carries none at all): read company-wide types with a second request without focus filters. Each signal's `focus` " +
  `object shows what it carries. The table of which type carries which is at ${SIGNALS_GUIDE_URL}.`;

/** What a signal read costs. No price: it is ten times the account's own per-job rate. */
export const SIGNALS_BILLING =
  "Billed per signal returned, at ten times the price of a job on the account's pricing (the published rate is at " +
  `${BILLING_DOCS_URL}). A plan's included signals are used first, then the wallet; the Unlimited plan has no ` +
  "per-signal charge, within the rate limits. A request that returns nothing is free. A signal read again is billed " +
  "again. Response headers: `X-Credits-Deducted`, `X-Credits-Balance`, and `X-Quota-Limit` / `X-Quota-Remaining` " +
  "(the plan's included signals this month). 402 when included signals and wallet cannot cover the page: nothing is " +
  "charged or returned.";

/** How to read only what is new without paying for much twice. */
export const POLLING_RECIPE =
  "To read only new signals: store the newest `created_at` received; on the next read pass `created_after` = that " +
  "value minus five minutes (signals being stored while the last read ran), page with `cursor` until `has_more` is " +
  "false, and skip any `id` already held. `created_after` is exclusive and compares all seven decimal places of " +
  "`created_at`, so store it as the API sent it. The signals inside the five-minute overlap are billed again, so keep " +
  "the overlap at five minutes and do not page from the top on every poll. Keep the filters the same between polls, " +
  "and set at least one narrowing filter: without one a poll reads every signal Jobo detects.";

export const PAGING_RULE =
  `\`limit\` is 1 to ${SIGNAL_MAX_LIMIT} signals per page (default ${SIGNAL_DEFAULT_LIMIT}) and is the most one request ` +
  "can bill. Pass the previous page's `next_cursor` as `cursor`, with the filters unchanged, until `has_more` is false. " +
  "Pages run newest detection day first, not in the order signals were stored, so a cursor walk is not a way to poll: " +
  "use `created_after`.";

// ─────────────────────────────────────────────────────────────────────────────
//  describe_signal_filters
// ─────────────────────────────────────────────────────────────────────────────

/** How a value of each kind is written when passed to `build_signals_request`. */
const VALUE_SHAPE: Readonly<Record<SignalFilterKind, string>> = {
  stringList: "array of strings (sent comma-separated)",
  enumList: "array of strings (sent comma-separated)",
  number: "integer",
  boolean: "boolean",
  date: "date, yyyy-MM-dd",
  dateTime: "ISO 8601 date and time with seconds, e.g. 2026-11-12T09:30:00Z",
};

export const signalFlagName = (key: string): string => key.replace(/_/g, "-");

export interface SignalFilterDescription {
  /** The query parameter, and the parameter `build_signals_request` takes. */
  name: string;
  label: string;
  type: SignalFilterKind;
  /** How to write the value. */
  value: string;
  description: string;
  /** The values it accepts, for a fixed vocabulary. */
  values?: readonly string[];
  min?: number;
  max?: number;
  narrowing: boolean;
  /** A focus filter: see `focus_rule`. */
  focus: boolean;
  /** True when `GET /api/companies/{id}/signals` takes it too. */
  per_company: boolean;
  /** The matching `jobo signals` flag. */
  cli_flag: string;
}

export function describeSignalFilter(filter: SignalFilterDescriptor): SignalFilterDescription {
  return {
    name: filter.key,
    label: filter.label,
    type: filter.kind,
    value: VALUE_SHAPE[filter.kind],
    description: filter.description,
    ...(filter.options ? { values: filter.options } : {}),
    ...(filter.min !== undefined ? { min: filter.min } : {}),
    ...(filter.max !== undefined ? { max: filter.max } : {}),
    narrowing: filter.narrowing === true,
    focus: filter.focus === true,
    per_company: filter.company === true,
    cli_flag: `--${signalFlagName(filter.key)}`,
  };
}

export interface SignalEndpoint {
  method: "GET";
  url: string;
  path: string;
  /** The filters it takes; the rest are refused by `build_signals_request` and ignored by the API. */
  takes: readonly string[] | "every filter";
}

export interface SignalFilterContract {
  endpoints: { list: SignalEndpoint; company: SignalEndpoint };
  auth_header: "X-Api-Key";
  filters: SignalFilterDescription[];
  types: { type: string; label: string }[];
  paging: { limit: { min: 1; max: number; default: number }; cursor: string; rule: string };
  limits: { max_list_values: number };
  focus_rule: string;
  billing: string;
  polling: string;
  notes: string[];
}

/** The whole contract, as `describe_signal_filters` returns it. */
export function describeSignalFilters(): SignalFilterContract {
  return {
    endpoints: {
      list: { method: "GET", url: `${PUBLIC_API_URL}${SIGNALS_PATH}`, path: SIGNALS_PATH, takes: "every filter" },
      company: {
        method: "GET",
        url: `${PUBLIC_API_URL}${COMPANY_SIGNALS_PATH}`,
        path: COMPANY_SIGNALS_PATH,
        takes: COMPANY_SIGNAL_FILTER_KEYS,
      },
    },
    auth_header: "X-Api-Key",
    filters: HIRING_SIGNAL_FILTERS.map(describeSignalFilter),
    types: SIGNAL_TYPES.map((type) => ({ type, label: SIGNAL_TYPE_LABELS[type] ?? type })),
    paging: {
      limit: { min: 1, max: SIGNAL_MAX_LIMIT, default: SIGNAL_DEFAULT_LIMIT },
      cursor: "The previous page's `next_cursor`, unchanged.",
      rule: PAGING_RULE,
    },
    limits: { max_list_values: SIGNAL_MAX_LIST_VALUES },
    focus_rule: FOCUS_RULE,
    billing: SIGNALS_BILLING,
    polling: POLLING_RECIPE,
    notes: [
      "A signal is one event at one company, detected from its job postings: a hiring surge, a first job in a country, " +
        "a leadership search, a new technology, a slowdown.",
      "Every filter is optional and they combine with AND. A list filter is sent comma-separated and matches any of " +
        `its values; a value cannot contain a comma, and a list takes at most ${SIGNAL_MAX_LIST_VALUES} values.`,
      "The per-company endpoint takes the company id (a GUID) in the path and only " +
        `${COMPANY_SIGNAL_FILTER_KEYS.join(", ")}. The API ignores any other parameter there without an error, so ` +
        "`build_signals_request` refuses one. To combine one company with other filters, use `company_ids` on " +
        "`GET /api/signals`.",
      "`types`, `seniority` and `company_sizes` take fixed values. The other lists are open: functions, industries " +
        "and categories match the values returned on signals (`focus.functions`, `company.industry`, " +
        "`company.categories`); an unknown value matches nothing rather than failing.",
      "More types may be added. Read an unknown `type` like any other (its `focus` and `company` keep their shape) " +
        "instead of failing on it.",
      "Each signal: id, type, detected_on (yyyy-MM-dd), created_at, window_start, window_end, strength (1 to 100, " +
        "comparable within one type), company { id, name, domain, country_code, size, industry, industries, " +
        "categories, is_agency, funding_stage?, founded_year? }, details (differs by type), focus { functions, title?, " +
        "occupation?, seniority?, topics, topic_category?, job_countries, job_regions, job_cities } and " +
        "evidence_job_ids (up to five; each is free to read with `GET /api/jobs/{id}`).",
      "Errors: 400 for a bad filter (the body names it), 402 when the page cannot be paid for, 403 with code " +
        "`account_key_required` for a key that belongs to no account, 404 `not_available_in_sandbox` for a sandbox " +
        "key (jbe_test_…), and 429 over the rate limit (without a subscription: 20 a minute, 200 an hour, 1,000 a " +
        "day). Never retry a request whose answer was lost (a timeout, a dropped connection, a 500): it may have " +
        "been billed.",
    ],
  };
}
