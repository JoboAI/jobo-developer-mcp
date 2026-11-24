/**
 * `build_signals_request`: check a set of Hiring Signals filters against the
 * contract and write out the `GET` request for them. Nothing here touches the
 * network, and nothing on this server ever sends a signals request: every
 * signal returned is billed, at ten times a job.
 *
 * Same two kinds of finding as `build_search_request`. An **error** breaks the
 * contract or a rule the API enforces (an unknown filter, a value outside a
 * fixed vocabulary, a list value with a comma, more than 100 values, a number
 * out of range, a date in the wrong shape, a filter the per-company endpoint
 * does not take): one error and no request is built. A **warning** is what
 * the API would accept but probably not mean.
 *
 * The query is built the way core's `toSignalsQuery` builds it (lists joined
 * with commas, `false` left out), so it is what `jobo signals` or the n8n node
 * would send for the same filters.
 */

import { API_KEY_ENV } from "./auth.js";
import { PUBLIC_API_URL } from "./contract.js";
import {
  API_KEY_HEADER_VALUE,
  canonical,
  nearest,
  parseTimestamp,
  powerShellQuote,
  shellQuote,
  type Finding,
} from "./request.js";
import {
  COMPANY_SIGNALS_PATH,
  COMPANY_SIGNAL_FILTER_KEYS,
  FOCUS_SIGNAL_FILTER_KEYS,
  HIRING_SIGNAL_FILTERS,
  NARROWING_SIGNAL_FILTER_KEYS,
  POLLING_RECIPE,
  SIGNALS_PATH,
  SIGNAL_DEFAULT_LIMIT,
  SIGNAL_MAX_LIMIT,
  SIGNAL_MAX_LIST_VALUES,
  signalFlagName,
  type SignalFilterDescriptor,
} from "./signals-contract.js";

export interface SignalsRequest {
  method: "GET";
  /** The full URL, query string included. */
  url: string;
  path: string;
  /** The query parameters, as sent. */
  query: Record<string, string | number | boolean>;
  headers: Record<string, string>;
}

export interface SignalsBuildResult {
  valid: boolean;
  errors: Finding[];
  warnings: Finding[];
  /** Always false: this tool writes the request and never sends it. */
  sent: false;
  request?: SignalsRequest;
  /** POSIX shell (bash, zsh). Reads the key from the `JOBO_API_KEY` environment variable. */
  curl?: string;
  /** Windows PowerShell 5.1 and PowerShell 7. Reads the key from the `JOBO_API_KEY` environment variable. */
  powershell?: string;
  /** The same read as a `jobo signals` command. */
  cli?: string;
  /** The most one call can bill, in signals. No price: it depends on the account. */
  billing?: { max_signals_billed: number; note: string };
  /** What to know before running it or writing code around it. */
  notes?: string[];
}

const FILTERS_BY_KEY: ReadonlyMap<string, SignalFilterDescriptor> = new Map(
  HIRING_SIGNAL_FILTERS.map((filter) => [filter.key, filter]),
);
const OPTION_KEYS = ["company_id", "limit", "cursor"] as const;

/** Every parameter `build_signals_request` takes: the contract's filters, then the request options. */
export const SIGNALS_REQUEST_PARAMETERS: readonly string[] = [...FILTERS_BY_KEY.keys(), ...OPTION_KEYS];

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
const COUNTRY = /^[a-z]{2}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/**
 * The instants the API reads (`HiringSignalsController.InstantFormats`): a date
 * and a time with seconds, up to seven decimal places, and an optional `Z` or
 * offset. A date alone is refused there, so it is refused here.
 */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})?$/;

/**
 * Names a model reaches for that are not signals filters, with the one meant.
 * Job-search names come first: they are the commonest slip on this endpoint.
 */
const MISNAMED: Readonly<Record<string, string>> = {
  type: "Unknown filter. Did you mean `types`? It takes an array.",
  company: "Unknown filter. Use `company_ids` (ids) or `domains` (website domains), or `company_id` for one company's endpoint.",
  companies: "Unknown filter. Use `company_ids` (ids) or `domains` (website domains).",
  q: "The signals API has no text query. `roles` looks for words in the job title or occupation behind a signal.",
  query: "The signals API has no text query. `roles` looks for words in the job title or occupation behind a signal.",
  location:
    "The signals API has no `location`. `countries` is where the company is headquartered; `job_countries`, `job_regions` and `job_cities` are where the jobs are.",
  page: "Signals are paged with `cursor` (the previous page's `next_cursor`), not page numbers.",
  page_size: "Unknown parameter. Did you mean `limit`?",
  size: "Unknown filter. Did you mean `company_sizes`?",
  created_before: "There is no `created_before`. `detected_before` bounds the detection day.",
};

function unknownParameter(key: string): string {
  const known = MISNAMED[key];
  if (known) return known;
  const guess = nearest(key, SIGNALS_REQUEST_PARAMETERS);
  return guess
    ? `Unknown filter. Did you mean \`${guess}\`?`
    : "Unknown filter. `describe_signal_filters` lists every filter this request takes.";
}

/** For a number sent as a string: the commonest wrong type, and worth a direct answer. */
function asNumberHint(value: unknown): string {
  return typeof value === "string" && /^\d+$/.test(value.trim()) ? ` Send it as a JSON number: ${value.trim()}, not "${value.trim()}".` : "";
}

const quoted = (values: readonly string[]): string => values.map((value) => `"${value}"`).join(", ");

interface Checked {
  query: Record<string, string | number | boolean>;
  errors: Finding[];
  warnings: Finding[];
}

function checkList(filter: SignalFilterDescriptor, value: unknown, out: Checked): void {
  const field = filter.key;
  const raw = typeof value === "string" ? [value] : value;
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
    out.errors.push({ field, message: "Takes an array of strings." });
    return;
  }
  const values: string[] = [];
  for (const entry of raw as string[]) {
    const text = entry.trim();
    if (text !== "" && !values.includes(text)) values.push(text);
  }
  if (values.length === 0) return;

  // The API splits every list on commas, so a value holding one would arrive as two.
  const withComma = values.filter((entry) => entry.includes(","));
  if (withComma.length > 0) {
    const split = withComma.flatMap((entry) => entry.split(",").map((part) => part.trim()).filter(Boolean));
    out.errors.push({
      field,
      message:
        `${quoted(withComma)} ${withComma.length > 1 ? "contain" : "contains"} a comma. The API separates values with commas, so a value cannot hold one. ` +
        `Pass each value as its own array entry, e.g. ${JSON.stringify(split)}.`,
    });
    return;
  }
  if (values.length > SIGNAL_MAX_LIST_VALUES) {
    out.errors.push({
      field,
      message: `Takes at most ${SIGNAL_MAX_LIST_VALUES} values; ${values.length} were given. Split them over several requests.`,
    });
    return;
  }

  let accepted = values;
  if (filter.options) {
    accepted = [];
    for (const entry of values) {
      const match = canonical(entry, filter.options);
      if (match === undefined) {
        const guess = nearest(entry, filter.options);
        out.errors.push({
          field,
          message: `Unknown value "${entry}".${guess ? ` Did you mean "${guess}"?` : ""} Valid values: ${filter.options.join(", ")}.`,
        });
      } else if (!accepted.includes(match)) {
        accepted.push(match);
      }
    }
  }

  // Rules the API enforces beyond the contract (HiringSignalsController).
  if (field === "company_ids") {
    const bad = accepted.filter((entry) => !GUID.test(entry));
    if (bad.length > 0) {
      out.errors.push({ field, message: `${quoted(bad)} ${bad.length > 1 ? "are not company ids" : "is not a company id"}: a company id is a GUID. Use \`domains\` for website domains, or \`find_companies\` to look the ids up.` });
    }
  } else if (field === "job_countries") {
    const bad = accepted.filter((entry) => !COUNTRY.test(entry));
    if (bad.length > 0) out.errors.push({ field, message: `${quoted(bad)}: takes two-letter country codes, e.g. "US", "DE".` });
    accepted = accepted.map((entry) => (COUNTRY.test(entry) ? entry.toUpperCase() : entry));
  } else if (field === "roles") {
    const short = accepted.filter((entry) => entry.length < 2);
    if (short.length > 0) out.errors.push({ field, message: `${quoted(short)} is too short to look for in a job title: at least 2 characters.` });
  } else if (field === "domains" || field === "exclude_domains") {
    const odd = accepted.filter((entry) => !DOMAIN.test(entry));
    if (odd.length > 0) {
      out.warnings.push({
        field,
        message: `${quoted(odd)} ${odd.length > 1 ? "do" : "does"} not look like a bare website domain ("stripe.com"). The API refuses a value it cannot read as a domain.`,
      });
    }
  } else if (field === "countries") {
    const odd = accepted.filter((entry) => !COUNTRY.test(entry));
    if (odd.length > 0) {
      out.warnings.push({ field, message: `${quoted(odd)}: headquarters countries are two-letter codes ("US", "DE"); anything else matches nothing.` });
    }
    accepted = accepted.map((entry) => (COUNTRY.test(entry) ? entry.toUpperCase() : entry));
  }

  out.query[field] = accepted.join(",");
}

function checkFilter(filter: SignalFilterDescriptor, value: unknown, out: Checked): void {
  const field = filter.key;
  switch (filter.kind) {
    case "stringList":
    case "enumList":
      checkList(filter, value, out);
      return;

    case "number": {
      const min = filter.min ?? 1;
      const max = filter.max ?? Number.MAX_SAFE_INTEGER;
      if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        out.errors.push({ field, message: `Takes a whole number from ${min} to ${max}.${asNumberHint(value)}` });
        return;
      }
      out.query[field] = value;
      return;
    }

    case "boolean": {
      if (typeof value !== "boolean") {
        out.errors.push({ field, message: "Takes true or false." });
        return;
      }
      // false is the API's default: leave it out, as core's `toSignalsQuery` does.
      if (value) out.query[field] = true;
      return;
    }

    case "date": {
      const text = typeof value === "string" ? value.trim() : "";
      if (!DAY.test(text)) {
        out.errors.push({ field, message: "Takes a day as yyyy-MM-dd, e.g. 2026-11-01, with no time." });
        return;
      }
      if ("problem" in parseTimestamp(text)) {
        out.errors.push({ field, message: `"${text}" is not a real date: check the day of the month.` });
        return;
      }
      out.query[field] = text;
      return;
    }

    case "dateTime": {
      const text = typeof value === "string" ? value.trim() : "";
      if (!INSTANT.test(text)) {
        out.errors.push({
          field,
          message:
            "Takes an ISO 8601 date and time with seconds, e.g. 2026-11-12T09:30:00Z (up to seven decimal places, Z or an offset such as +02:00). A date alone is refused by the API." +
            (field === "created_after" ? " Pass the newest `created_at` received, minus five minutes." : ""),
        });
        return;
      }
      // parseTimestamp reads to the millisecond; the regex above has checked the shape of the rest.
      const parsed = parseTimestamp(text.replace(/(\.\d{3})\d+/, "$1"));
      if ("problem" in parsed) {
        out.errors.push({ field, message: `"${text}" is not a real date or time: check the day of the month, the hour and the offset.` });
        return;
      }
      out.query[field] = text;
      return;
    }

    default: {
      // A kind added to the contract has to be handled here before it can ship.
      const unhandled: never = filter.kind;
      throw new Error(`Unhandled filter kind: ${String(unhandled)}`);
    }
  }
}

/** One query string, keys in contract order, values percent-encoded. */
export function queryString(query: Record<string, string | number | boolean>): string {
  return Object.entries(query)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

export function toSignalsCurl(url: string): string {
  return [`curl -sS ${shellQuote(url)}`, `  -H "X-Api-Key: $${API_KEY_ENV}"`].join(" \\\n");
}

export function toSignalsPowerShell(url: string): string {
  return [
    `Invoke-RestMethod -Method Get -Uri ${powerShellQuote(url)}`,
    `  -Headers @{ 'X-Api-Key' = $env:${API_KEY_ENV} }`,
  ].join(" `\n");
}

/** `--flag value`, or `--flag=value` when the value would be read as another flag. */
function flagArg(flag: string, value: string): string {
  return value.length > 1 && value.startsWith("-") ? `--${flag}=${shellQuote(value)}` : `--${flag} ${shellQuote(value)}`;
}

/**
 * The same read as `jobo signals`. `--max` is the request's `limit`: the CLI
 * pages until it has read that many, and with one page asked for that is one
 * request.
 */
export function toSignalsCliCommand(
  query: Record<string, string | number | boolean>,
  companyId: string | undefined,
  limit: number,
): string {
  const words = ["jobo", "signals"];
  if (companyId) words.push(`--company-id ${companyId}`);
  for (const filter of HIRING_SIGNAL_FILTERS) {
    const value = query[filter.key];
    if (value === undefined) continue;
    const flag = signalFlagName(filter.key);
    words.push(value === true ? `--${flag}` : flagArg(flag, String(value)));
  }
  words.push(`--max ${limit}`);
  if (typeof query.cursor === "string") words.push(flagArg("cursor", query.cursor));
  words.push("--json");
  return words.join(" ");
}

export function buildSignalsRequest(input: Record<string, unknown>): SignalsBuildResult {
  const out: Checked = { query: {}, errors: [], warnings: [] };

  // null is how some clients spell "not set".
  const given = (name: string): unknown => input[name] ?? undefined;

  // ── The endpoint ───────────────────────────────────────────────────────────
  let companyId: string | undefined;
  const rawCompany = given("company_id");
  if (rawCompany !== undefined) {
    if (typeof rawCompany !== "string" || !GUID.test(rawCompany.trim())) {
      out.errors.push({
        field: "company_id",
        message:
          "Takes one Jobo company id, a GUID (e.g. 6c1f0a9e-3b7d-4c55-8e21-5a4d9f0b7c33). Look it up with `find_companies`; " +
          "for companies by website domain, use `domains` on the list endpoint instead.",
      });
    } else {
      companyId = rawCompany.trim().toLowerCase();
    }
  }
  const perCompany = rawCompany !== undefined;

  // ── The filters ────────────────────────────────────────────────────────────
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (!FILTERS_BY_KEY.has(key) && !(OPTION_KEYS as readonly string[]).includes(key)) {
      out.errors.push({ field: key, message: unknownParameter(key) });
    }
  }
  // In the contract's order, so the same filters always make the same URL.
  for (const filter of HIRING_SIGNAL_FILTERS) {
    const key = filter.key;
    const value = given(key);
    if (value === undefined) continue;
    if (perCompany && !filter.company) {
      out.errors.push({
        field: key,
        message:
          `\`GET ${COMPANY_SIGNALS_PATH}\` does not take \`${key}\`; it takes only ${COMPANY_SIGNAL_FILTER_KEYS.join(", ")}, ` +
          "and ignores anything else without an error. To combine one company with this filter, leave out `company_id` " +
          "and pass the id in `company_ids` on `GET /api/signals`.",
      });
      continue;
    }
    checkFilter(filter, value, out);
  }

  const after = out.query.detected_after;
  const before = out.query.detected_before;
  if (typeof after === "string" && typeof before === "string" && after > before) {
    out.errors.push({ field: "detected_after", message: "Is later than detected_before, so no signal can match." });
  }

  // ── Paging ─────────────────────────────────────────────────────────────────
  const limit = given("limit");
  if (limit !== undefined) {
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > SIGNAL_MAX_LIMIT) {
      out.errors.push({ field: "limit", message: `Takes a whole number from 1 to ${SIGNAL_MAX_LIMIT}.${asNumberHint(limit)}` });
    } else {
      out.query.limit = limit;
    }
  }
  const cursor = given("cursor");
  if (cursor !== undefined) {
    if (typeof cursor !== "string" || cursor.trim() === "") {
      out.errors.push({ field: "cursor", message: "Takes the previous page's `next_cursor`, a string, unchanged." });
    } else {
      out.query.cursor = cursor.trim();
    }
  }

  if (out.errors.length > 0) {
    return { valid: false, errors: out.errors, warnings: out.warnings, sent: false };
  }

  // ── Warnings and notes ─────────────────────────────────────────────────────
  const notes: string[] = [];
  if (!perCompany && !NARROWING_SIGNAL_FILTER_KEYS.some((key) => out.query[key] !== undefined)) {
    out.warnings.push({
      field: "(request)",
      message:
        `No narrowing filter (${NARROWING_SIGNAL_FILTER_KEYS.join(", ")}): this reads every signal Jobo detects, each ` +
        "one billed. Fine for one small page while testing; never poll or page through it.",
    });
  }
  const focus = FOCUS_SIGNAL_FILTER_KEYS.filter((key) => out.query[key] !== undefined);
  if (focus.length > 0) {
    notes.push(
      `Focus filters set (${focus.join(", ")}): a signal is returned when it agrees with every focus filter its type ` +
        "carries and its type carries at least one of them. Types that carry none (hiring_slowdown) never come back; " +
        "read them with a second request without focus filters.",
    );
  }
  if (out.query.cursor !== undefined) {
    notes.push("Keep every filter the same as on the request that returned this cursor: the API reads the cursor against them.");
  }
  if (out.query.created_after === undefined) {
    notes.push(POLLING_RECIPE);
  } else {
    notes.push(
      "`created_after` is exclusive and compares all seven decimal places of `created_at`. For the next poll, store the " +
        "newest `created_at` received, pass it minus five minutes, and skip ids already held: the overlap is billed again.",
    );
  }
  notes.push(
    "Do not retry this request after a timeout, a dropped connection or a 500: the page may already have been billed. " +
      "A 429 or a 503 with Retry-After is safe to send again after the wait.",
  );
  notes.push("Read an unknown `type` like any other instead of failing on it: more types may be added.");

  const effectiveLimit = typeof out.query.limit === "number" ? out.query.limit : SIGNAL_DEFAULT_LIMIT;
  const path = companyId ? COMPANY_SIGNALS_PATH.replace("{id}", companyId) : SIGNALS_PATH;
  const search = queryString(out.query);
  const url = `${PUBLIC_API_URL}${path}${search ? `?${search}` : ""}`;

  return {
    valid: true,
    errors: [],
    warnings: out.warnings,
    sent: false,
    request: {
      method: "GET",
      url,
      path,
      query: out.query,
      headers: { "X-Api-Key": API_KEY_HEADER_VALUE },
    },
    curl: toSignalsCurl(url),
    powershell: toSignalsPowerShell(url),
    cli: toSignalsCliCommand(out.query, companyId, effectiveLimit),
    billing: {
      max_signals_billed: effectiveLimit,
      note:
        `Sending this request is billed per signal returned, up to ${effectiveLimit} signals (its limit), at ten times ` +
        "the price of a job on the account's pricing. The plan's included signals are used first, then the wallet; the " +
        "Unlimited plan has no per-signal charge. A request that returns nothing is free, and a signal read again is " +
        "billed again. A sandbox key (jbe_test_…) cannot read signals.",
    },
    notes,
  };
}
